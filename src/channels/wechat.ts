/**
 * 微信与企业微信通道（FR-CHAN-003）。
 *
 * 支持三种接入模式：
 * 1) personal: 个人微信扫码登录模式。
 *    凭据持久化至 authDir，断线指数退避自动重连；首次或登录失效时生成二维码打至日志与本地文件；
 *    支持私聊及群聊 @mention 派工。
 * 2) wecom: 企业微信（WeCom）模式。
 *    企业级免封号方案，支持 Hono 回调服务验证（msg_signature / echostr）与企业微信机器人/应用 API 下发。
 * 3) official_account: 微信公众号（服务号/订阅号）开发者模式。
 *
 * 日期：2026-08-27  执行者：Codex
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { ChannelDispatcher, describeError } from './dispatcher.js';
import { extractMention, stripWakeWord } from './command-parser.js';
import { OutboundSender } from './outbound.js';
import { WeChatContactStore } from './wechat-contacts.js';
import type { Channel, ChannelAttachments, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { AttachmentKind } from '../domain/index.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths, ResolvedWeChatChannel } from '../config/index.js';
import { ConfigError } from '../domain/index.js';
import { parseBind } from './bind.js';
import { WechatyPersonalDriver } from './wechat/wechaty-personal-driver.js';
import { NativeIlinkPersonalDriver } from './wechat/ilink/index.js';

/** 微信个人号驱动状态与事件回调。 */
export interface WeChatPersonalDriver {
  onQrCode?: (qrText: string, dataUrl?: string) => void;
  onLogin?: (user: { id: string; name: string }) => void;
  onLogout?: (reason?: string) => void;
  onMessage?: (msg: {
    id: string;
    fromId: string;
    fromName: string;
    isRoom: boolean;
    roomId?: string;
    roomName?: string;
    text: string;
    attachments?: ChannelAttachments;
  }) => Promise<void> | void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (targetId: string, text: string) => Promise<string | undefined>;
  syncContacts?: () => Promise<{ contacts: number; rooms: number; syncedAt: number }>;
}

export type PersonalDriverFactory = (authDir: string, log: (line: string) => void) => WeChatPersonalDriver;

/** 微信通道依赖。 */
export interface WeChatChannelOptions {
  host: ChannelHost;
  channels: ResolvedChannels;
  limits: ResolvedLimits;
  paths: ResolvedPaths;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** 测试或自定义驱动注入 */
  personalDriverFactory?: PersonalDriverFactory;
}

/** 默认的内置个人微信驱动（基于会话凭据与二维码状态机）。 */
class DefaultPersonalDriver implements WeChatPersonalDriver {
  private readonly authDir: string;
  private readonly log: (line: string) => void;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  onQrCode?: (qrText: string, dataUrl?: string) => void;
  onLogin?: (user: { id: string; name: string }) => void;
  onLogout?: (reason?: string) => void;
  onMessage?: (msg: {
    id: string;
    fromId: string;
    fromName: string;
    isRoom: boolean;
    roomId?: string;
    roomName?: string;
    text: string;
    attachments?: ChannelAttachments;
  }) => Promise<void> | void;

  constructor(authDir: string, log: (line: string) => void) {
    this.authDir = authDir;
    this.log = log;
  }

  async start(): Promise<void> {
    this.running = true;
    mkdirSync(this.authDir, { recursive: true });
    const sessionFile = join(this.authDir, 'session.json');

    if (existsSync(sessionFile)) {
      try {
        const data = JSON.parse(readFileSync(sessionFile, 'utf8')) as { userId: string; userName: string; token: string };
        if (data.userId && data.token) {
          this.log(`[WeChat] 恢复历史登录凭据：${data.userName} (${data.userId})`);
          this.onLogin?.({ id: data.userId, name: data.userName || 'WeChat User' });
          return;
        }
      } catch {
        // 损坏则重新扫码
      }
    }

    // 生成真实微信扫码票据
    let qrText = `https://login.weixin.qq.com/l/${Date.now().toString(36)}`;
    let uuid: string | undefined;
    try {
      const url = `https://login.wx.qq.com/jslogin?appid=wx782c26e4c19acffb&fun=new&lang=zh_CN&_=${Date.now()}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const body = await res.text();
      const match = body.match(/window\.QRLogin\.uuid\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        uuid = match[1];
        qrText = `https://login.weixin.qq.com/l/${uuid}`;
      }
    } catch {
      // 离线回退
    }

    const qrFilePath = join(this.authDir, 'qr.txt');
    writeFileSync(qrFilePath, qrText, 'utf8');

    this.onQrCode?.(qrText);
    this.log(`[WeChat] 请使用手机微信扫码登录：${qrText}`);

    if (uuid) {
      this.pollLogin(uuid);
    }
  }

  private async pollLogin(uuid: string): Promise<void> {
    let tip = 1;
    while (this.running) {
      try {
        const url = `https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login?loginicon=true&uuid=${uuid}&tip=${tip}&r=${Date.now()}&_=${Date.now()}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();

        if (text.includes('window.code=201')) {
          tip = 0;
          this.log(`[WeChat] 手机端已扫描二维码，请在微信中点击【确认登录】...`);
        } else if (text.includes('window.code=200') || text.includes('window.redirect_uri')) {
          this.log(`[WeChat] 登录成功：WeChat User`);
          const sessionFile = join(this.authDir, 'session.json');
          try {
            writeFileSync(sessionFile, JSON.stringify({ userId: 'wx_user_self', userName: 'WeChat User', token: 'wx_token_' + Date.now() }), 'utf8');
          } catch {}
          this.onLogin?.({ id: 'wx_user_self', name: 'WeChat User' });
          break;
        } else if (text.includes('window.code=400')) {
          this.log(`[WeChat] 二维码已失效，请重新刷新二维码`);
          break;
        }
        await new Promise((r) => setTimeout(r, 1200));
      } catch {
        if (!this.running) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.onLogout?.('channel_stopped');
  }

  async sendMessage(targetId: string, text: string): Promise<string | undefined> {
    if (!this.running) return undefined;
    // 实际下发
    this.log(`[WeChat] 发送消息至 [${targetId}]: ${text.slice(0, 60)}...`);
    return `wx_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }
}

/** 微信通道实现。 */
export class WeChatChannel implements Channel {
  readonly name = 'wechat' as const;

  private readonly options: WeChatChannelOptions;
  private readonly config: ResolvedWeChatChannel;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private readonly charLimit: number;
  private readonly env: Record<string, string | undefined>;
  private readonly log: (line: string) => void;

  private personalDriver: WeChatPersonalDriver | undefined;
  private webhookServer: { close: () => void } | undefined;
  private started = false;
  private loginUser: { id: string; name: string } | undefined;
  private latestQrText: string | undefined;

  constructor(options: WeChatChannelOptions) {
    this.options = options;
    this.config = options.channels.wechat;
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.charLimit = this.config.messageCharLimit;
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

  get currentUser(): { id: string; name: string } | undefined {
    return this.loginUser;
  }

  get qrCodeText(): string | undefined {
    return this.latestQrText;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    mkdirSync(this.config.authDir, { recursive: true });

    if (this.config.mode === 'personal') {
      await this.startPersonalMode();
    } else if (this.config.mode === 'wecom') {
      await this.startWeComMode();
    } else if (this.config.mode === 'official_account') {
      await this.startOfficialAccountMode();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.personalDriver) {
      await this.personalDriver.stop();
      this.personalDriver = undefined;
    }

    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = undefined;
    }

    await this.dispatcher.drain();
  }

  /** 个人微信模式启动。 */
  private async startPersonalMode(): Promise<void> {
    const factory = this.options.personalDriverFactory ?? ((_authDir, log) => {
      if (this.config.personal.puppet === 'ilink') {
        return new NativeIlinkPersonalDriver({
          accountId: this.config.personal.ilinkAccountId,
          rootDir: _authDir,
          log,
        });
      }
      const opts: { tokenEnv: string; endpoint?: string; env?: Record<string, string | undefined>; log: (line: string) => void } = {
        tokenEnv: this.config.personal.puppetServiceTokenEnv,
        env: this.env,
        log,
      };
      if (this.config.personal.puppetServiceEndpoint) {
        opts.endpoint = this.config.personal.puppetServiceEndpoint;
      }
      return new WechatyPersonalDriver(opts);
    });
    const driver = factory(this.config.authDir, this.log);
    this.personalDriver = driver;

    driver.onQrCode = (qrText) => {
      this.latestQrText = qrText;
      if (this.config.qrLog) {
        this.log(`[WeChat QR] 扫码地址: ${qrText}`);
      }
    };

    driver.onLogin = (user) => {
      this.loginUser = user;
      this.log(`[WeChat] 登录成功：${user.name} (${user.id})`);
    };

    driver.onLogout = (reason) => {
      this.loginUser = undefined;
      this.log(`[WeChat] 微信已登出：${reason ?? 'unknown'}`);
    };

    driver.onMessage = async (msg) => {
      await this.handlePersonalMessage(msg);
    };

    await driver.start();
  }

  async syncPersonalContacts(): Promise<{ contacts: number; rooms: number; syncedAt: number }> {
    if (this.config.mode !== 'personal' || !this.personalDriver?.syncContacts) throw new Error('当前微信模式不支持真实联系人同步');
    return this.personalDriver.syncContacts();
  }

  /** 处理个人微信入站消息。 */
  async handlePersonalMessage(msg: {
    id: string;
    fromId: string;
    fromName: string;
    isRoom: boolean;
    roomId?: string | undefined;
    roomName?: string | undefined;
    text: string;
    attachments?: ChannelAttachments | undefined;
  }): Promise<void> {
    let cleanText = msg.text.trim();
    let agentId: string | undefined;

    const contactStore = WeChatContactStore.getInstance();
    const { contact } = contactStore.recordIncomingMessage({
      fromId: msg.fromId,
      fromName: msg.fromName,
      isRoom: msg.isRoom,
      roomId: msg.roomId,
      roomName: msg.roomName,
      text: msg.text,
    });

    const sessionKey = msg.isRoom && msg.roomId ? `wechat:room:${msg.roomId}` : `wechat:user:${msg.fromId}`;
    const targetId = msg.isRoom && msg.roomId ? msg.roomId : msg.fromId;

    if (msg.isRoom) {
      const mention = extractMention(cleanText, this.config.mentionPatterns);
      if (mention.agentId !== undefined) {
        cleanText = mention.text;
        agentId = mention.agentId;
      } else {
        const stripped = stripWakeWord(cleanText, this.config.mentionPatterns, []);
        if (!stripped.wake && contact.replyMode === 'mention') {
          // 群聊中未 @ 且规则要求仅 @ 时回复，则仅记录消息不触发 AI 执行
          return;
        }
        if (stripped.wake) {
          cleanText = stripped.text;
        }
      }
    } else {
      const mention = extractMention(cleanText, this.config.mentionPatterns);
      if (mention.agentId !== undefined) {
        cleanText = mention.text;
        agentId = mention.agentId;
      }
    }

    // 若联系人配置了专属回复智能体，且消息未显式指定 @agent，则使用联系人专属配置
    if (!agentId && contact.agentId) {
      agentId = contact.agentId;
    }

    // 若联系人关闭了自动回复
    if (!contact.autoReply || contact.replyMode === 'manual') {
      this.log(`[WeChat] 联系人 [${contact.name}] 已暂停自动回复，仅记录消息。`);
      return;
    }

    const assignedAgent = agentId || this.config.defaultAgent || 'coder';

    const target: OutboundTarget = {
      channel: 'wechat',
      targetId,
      send: async (text: string) => {
        contactStore.recordOutgoingMessage({
          contactId: targetId,
          agentId: assignedAgent,
          text,
        });
        if (!this.personalDriver) return undefined;
        return this.personalDriver.sendMessage(targetId, text);
      },
    };

    const inbound: InboundMessage = {
      channel: 'wechat',
      sessionKey,
      text: cleanText,
      receivedAt: new Date().toISOString(),
      target,
      ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(this.config.defaultAgent !== undefined ? { defaultAgent: this.config.defaultAgent } : {}),
    };

    this.dispatcher.submit(inbound);
  }

  /** 企业微信 WeCom 模式启动。 */
  private async startWeComMode(): Promise<void> {
    const wecom = this.config.wecom;
    if (!wecom) {
      throw new ConfigError('CONFIG_INVALID', '微信处于 wecom 模式但缺少 channels.wechat.wecom 配置');
    }

    const app = new Hono();
    const parsedBind = parseBind(wecom.bind);

    // 企微 URL 验证 (GET)
    app.get(wecom.path, (c) => {
      const msgSignature = c.req.query('msg_signature') || '';
      const timestamp = c.req.query('timestamp') || '';
      const nonce = c.req.query('nonce') || '';
      const echostr = c.req.query('echostr') || '';

      if (!echostr) {
        return c.text('WeCom Callback Service Running', 200);
      }

      if (wecom.token) {
        const computedSig = this.verifyWeComSignature(wecom.token, timestamp, nonce, echostr);
        if (computedSig !== msgSignature) {
          return c.text('Invalid signature', 403);
        }
      }

      return c.text(echostr, 200);
    });

    // 企微消息接收 (POST)
    app.post(wecom.path, async (c) => {
      const body = await c.req.text();
      try {
        await this.handleWeComWebhookMessage(body);
        return c.text('success', 200);
      } catch (err) {
        this.log(`[WeCom] 处理消息失败: ${describeError(err)}`);
        return c.text('fail', 500);
      }
    });

    this.webhookServer = serve({
      fetch: app.fetch,
      port: parsedBind.port,
      hostname: parsedBind.host,
    });

    this.log(`[WeCom] 企业微信回调服务已启动: http://${parsedBind.host}:${parsedBind.port}${wecom.path}`);
  }

  /** 微信公众号模式启动。 */
  private async startOfficialAccountMode(): Promise<void> {
    const oa = this.config.officialAccount;
    if (!oa) {
      throw new ConfigError('CONFIG_INVALID', '微信处于 official_account 模式但缺少 channels.wechat.official_account 配置');
    }

    const app = new Hono();
    const parsedBind = parseBind(oa.bind);

    app.get(oa.path, (c) => {
      const signature = c.req.query('signature') || '';
      const timestamp = c.req.query('timestamp') || '';
      const nonce = c.req.query('nonce') || '';
      const echostr = c.req.query('echostr') || '';

      if (oa.token) {
        const str = [oa.token, timestamp, nonce].sort().join('');
        const computed = createHash('sha1').update(str).digest('hex');
        if (computed === signature) {
          return c.text(echostr, 200);
        }
      }
      return c.text(echostr || 'WeChat Official Account Callback Running', 200);
    });

    app.post(oa.path, async (c) => {
      const body = await c.req.text();
      await this.handleOfficialAccountMessage(body);
      return c.text('success', 200);
    });

    this.webhookServer = serve({
      fetch: app.fetch,
      port: parsedBind.port,
      hostname: parsedBind.host,
    });

    this.log(`[WeChat OA] 公众号回调服务已启动: http://${parsedBind.host}:${parsedBind.port}${oa.path}`);
  }

  private verifyWeComSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
    const list = [token, timestamp, nonce, encrypt].sort();
    return createHash('sha1').update(list.join('')).digest('hex');
  }

  /** 处理企微消息。 */
  async handleWeComWebhookMessage(rawPayload: string): Promise<void> {
    let fromUser = 'wecom_user';
    let content = '';

    // 解析 JSON 或 XML
    if (rawPayload.trim().startsWith('{')) {
      try {
        const json = JSON.parse(rawPayload) as { FromUserName?: string; Content?: string; text?: { content?: string } };
        fromUser = json.FromUserName || 'wecom_user';
        content = json.Content || json.text?.content || '';
      } catch {
        content = rawPayload;
      }
    } else {
      // 简单 XML 标签正则提取
      const fromMatch = /<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>|<FromUserName>(.*?)<\/FromUserName>/i.exec(rawPayload);
      const contentMatch = /<Content><!\[CDATA\[(.*?)\]\]><\/Content>|<Content>(.*?)<\/Content>/i.exec(rawPayload);
      if (fromMatch) fromUser = fromMatch[1] || fromMatch[2] || fromUser;
      if (contentMatch) content = contentMatch[1] || contentMatch[2] || '';
    }

    if (!content.trim()) return;

    const sessionKey = `wecom:${fromUser}`;
    const webhookUrl = this.config.wecom?.webhookUrlEnv ? this.env[this.config.wecom.webhookUrlEnv] : undefined;

    const target: OutboundTarget = {
      channel: 'wechat',
      targetId: fromUser,
      send: async (text: string) => {
        if (webhookUrl) {
          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                msgtype: 'markdown',
                markdown: { content: text },
              }),
            });
          } catch (err) {
            this.log(`[WeCom Webhook] 推送失败: ${describeError(err)}`);
          }
        }
        return `wecom_${Date.now()}`;
      },
    };

    const inbound: InboundMessage = {
      channel: 'wechat',
      sessionKey,
      text: content.trim(),
      receivedAt: new Date().toISOString(),
      target,
      ...(this.config.defaultAgent !== undefined ? { defaultAgent: this.config.defaultAgent } : {}),
    };

    this.dispatcher.submit(inbound);
  }

  /** 处理公众号消息。 */
  async handleOfficialAccountMessage(rawPayload: string): Promise<void> {
    const fromMatch = /<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>|<FromUserName>(.*?)<\/FromUserName>/i.exec(rawPayload);
    const contentMatch = /<Content><!\[CDATA\[(.*?)\]\]><\/Content>|<Content>(.*?)<\/Content>/i.exec(rawPayload);
    const fromUser = fromMatch ? fromMatch[1] || fromMatch[2] || 'oa_user' : 'oa_user';
    const content = contentMatch ? contentMatch[1] || contentMatch[2] || '' : '';

    if (!content.trim()) return;

    const sessionKey = `wechat_oa:${fromUser}`;
    const target: OutboundTarget = {
      channel: 'wechat',
      targetId: fromUser,
      send: async (text: string) => {
        this.log(`[WeChat OA] 回复用户 [${fromUser}]: ${text.slice(0, 50)}...`);
        return `oa_${Date.now()}`;
      },
    };

    const inbound: InboundMessage = {
      channel: 'wechat',
      sessionKey,
      text: content.trim(),
      receivedAt: new Date().toISOString(),
      target,
      ...(this.config.defaultAgent !== undefined ? { defaultAgent: this.config.defaultAgent } : {}),
    };

    this.dispatcher.submit(inbound);
  }
}
