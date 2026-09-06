/**
 * Telegram 通道（FR-CHAN-015/016）。
 *
 * 直接复用 grammy 官方 SDK，不自建 Bot API 客户端。
 * 三个必须处理的平台细节：
 * 1) 单条消息 4096 字符硬上限 → 交给 OutboundSender 分片；
 * 2) editMessageText 在内容未变时返回 400 "message is not modified" → 视为幂等成功；
 * 3) polling 与 webhook 互斥 → 启动期校验，不给出「两边都开」的中间态。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { webhookCallback } from 'grammy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ChannelDispatcher, describeError } from './dispatcher.js';
import { extractMention, parseCommand, stripWakeWord } from './command-parser.js';
import { OutboundSender } from './outbound.js';
import { formatTelegramHtml } from './telegram-formatter.js';
import type { Channel, ChannelAttachments, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { AttachmentKind } from '../domain/index.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../config/index.js';
import { ConfigError } from '../domain/index.js';
import { parseBind } from './bind.js';
import { BotAuthorizationService, ControlPlaneError, type ControlExecutionContext } from '../control-plane/index.js';

/** Telegram 通道依赖。 */
export interface TelegramChannelOptions {
  host: ChannelHost;
  channels: ResolvedChannels;
  limits: ResolvedLimits;
  paths: ResolvedPaths;
  env: Record<string, string | undefined>;
  /** 日志回调；不注入则静默 */
  log?: (line: string) => void;
  /** 可选控制平面授权；启用后默认拒绝未配对的平台用户。 */
  control?: { botAccountId: string; authorization: BotAuthorizationService } | undefined;
}

/** Telegram 编辑失败中可以当成成功的错误文案。 */
const IDEMPOTENT_EDIT_HINTS = ['message is not modified', 'message to edit not found'];

/**
 * Telegram 通道实现。
 *
 * 归一化只做三件事：解析 mention、收集附件描述、构造回写目标。
 * 具体任务执行完全交给 ChannelDispatcher，因此 HTTP/CLI 行为与这里一致。
 */
export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const;

  private readonly options: TelegramChannelOptions;
  private readonly bot: Bot;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private readonly charLimit: number;
  private readonly chatIds = new Set<string>();
  private readonly token: string;
  private webhookServer: { close: () => void } | undefined;
  private started = false;

  constructor(options: TelegramChannelOptions) {
    this.options = options;
    const telegram = options.channels.telegram;
    const token = options.env[telegram.tokenEnv];
    if (token === undefined || token.trim().length === 0) {
      throw new ConfigError('CONFIG_ENV_MISSING', 'Telegram 通道已启用但环境变量 ' + telegram.tokenEnv + ' 未设置', {
        tokenEnv: telegram.tokenEnv,
      });
    }
    if (telegram.mode === 'webhook' && telegram.webhook === undefined) {
      throw new ConfigError('CONFIG_INVALID', 'Telegram 处于 webhook 模式但缺少 channels.telegram.webhook 配置', {
        mode: telegram.mode,
      });
    }
    this.charLimit = telegram.messageCharLimit;
    this.token = token;
    this.bot = new Bot(token);
    this.sender = new OutboundSender(options.paths.spoolDir);
    this.dispatcher = new ChannelDispatcher({
      host: options.host,
      sender: this.sender,
      messageCharLimit: this.charLimit,
      editIntervalMs: options.channels.editIntervalMs,
      asyncThresholdMs: options.channels.asyncThresholdMs,
      queueCapacity: options.limits.ingressQueueSize,
    });
    this.registerHandlers();
  }

  /** 启动：按配置二选一进入 polling 或 webhook，并先重投上次残留的出站消息。 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.bot.init();
    this.log('Telegram 已连接：@' + (this.bot.botInfo.username ?? 'unknown'));
    await this.flushSpool();
    const telegram = this.options.channels.telegram;
    if (telegram.mode === 'webhook') {
      await this.startWebhook();
      return;
    }
    // grammy 的 start() 在 polling 结束前不会 resolve，因此这里不 await
    void this.bot.start({
      onStart: () => {
        this.log('Telegram 长轮询已启动');
      },
    });
  }

  /** 停机：先排空队列，再断开平台连接。 */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    await this.dispatcher.drain();
    this.webhookServer?.close();
    this.webhookServer = undefined;
    await this.bot.stop();
  }

  /** 供测试与 manager 主动注入一条消息。 */
  async handleInbound(message: InboundMessage): Promise<void> {
    await this.dispatcher.handle(message);
  }

  /** 向指定 chat 主动推送（任务中断通知、异步完成卡片）。 */
  async notify(chatId: string, text: string): Promise<void> {
    try {
      await this.sender.send(this.target(chatId), text, this.charLimit);
    } catch (error) {
      this.log('Telegram 主动推送失败：' + describeError(error));
    }
  }

  private registerHandlers(): void {
    const telegram = this.options.channels.telegram;
    this.bot.on('message', (ctx) => {
      void this.ingest(ctx, telegram.mentionPatterns, telegram.defaultAgent);
    });
    this.bot.catch((error) => {
      this.log('Telegram 运行时错误：' + describeError(error.error));
    });
  }

  /**
   * 把一条平台消息归一并入队。
   *
   * 附件必须先落到本地磁盘：Attachment 契约要求 path 为本地绝对路径，
   * 平台的 file_id 与临时下载链接都会过期，直接丢给模型只会拿到 404。
   */
  private async ingest(
    ctx: Context,
    mentionPatterns: readonly string[],
    defaultAgent: string | undefined,
  ): Promise<void> {
    if (ctx.chat === undefined || ctx.message === undefined) {
      return;
    }
    const chatId = String(ctx.chat.id);
    const raw = ctx.message.text ?? ctx.message.caption ?? '';
    const known = this.options.host.agentIds();
    // 群聊门禁（FR-CHAN-014）：私聊全响应，群聊只响应唤起词、斜杠命令与点名智能体。
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    let body = raw;
    if (isGroup) {
      const wake = stripWakeWord(raw, mentionPatterns, known);
      if (!wake.wake) {
        return;
      }
      body = wake.text;
    } else {
      // 私聊也允许带唤起词，剥掉以免 @hap 被当成正文送进模型。
      body = stripWakeWord(raw, mentionPatterns, known).text;
    }
    this.chatIds.add(chatId);
    const platformUserId = ctx.from?.id === undefined ? chatId : String(ctx.from.id);
    const control = await this.authorizeControl(platformUserId, body, chatId);
    if (control === false) return;
    const mention = extractMention(body, known);
    const message: InboundMessage = {
      channel: 'telegram',
      sessionKey: 'chat:' + chatId,
      text: mention.text,
      receivedAt: new Date().toISOString(),
      target: this.target(chatId),
    };
    if (mention.agentId !== undefined) {
      message.agentId = mention.agentId;
    }
    if (defaultAgent !== undefined) {
      message.defaultAgent = defaultAgent;
    }
    if (control !== undefined) {
      message.executionContext = {
        serverId: control.serverId,
        botAccountId: control.accountId,
        control,
      };
    }
    try {
      const attachments = await this.downloadAttachments(ctx);
      if (attachments.length > 0) {
        message.attachments = attachments;
      }
    } catch (error) {
      this.log('Telegram 附件下载失败：' + describeError(error));
    }
    this.dispatcher.submit(message);
  }

  private async authorizeControl(platformUserId: string, body: string, chatId: string): Promise<ControlExecutionContext | undefined | false> {
    const control = this.options.control;
    if (control === undefined) return undefined;
    const pair = /^\/pair\s+([0-9]{6})\s*$/i.exec(body.trim());
    if (pair !== null) {
      try {
        const operator = control.authorization.consumePairingCode({
          botAccountId: control.botAccountId,
          code: pair[1] ?? '',
          platformUserId,
        });
        await this.sender.send(this.target(chatId), `✅ 已配对成功，当前权限：${operator.role}`, this.charLimit);
      } catch (error) {
        await this.sender.send(this.target(chatId), '✗ 配对失败：验证码无效、过期或已使用。', this.charLimit);
      }
      return false;
    }
    try {
      return control.authorization.authorizeInbound({
        botAccountId: control.botAccountId,
        platformUserId,
        requestId: `${control.botAccountId}:${chatId}:${Date.now()}`,
        commandKind: normalizeCommandKindForControl(parseCommand(body)),
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'CONTROL_FORBIDDEN') {
        await this.sender.send(
          this.target(chatId),
          '⚠ 当前用户尚未配对，已拒绝执行。\n请先在桌面端为该 Bot 生成配对码，然后在此发送 /pair 123456 完成绑定。',
          this.charLimit,
        );
        return false;
      }
      throw error;
    }
  }

  /**
   * 下载消息里的图片 / 文档 / 语音到 dataDir/inbox/<chatId>/。
   *
   * 只处理 Bot API 允许下载的 20MB 以内文件；超限时 getFile 会抛错，
   * 由调用方记录日志后继续把文本部分交给智能体，不因附件失败丢掉整条指令。
   */
  private async downloadAttachments(ctx: Context): Promise<ChannelAttachments> {
    const message = ctx.message;
    if (message === undefined || ctx.chat === undefined) {
      return [];
    }
    const specs = describeAttachments(message);
    if (specs.length === 0) {
      return [];
    }
    const dir = join(this.options.paths.dataDir, 'inbox', String(ctx.chat.id));
    mkdirSync(dir, { recursive: true });
    const items: ChannelAttachments = [];
    for (const spec of specs) {
      const file = await this.bot.api.getFile(spec.fileId);
      const remote = file.file_path;
      if (remote === undefined) {
        continue;
      }
      const url = 'https://api.telegram.org/file/bot' + this.token + '/' + remote;
      const response = await fetch(url);
      if (!response.ok) {
        this.log('Telegram 附件下载返回 ' + String(response.status) + '：' + spec.name);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const local = join(dir, spec.fileId.slice(-16) + '-' + spec.name);
      writeFileSync(local, bytes);
      const item: ChannelAttachments[number] = { kind: spec.kind, path: local, fileName: spec.name, bytes: bytes.byteLength };
      if (spec.mimeType !== undefined) {
        item.mimeType = spec.mimeType;
      }
      items.push(item);
    }
    return items;
  }

  /** webhook 模式：用 hono + @hono/node-server 挂载 grammy 的回调。 */
  private async startWebhook(): Promise<void> {
    const webhook = this.options.channels.telegram.webhook;
    if (webhook === undefined) {
      return;
    }
    const app = new Hono();
    const callback = webhookCallback(this.bot, 'hono');
    app.post(webhook.path, callback);
    const address = parseBind(webhook.bind);
    this.webhookServer = serve({ fetch: app.fetch, hostname: address.host, port: address.port });
    await this.bot.api.setWebhook(webhook.url, { drop_pending_updates: false });
    this.log('Telegram webhook 已注册：' + webhook.url + '（监听 ' + webhook.bind + webhook.path + '）');
  }

  /** 构造回写目标：默认采用富文本 HTML 格式发送，失败时自动降级为纯文本，edit 吞掉幂等错误。 */
  private target(chatId: string): OutboundTarget {
    return {
      channel: 'telegram',
      targetId: chatId,
      send: async (text: string) => {
        const html = formatTelegramHtml(text);
        const useHtml = this.charLimit <= 0 || html.length <= this.charLimit;
        if (useHtml) {
          try {
            const sent = await this.bot.api.sendMessage(chatId, html, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
            return String(sent.message_id);
          } catch (error) {
            this.log('Telegram HTML 发送失败，降级为纯文本：' + describeError(error));
          }
        }
        const sent = await this.bot.api.sendMessage(chatId, text);
        return String(sent.message_id);
      },
      edit: async (messageId: string, text: string) => {
        const html = formatTelegramHtml(text);
        const useHtml = this.charLimit <= 0 || html.length <= this.charLimit;
        if (useHtml) {
          try {
            await this.bot.api.editMessageText(chatId, Number(messageId), html, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
            return true;
          } catch (error) {
            const description = describeError(error).toLowerCase();
            if (IDEMPOTENT_EDIT_HINTS.some((hint) => description.includes(hint))) {
              return true;
            }
            this.log('Telegram HTML 编辑失败，尝试纯文本兜底：' + describeError(error));
          }
        }
        try {
          await this.bot.api.editMessageText(chatId, Number(messageId), text);
          return true;
        } catch (error) {
          const description = describeError(error).toLowerCase();
          if (IDEMPOTENT_EDIT_HINTS.some((hint) => description.includes(hint))) {
            return true;
          }
          throw error;
        }
      },
    };
  }

  /** 重投上次进程残留的出站消息。 */
  private async flushSpool(): Promise<void> {
    const sent = await this.sender.flush('telegram', (targetId) => this.target(targetId), this.charLimit);
    if (sent > 0) {
      this.log('Telegram 已重投 ' + String(sent) + ' 条缓冲消息');
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function normalizeCommandKindForControl(command: ReturnType<typeof parseCommand>): string {
  if (command.kind === 'sh') return 'shell';
  if (command.kind === 'model' && command.modelName !== undefined) return 'model_switch';
  return command.kind;
}

/**
 * 待下载附件规格。
 *
 * 把「识别有哪些附件」与「下载落盘」分成两步：前者是纯函数、可单测，
 * 后者需要网络。kind 直接对齐 domain 的 AttachmentKind，避免二次映射。
 */
export interface AttachmentSpec {
  kind: AttachmentKind;
  fileId: string;
  name: string;
  mimeType?: string;
}

/** 识别一条消息里可下载的附件。图片取分辨率最高的那档。 */
export function describeAttachments(message: Message): AttachmentSpec[] {
  const specs: AttachmentSpec[] = [];
  const photos = message.photo;
  if (photos !== undefined && photos.length > 0) {
    const largest = photos[photos.length - 1];
    if (largest !== undefined) {
      specs.push({ kind: 'image', fileId: largest.file_id, name: 'photo.jpg', mimeType: 'image/jpeg' });
    }
  }
  const document = message.document;
  if (document !== undefined) {
    const spec: AttachmentSpec = {
      kind: 'document',
      fileId: document.file_id,
      name: document.file_name ?? 'document.bin',
    };
    if (document.mime_type !== undefined) {
      spec.mimeType = document.mime_type;
    }
    specs.push(spec);
  }
  const voice = message.voice;
  if (voice !== undefined) {
    specs.push({ kind: 'audio', fileId: voice.file_id, name: 'voice.ogg', mimeType: voice.mime_type ?? 'audio/ogg' });
  }
  const audio = message.audio;
  if (audio !== undefined) {
    specs.push({ kind: 'audio', fileId: audio.file_id, name: audio.file_name ?? 'audio.mp3', mimeType: audio.mime_type ?? 'audio/mpeg' });
  }
  return specs;
}
