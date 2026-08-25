/**
 * WhatsApp 通道（FR-CHAN-002 / §9 后续阶段项）。
 *
 * 复用 @whiskeysockets/baileys 官方生态库连接 WhatsApp Web 多设备协议，
 * 不自建 WebSocket 协议栈。与 Telegram 通道的差异集中在平台细节：
 *
 * 1) 登录走二维码扫码，凭据由 useMultiFileAuthState 持久化到 authDir，
 *    重启后免扫码；首次登录时二维码以文本形式打到日志（qr_log 控制）；
 * 2) 断线后按指数退避自动重连（reconnectInitialMs 起、reconnectMaxMs 封顶），
 *    用户主动登出（loggedOut）不重连，避免无限循环；
 * 3) 平台会重放离线期间的消息，必须按消息 id 去重，否则同一条指令会被执行两次；
 * 4) 群聊 JID 以 @g.us 结尾，私聊以 @s.whatsapp.net 结尾。
 *
 * socket 工厂可注入：生产路径走 makeWASocket + fetchLatestBaileysVersion，
 * 测试路径注入假 socket 以避免任何真实网络连接。
 *
 * 日期：2026-08-25  执行者：Codex
 */

import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  AnyMessageContent,
  ConnectionState,
  WASocket,
  WAMessage,
} from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import type { Logger as PinoLikeLogger } from 'pino';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ChannelDispatcher, describeError } from './dispatcher.js';
import { extractMention, stripWakeWord } from './command-parser.js';
import { OutboundSender } from './outbound.js';
import type { Channel, ChannelAttachments, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { AttachmentKind } from '../domain/index.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../config/index.js';

/** socket 工厂签名：生产实现由默认值提供，测试注入桩。 */
export type SocketFactory = (authDir: string) => Promise<WASocket>;

/** WhatsApp 通道依赖。 */
export interface WhatsAppChannelOptions {
  host: ChannelHost;
  channels: ResolvedChannels;
  limits: ResolvedLimits;
  paths: ResolvedPaths;
  /** 日志回调；不注入则静默 */
  log?: (line: string) => void;
  /** 测试注入用 socket 工厂；缺省走真实 Baileys 连接 */
  socketFactory?: SocketFactory;
}

/**
 * 静默 logger。
 *
 * Baileys 要求传入 pino 兼容的 logger，但内部日志量极大且对用户没有价值；
 * 这里给一个满足类型面的空实现，错误统一由本类自己的 log 输出。
 */
function silentLogger(): PinoLikeLogger {
  const noop = (): void => undefined;
  const logger = {
    level: 'silent',
    child: silentLogger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  return logger as unknown as PinoLikeLogger;
}

/** 待下载附件规格。kind 直接对齐 domain 的 AttachmentKind。 */
interface WaAttachmentSpec {
  kind: AttachmentKind;
  message: proto.Message['imageMessage'] | proto.Message['documentMessage'] | proto.Message['audioMessage'];
  mediaType: 'image' | 'document' | 'audio';
  name: string;
}

/**
 * WhatsApp 通道实现。
 *
 * 归一化只做三件事：解析 mention、收集附件描述、构造回写目标。
 * 具体任务执行完全交给 ChannelDispatcher，命令分派/串行队列/流式节流
 * 与 Telegram/HTTP/CLI 完全一致。
 */
export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp' as const;

  private readonly options: WhatsAppChannelOptions;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private readonly charLimit: number;
  /** 已处理的入站消息 id，防平台离线重放导致重复执行 */
  private readonly seenMessageIds = new Set<string>();
  /** 生产路径下持有 saveCreds 引用，供 creds.update 触发持久化 */
  private persistCreds: (() => Promise<void>) | undefined;

  private sock: WASocket | undefined;
  private started = false;
  private stoppedByUser = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** 当前退避间隔；连接成功后重置为初值 */
  private backoffMs: number | undefined;

  constructor(options: WhatsAppChannelOptions) {
    this.options = options;
    this.charLimit = options.channels.whatsapp.messageCharLimit;
    this.sender = new OutboundSender(options.paths.spoolDir);
    this.dispatcher = new ChannelDispatcher({
      host: options.host,
      sender: this.sender,
      messageCharLimit: this.charLimit,
      editIntervalMs: options.channels.editIntervalMs,
      asyncThresholdMs: options.channels.asyncThresholdMs,
      queueCapacity: options.limits.ingressQueueSize,
    });
  }

  /** 启动：先重投上次残留的出站缓冲，再建立连接。 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stoppedByUser = false;
    await this.flushSpool();
    await this.connect();
  }

  /**
   * 建立 Baileys socket 并注册事件处理器。
   *
   * 生产路径：useMultiFileAuthState 落盘凭据 → fetchLatestBaileysVersion 对齐
   * 服务端版本号 → makeWASocket 建连。每次重连都会重建整个 socket 对象。
   */
  private async connect(): Promise<void> {
    if (this.options.socketFactory !== undefined) {
      this.sock = await this.options.socketFactory(this.authDir());
    } else {
      const waConfig = this.options.channels.whatsapp;
      mkdirSync(waConfig.authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(waConfig.authDir);
      const { version } = await fetchLatestBaileysVersion();
      this.persistCreds = saveCreds;
      this.sock = makeWASocket({
        version,
        browser: ['Hermes', 'Chrome', '1.0.0'],
        auth: state,
        logger: silentLogger(),
        markOnlineOnConnect: true,
        syncFullHistory: false,
      });
    }
    this.registerEvents();
  }

  /** 注册事件监听。每次 connect 后调用一次，旧 socket 随 GC 回收。 */
  private registerEvents(): void {
    const sock = this.sock;
    if (sock === undefined) {
      return;
    }
    sock.ev.on('creds.update', () => {
      void this.persistCreds?.();
    });
    sock.ev.on('connection.update', (update) => {
      void this.onConnectionUpdate(update).catch((error) =>
        this.log('WhatsApp 连接状态处理失败：' + describeError(error)),
      );
    });
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        void this.ingest(msg).catch((error) =>
          this.log('WhatsApp 入站消息处理失败：' + describeError(error)),
        );
      }
    });
  }

  /**
   * 连接状态变化。
   *
   * open：记录日志并重置退避；qr：首次登录时把二维码打到日志；
   * close：判断是否重连。loggedOut 是用户主动登出，不自动连回，
   * 否则每次重启都会弹二维码。
   */
  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const wa = this.options.channels.whatsapp;
    if (update.qr !== undefined && wa.qrLog) {
      this.log('WhatsApp 扫码登录：请在终端查看二维码或用手机扫描以下字符串对应的二维码');
      this.log('QR: ' + update.qr);
    }
    if (update.connection === 'open') {
      this.backoffMs = undefined;
      const userJid = (this.sock as { user?: { id?: string } } | undefined)?.user?.id ?? 'unknown';
      this.log('WhatsApp 已连接：' + userJid);
      return;
    }
    if (update.connection !== 'close') {
      return;
    }
    if (this.stoppedByUser) {
      return;
    }
    const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
      ?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      this.log('WhatsApp 已登出。删除 ' + wa.authDir + ' 后重启可重新扫码登录。');
      return;
    }
    // 指数退避重连
    const initial = wa.reconnectInitialMs;
    const max = wa.reconnectMaxMs;
    const current = this.backoffMs ?? initial;
    const next = Math.min(current * 2, max);
    this.backoffMs = next;
    this.log('WhatsApp 连接断开（code=' + String(statusCode ?? '?') + '），' + String(current) + 'ms 后重连…');
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) =>
        this.log('WhatsApp 重连失败：' + describeError(error)),
      );
    }, current);
  }

  /**
   * 把一条平台消息归一并入队。
   *
   * 去重 → fromMe 过滤 → 群聊唤起词门禁 → mention 解析 → 构造回写目标 → 入队。
   */
  private async ingest(msg: WAMessage): Promise<void> {
    const id = msg.key.id ?? '';
    if (id.length > 0) {
      if (this.seenMessageIds.has(id)) {
        return;
      }
      this.seenMessageIds.add(id);
    }
    if (msg.key.fromMe === true) {
      return;
    }
    const jid = msg.key.remoteJid ?? undefined;
    if (jid === undefined || jid.length === 0) {
      return;
    }
    const isGroup = jid.endsWith('@g.us');
    const raw = this.extractText(msg);
    const known = this.options.host.agentIds();
    const wa = this.options.channels.whatsapp;
    let body = raw;
    if (isGroup) {
      const wake = stripWakeWord(raw, wa.mentionPatterns, known);
      if (!wake.wake) {
        return;
      }
      body = wake.text;
    } else {
      // 私聊也剥一遍，避免 @hap 被当正文送进模型
      body = stripWakeWord(raw, wa.mentionPatterns, known).text;
    }
    const mention = extractMention(body, known);
    const message: InboundMessage = {
      channel: 'whatsapp',
      sessionKey: 'whatsapp:' + jid,
      text: mention.text,
      receivedAt: new Date().toISOString(),
      target: this.target(jid),
    };
    if (mention.agentId !== undefined) {
      message.agentId = mention.agentId;
    }
    if (wa.defaultAgent !== undefined) {
      message.defaultAgent = wa.defaultAgent;
    }
    try {
      const attachments = await this.downloadAttachments(msg, jid, id);
      if (attachments.length > 0) {
        message.attachments = attachments;
      }
    } catch (error) {
      this.log('WhatsApp 附件下载失败：' + describeError(error));
    }
    this.dispatcher.submit(message);
  }

  /**
   * 从 WAMessage 提取正文文本。
   *
   * conversation 是纯文本；extendedTextMessage 带 caption 或链接预览；
   * 图片/视频/文档/语音的 caption 分别在对应子结构里。ephemeral/viewOnce
   * 由 Baileys 的 normalizeMessageContent 统一解包后再取值。
   */
  private extractText(msg: WAMessage): string {
    const content = msg.message;
    if (content === undefined || content === null) {
      return '';
    }
    const normalized = normalizeMessageContent(content);
    const conversation = normalized?.conversation;
    if (conversation !== undefined && conversation !== null) {
      return conversation;
    }
    const parts = [
      normalized?.extendedTextMessage?.text,
      normalized?.imageMessage?.caption,
      normalized?.videoMessage?.caption,
      normalized?.documentMessage?.caption,
    ];
    for (const part of parts) {
      if (part !== undefined && part !== null && part.length > 0) {
        return part;
      }
    }
    return '';
  }

  /**
   */
  private async downloadAttachments(msg: WAMessage, jid: string, msgId: string): Promise<ChannelAttachments> {
    const content = msg.message;
    if (content === undefined || content === null) {
      return [];
    }
    const normalized = normalizeMessageContent(content);
    if (normalized === undefined) {
      return [];
    }
    const specs = this.describeAttachments(normalized);
    if (specs.length === 0) {
      return [];
    }
    const dir = join(this.options.paths.dataDir, 'inbox', jid.replace(/[^A-Za-z0-9@.]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const items: ChannelAttachments = [];
    for (const spec of specs) {
      try {
        const stream = await downloadContentFromMessage(spec.message as NonNullable<typeof spec.message>, spec.mediaType);
        const chunks: Buffer[] = [];
        for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const local = join(dir, msgId.slice(-16) + '-' + spec.name);
        writeFileSync(local, bytes);
        items.push({ kind: spec.kind, path: local, fileName: spec.name, bytes: bytes.byteLength });
      } catch (error) {
        this.log('WhatsApp 附件下载失败：' + spec.name + ' → ' + describeError(error));
      }
    }
    return items;
  }

  /** 识别一条归一化消息里可下载的附件。 */
  private describeAttachments(content: proto.IMessage): WaAttachmentSpec[] {
    const specs: WaAttachmentSpec[] = [];
    const image = content.imageMessage;
    if (image !== undefined && image !== null) {
      specs.push({ kind: 'image', message: image, mediaType: 'image', name: 'photo.jpg' });
    }
    const doc = content.documentMessage;
    if (doc !== undefined && doc !== null) {
      specs.push({
        kind: 'document',
        message: doc,
        mediaType: 'document',
        name: doc.fileName ?? 'document.bin',
      });
    }
    const audio = content.audioMessage;
    if (audio !== undefined && audio !== null) {
      specs.push({
        kind: 'audio',
        message: audio,
        mediaType: 'audio',
        name: 'voice.ogg',
      });
    }
    return specs;
  }

  /**
   * 构造回写目标。
   *
   * WhatsApp 不支持就地编辑已发送的消息，因此不实现 edit()；
   * ChannelDispatcher 会自动退化为只在终态发一条。
   */
  private target(jid: string): OutboundTarget {
    return {
      channel: 'whatsapp',
      targetId: jid,
      send: async (text: string) => {
        const sock = this.sock;
        if (sock === undefined) {
          throw new Error('WhatsApp 连接尚未建立');
        }
        const sent = await sock.sendMessage(jid, { text });
        return sent?.key.id ?? undefined;
      },
    };
  }

  /** 重投上次进程残留的出站缓冲。 */
  private async flushSpool(): Promise<void> {
    const sent = await this.sender.flush('whatsapp', (targetId) => this.target(targetId), this.charLimit);
    if (sent > 0) {
      this.log('WhatsApp 已重投 ' + String(sent) + ' 条缓冲消息');
    }
  }

  /**
   * 停机：清退避定时器、标记用户主动停机（阻止重连）、断开 socket。
   * 不调 logout()：那会把凭据从服务端吊销，用户下次还得重新扫码。
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.stoppedByUser = true;
    this.clearReconnectTimer();
    await this.dispatcher.drain();
    const sock = this.sock;
    if (sock !== undefined) {
      try {
        sock.end(undefined);
      } catch {
        // 断开失败不影响停机流程
      }
      this.sock = undefined;
    }
  }

  /** 清理待触发的重连定时器。 */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** 认证目录绝对路径。 */
  private authDir(): string {
    return this.options.channels.whatsapp.authDir;
  }

  /** 向指定 JID 主动推送（任务中断通知）。 */
  async notify(jid: string, text: string): Promise<void> {
    try {
      await this.sender.send(this.target(jid), text, this.charLimit);
    } catch (error) {
      this.log('WhatsApp 主动推送失败：' + describeError(error));
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}
