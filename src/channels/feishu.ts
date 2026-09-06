/**
 * 飞书 (Feishu / Lark) 智能体交互通道。
 *
 * 支持能力：
 * 1. 飞书开放平台事件订阅 (Event Subscription v2)；
 * 2. URL 校验 Challenge 自动响应；
 * 3. 消息事件解析 (im.message.receive_v1，支持文本、富文本、图片)；
 * 4. 群聊 @机器人 与私聊会话识别；
 * 5. tenant_access_token 自动获取与缓存刷新；
 * 6. 飞书交互式卡片消息 (Interactive Cards) 与 Markdown 输出回写；
 * 7. 自定义机器人 Webhook 快速推送回退；
 * 8. ChannelContactStore 联系人自动归档与专属智能体路由。
 */

import { createServer, type Server, type IncomingMessage as HttpIncomingMessage, type ServerResponse } from 'node:http';
import { createDecipheriv, createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ChannelDispatcher, describeError } from './dispatcher.js';
import { extractMention, parseCommand, stripWakeWord } from './command-parser.js';
import { OutboundSender } from './outbound.js';
import { ChannelContactStore } from './contacts-store.js';
import { parseBind } from './bind.js';
import type { Channel, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../config/index.js';
import { BotAuthorizationService, ControlPlaneError, type ControlExecutionContext } from '../control-plane/index.js';

export interface FeishuChannelConfig {
  enabled?: boolean | undefined;
  appId?: string | undefined;
  appSecretEnv?: string | undefined;
  appSecret?: string | undefined;
  verificationToken?: string | undefined;
  encryptKeyEnv?: string | undefined;
  encryptKey?: string | undefined;
  webhookUrlEnv?: string | undefined;
  webhookUrl?: string | undefined;
  bind?: string | undefined;
  path?: string | undefined;
  defaultAgent?: string | undefined;
  mentionPatterns?: string[] | undefined;
  messageCharLimit?: number | undefined;
}

export interface FeishuChannelOptions {
  config: FeishuChannelConfig;
  host: ChannelHost;
  paths?: ResolvedPaths | undefined;
  limits?: ResolvedLimits | undefined;
  channels?: ResolvedChannels | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  contactStore?: ChannelContactStore | undefined;
  control?: { botAccountId: string; authorization: BotAuthorizationService } | undefined;
}

interface FeishuTokenCache {
  token: string;
  expiresAt: number;
}

export class FeishuChannel implements Channel {
  readonly name = 'feishu' as const;
  private readonly config: FeishuChannelConfig;
  private readonly host: ChannelHost;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private readonly env: NodeJS.ProcessEnv;
  private readonly contactStore: ChannelContactStore;
  private readonly control?: { botAccountId: string; authorization: BotAuthorizationService } | undefined;
  private server?: Server | undefined;
  private tokenCache?: FeishuTokenCache | undefined;

  constructor(options: FeishuChannelOptions) {
    this.config = {
      defaultAgent: 'coder',
      mentionPatterns: ['@_all', '@hap', '@feishu', '@bot', '@ai', '@智能体'],
      bind: '127.0.0.1:8765',
      path: '/api/feishu/events',
      ...options.config,
    };
    this.host = options.host;
    this.env = options.env ?? process.env;
    this.contactStore = options.contactStore ?? ChannelContactStore.getInstance();
    this.control = options.control;

    this.sender = new OutboundSender(options.paths?.spoolDir ?? join(homedir(), '.hap', 'spool'));

    this.dispatcher = new ChannelDispatcher({
      host: this.host,
      sender: this.sender,
      messageCharLimit: this.config.messageCharLimit ?? 4000,
      editIntervalMs: options.channels?.editIntervalMs ?? 1000,
      asyncThresholdMs: options.channels?.asyncThresholdMs ?? 5000,
      queueCapacity: options.limits?.ingressQueueSize ?? 100,
    });
  }

  private log(message: string): void {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    process.stdout.write(`[${time}] [Feishu] ${message}\n`);
  }

  async start(): Promise<void> {
    const bindAddr = parseBind(this.config.bind || '127.0.0.1:8765');
    const eventPath = this.config.path || '/api/feishu/events';

    this.server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', channel: 'feishu' }));
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith(eventPath)) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const result = await this.handleIncomingEvent(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            this.log(`处理事件异常：${describeError(err)}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: describeError(err) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(bindAddr.port, bindAddr.host, () => {
        this.log(`飞书事件监听服务已启动：http://${bindAddr.host}:${bindAddr.port}${eventPath}`);
        resolve();
      });
      this.server?.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
      this.log('飞书事件监听服务已停止');
    }
  }

  /** 获取飞书 App Secret */
  private getAppSecret(): string | undefined {
    if (this.config.appSecret) return this.config.appSecret;
    if (this.config.appSecretEnv && this.env[this.config.appSecretEnv]) {
      return this.env[this.config.appSecretEnv];
    }
    return undefined;
  }

  /** 获取飞书 Encrypt Key */
  private getEncryptKey(): string | undefined {
    if (this.config.encryptKey) return this.config.encryptKey;
    if (this.config.encryptKeyEnv && this.env[this.config.encryptKeyEnv]) {
      return this.env[this.config.encryptKeyEnv];
    }
    return undefined;
  }

  /** 获取飞书 Webhook URL */
  private getWebhookUrl(): string | undefined {
    if (this.config.webhookUrl) return this.config.webhookUrl;
    if (this.config.webhookUrlEnv && this.env[this.config.webhookUrlEnv]) {
      return this.env[this.config.webhookUrlEnv];
    }
    return undefined;
  }

  /** 获取 tenant_access_token */
  async getTenantAccessToken(): Promise<string | undefined> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
      return this.tokenCache.token;
    }

    const appId = this.config.appId;
    const appSecret = this.getAppSecret();
    if (!appId || !appSecret) {
      return undefined;
    }

    try {
      const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const data = (await resp.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number };
      if (data.code === 0 && data.tenant_access_token) {
        this.tokenCache = {
          token: data.tenant_access_token,
          expiresAt: Date.now() + ((data.expire || 7200) - 200) * 1000,
        };
        return data.tenant_access_token;
      }
      this.log(`获取 tenant_access_token 失败：${data.msg}`);
    } catch (err) {
      this.log(`获取 token 网络异常：${describeError(err)}`);
    }
    return undefined;
  }

  /** 解密飞书 Encrypt 报文 */
  private decryptPayload(encryptText: string, key: string): string {
    const keyBuffer = createHash('sha256').update(key).digest();
    const encryptedBuffer = Buffer.from(encryptText, 'base64');
    const iv = encryptedBuffer.subarray(0, 16);
    const data = encryptedBuffer.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', keyBuffer, iv);
    let decrypted = decipher.update(data, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /** 处理飞书入站事件 */
  async handleEventPayload(rawBody: string | Record<string, unknown>): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown> = typeof rawBody === 'string' ? {} : rawBody;
    if (typeof rawBody === 'string') {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return { code: 400, msg: 'invalid json' };
      }
    }

    // 处理加密
    if (typeof payload.encrypt === 'string') {
      const encryptKey = this.getEncryptKey();
      if (encryptKey) {
        const decrypted = this.decryptPayload(payload.encrypt, encryptKey);
        payload = JSON.parse(decrypted) as Record<string, unknown>;
      }
    }

    // 1. 处理 URL Verification Challenge
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      return { challenge: payload.challenge };
    }

    // 2. 处理事件回调 (v2 schema)
    const header = payload.header as { event_type?: string; token?: string } | undefined;
    const eventType = header?.event_type || (payload.event as { type?: string } | undefined)?.type;

    if (eventType === 'im.message.receive_v1') {
      await this.handleMessageReceiveEvent(payload);
    }

    return { status: 'ok' };
  }

  /** 处理飞书入站事件（HTTP Webhook 入口） */
  async handleIncomingEvent(rawBody: string): Promise<Record<string, unknown>> {
    return this.handleEventPayload(rawBody);
  }

  /** 解析并调度飞书聊天消息 */
  async handleMessageReceiveEvent(payload: Record<string, unknown>): Promise<void> {
    const event = (payload.event || {}) as {
      sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
      message?: {
        message_id?: string;
        chat_id?: string;
        chat_type?: string; // 'p2p' or 'group'
        message_type?: string;
        content?: string;
        mentions?: Array<{ key?: string; id?: { open_id?: string; user_id?: string }; name?: string }>;
      };
    };

    const message = event.message;
    if (!message || !message.content) return;

    const chatType = message.chat_type || 'p2p';
    const isRoom = chatType === 'group';
    const chatId = message.chat_id || 'unknown_chat';
    const senderId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || 'feishu_user';
    const senderName = (message.mentions && message.mentions.length > 0 ? message.mentions[0]?.name : undefined) || `用户 (${senderId.slice(-6)})`;

    let textContent = '';
    try {
      const parsed = JSON.parse(message.content) as { text?: string; title?: string };
      textContent = parsed.text || parsed.title || message.content;
    } catch {
      textContent = message.content;
    }

    let cleanText = textContent.trim();
    if (!cleanText) return;

    const contactStore = this.contactStore;
    const contactId = isRoom ? chatId : senderId;
    const contactName = isRoom ? `飞书群聊 (${chatId.slice(-6)})` : senderName;

    const { contact } = contactStore.recordIncomingMessage({
      channel: 'feishu',
      fromId: senderId,
      fromName: senderName,
      isRoom,
      roomId: isRoom ? chatId : undefined,
      roomName: isRoom ? contactName : undefined,
      text: cleanText,
    });

    let agentId: string | undefined;
    const patterns = this.config.mentionPatterns ?? [];
    if (isRoom) {
      const mention = extractMention(cleanText, patterns);
      if (mention.agentId !== undefined) {
        cleanText = mention.text;
        agentId = mention.agentId;
      } else {
        const stripped = stripWakeWord(cleanText, patterns, []);
        if (!stripped.wake && contact.replyMode === 'mention') {
          return;
        }
        if (stripped.wake) {
          cleanText = stripped.text;
        }
      }
    } else {
      const mention = extractMention(cleanText, patterns);
      if (mention.agentId !== undefined) {
        cleanText = mention.text;
        agentId = mention.agentId;
      }
    }

    if (!agentId && contact.agentId) {
      agentId = contact.agentId;
    }

    if (!contact.autoReply || contact.replyMode === 'manual') {
      this.log(`联系人 [${contact.name}] 已暂停自动回复，仅记录消息。`);
      return;
    }

    const assignedAgent = agentId || this.config.defaultAgent || 'coder';
    const sessionKey = isRoom ? `feishu:room:${chatId}` : `feishu:user:${senderId}`;
    const control = await this.authorizeControl({
      platformUserId: senderId,
      text: cleanText,
      receiveId: chatId,
      isChatId: true,
      requestId: String((payload.header as { event_id?: string } | undefined)?.event_id ?? message.message_id ?? Date.now()),
    });
    if (control === false) return;

    const target: OutboundTarget = {
      channel: 'feishu',
      targetId: contactId,
      send: async (text: string) => {
        contactStore.recordOutgoingMessage({
          channel: 'feishu',
          contactId,
          agentId: assignedAgent,
          text,
        });
        return this.sendFeishuMessage(chatId, text, isRoom);
      },
    };

    const inbound: InboundMessage = {
      channel: 'feishu',
      sessionKey,
      text: cleanText,
      receivedAt: new Date().toISOString(),
      target,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(this.config.defaultAgent !== undefined ? { defaultAgent: this.config.defaultAgent } : {}),
    };
    if (control !== undefined) {
      inbound.executionContext = {
        serverId: control.serverId,
        botAccountId: control.accountId,
        control,
      };
    }

    this.dispatcher.submit(inbound);
  }

  private async authorizeControl(input: {
    platformUserId: string;
    text: string;
    receiveId: string;
    isChatId: boolean;
    requestId: string;
  }): Promise<ControlExecutionContext | undefined | false> {
    if (this.control === undefined) return undefined;
    const pair = /^\/pair\s+([0-9]{6})\s*$/i.exec(input.text.trim());
    if (pair !== null) {
      try {
        const operator = this.control.authorization.consumePairingCode({
          botAccountId: this.control.botAccountId,
          code: pair[1] ?? '',
          platformUserId: input.platformUserId,
        });
        await this.sendFeishuMessage(input.receiveId, `✅ 已配对成功，当前权限：${operator.role}`, input.isChatId);
      } catch {
        await this.sendFeishuMessage(input.receiveId, '✗ 配对失败：验证码无效、过期或已使用。', input.isChatId);
      }
      return false;
    }
    try {
      return this.control.authorization.authorizeInbound({
        botAccountId: this.control.botAccountId,
        platformUserId: input.platformUserId,
        requestId: input.requestId,
        commandKind: normalizeCommandKindForControl(parseCommand(input.text)),
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'CONTROL_FORBIDDEN') {
        await this.sendFeishuMessage(
          input.receiveId,
          '⚠ 当前用户尚未配对，已拒绝执行。\n请先在桌面端为该 Bot 生成配对码，然后在此发送 /pair 123456 完成绑定。',
          input.isChatId,
        );
        return false;
      }
      throw error;
    }
  }

  /** 发送飞书消息（优先 OpenAPI 卡片消息，若未配置凭据则尝试自定义 Webhook） */
  async sendFeishuMessage(receiveId: string, text: string, isChatId: boolean = true): Promise<string | undefined> {
    const token = await this.getTenantAccessToken();
    if (token) {
      try {
        const receiveIdType = isChatId ? 'chat_id' : 'open_id';
        const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;

        // 构造飞书 Markdown 交互卡片
        const cardContent = {
          config: { wide_screen_mode: true },
          header: {
            template: 'blue',
            title: { tag: 'plain_text', content: 'HAP 智能体协同回执' },
          },
          elements: [
            {
              tag: 'markdown',
              content: text,
            },
            {
              tag: 'hr',
            },
            {
              tag: 'note',
              elements: [
                {
                  tag: 'plain_text',
                  content: `Hermes Agent Platform · ${new Date().toLocaleTimeString()}`,
                },
              ],
            },
          ],
        };

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          }),
        });

        const data = (await resp.json()) as { code: number; msg: string; data?: { message_id?: string } };
        if (data.code === 0) {
          return data.data?.message_id;
        }
        this.log(`OpenAPI 发送失败 [code=${data.code}]: ${data.msg}`);
      } catch (err) {
        this.log(`OpenAPI 调用异常: ${describeError(err)}`);
      }
    }

    // Webhook 快速推送回退
    const webhookUrl = this.getWebhookUrl();
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msg_type: 'interactive',
            card: {
              elements: [{ tag: 'markdown', content: text }],
            },
          }),
        });
        return `feishu_hook_${Date.now()}`;
      } catch (err) {
        this.log(`Webhook 推送失败: ${describeError(err)}`);
      }
    }

    return undefined;
  }
}

function normalizeCommandKindForControl(command: ReturnType<typeof parseCommand>): string {
  if (command.kind === 'sh') return 'shell';
  if (command.kind === 'model' && command.modelName !== undefined) return 'model_switch';
  return command.kind;
}
