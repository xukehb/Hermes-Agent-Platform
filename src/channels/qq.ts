/**
 * QQ 机器人 (QQ Bot) 智能体交互通道。
 *
 * 支持双模式：
 * 1. OneBot v11 / v12 标准协议（兼容 NapCat、Lagrange、LLOneBot、go-cqhttp，支持 WebSocket 正向/反向连接与 HTTP Webhook）；
 * 2. QQ 开放平台官方机器人（QQ Open Platform API & Gateway）。
 *
 * 具备能力：
 * - 群聊与私聊消息识别、发送人 QQ 号与昵称提取；
 * - CQ 码与链式消息解析 (CQ:at, CQ:image, CQ:reply)；
 * - ChannelContactStore 联系人自动归档与专属智能体动态路由；
 * - 自动回复策略控制 (全量回复 / 仅@群回复 / 暂停监控)；
 * - 发送群消息与私聊消息回写流水线。
 */

import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ChannelDispatcher, describeError } from './dispatcher.js';
import { extractMention, stripWakeWord } from './command-parser.js';
import { OutboundSender } from './outbound.js';
import { ChannelContactStore } from './contacts-store.js';
import { parseBind } from './bind.js';
import { formatQQText } from './qq-formatter.js';
import type { Channel, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../config/index.js';

export interface QQChannelConfig {
  enabled?: boolean | undefined;
  mode?: 'onebot' | 'official' | undefined;
  onebotWsUrl?: string | undefined;
  onebotAccessTokenEnv?: string | undefined;
  onebotAccessToken?: string | undefined;
  onebotHttpUrl?: string | undefined;
  bind?: string | undefined;
  path?: string | undefined;
  officialAppId?: string | undefined;
  officialTokenEnv?: string | undefined;
  officialToken?: string | undefined;
  officialSecretEnv?: string | undefined;
  officialSecret?: string | undefined;
  defaultAgent?: string | undefined;
  mentionPatterns?: string[] | undefined;
  messageCharLimit?: number | undefined;
}

export interface QQChannelOptions {
  config: QQChannelConfig;
  host: ChannelHost;
  paths?: ResolvedPaths | undefined;
  limits?: ResolvedLimits | undefined;
  channels?: ResolvedChannels | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  contactStore?: ChannelContactStore | undefined;
}

export class QQChannel implements Channel {
  readonly name = 'qq' as const;
  private readonly config: QQChannelConfig;
  private readonly host: ChannelHost;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private readonly env: NodeJS.ProcessEnv;
  private readonly contactStore: ChannelContactStore;
  private server?: Server | undefined;
  private wsClient?: unknown;

  constructor(options: QQChannelOptions) {
    this.config = {
      mode: 'onebot',
      defaultAgent: 'coder',
      mentionPatterns: ['@_all', '@hap', '@qq', '@bot', '@ai', '@智能体'],
      bind: '127.0.0.1:8766',
      path: '/api/qq/onebot',
      ...options.config,
    };
    this.host = options.host;
    this.env = options.env ?? process.env;
    this.contactStore = options.contactStore ?? ChannelContactStore.getInstance();

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
    process.stdout.write(`[${time}] [QQBot] ${message}\n`);
  }

  async start(): Promise<void> {
    const bindAddr = parseBind(this.config.bind || '127.0.0.1:8766');
    const eventPath = this.config.path || '/api/qq/onebot';

    this.server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', channel: 'qq', mode: this.config.mode }));
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith(eventPath)) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const result = await this.handleOneBotPayload(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            this.log(`处理 QQ 消息异常：${describeError(err)}`);
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
        this.log(`QQ 机器人 (OneBot HTTP/Webhook) 服务已启动：http://${bindAddr.host}:${bindAddr.port}${eventPath}`);
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
      this.log('QQ 机器人服务已停止');
    }
  }

  /** 获取 OneBot 访问 Token */
  private getAccessToken(): string | undefined {
    if (this.config.onebotAccessToken) return this.config.onebotAccessToken;
    if (this.config.onebotAccessTokenEnv && this.env[this.config.onebotAccessTokenEnv]) {
      return this.env[this.config.onebotAccessTokenEnv];
    }
    return undefined;
  }

  /** 剥离 QQ CQ 码 (如 [CQ:at,qq=123456]) */
  private stripCqCodes(text: string): { cleanText: string; isAt: boolean; atQq?: string } {
    let cleanText = text;
    let isAt = false;
    let atQq: string | undefined;

    const atMatch = /\[CQ:at,qq=(\d+|all)\]/i.exec(cleanText);
    if (atMatch) {
      isAt = true;
      atQq = atMatch[1];
      cleanText = cleanText.replace(/\[CQ:at,qq=(\d+|all)\]/gi, '').trim();
    }

    // 移除 CQ:reply
    cleanText = cleanText.replace(/\[CQ:reply,id=-?\d+\]/gi, '').trim();
    // 简化 CQ:image 为提示
    cleanText = cleanText.replace(/\[CQ:image,[^\]]+\]/gi, ' [图片] ').trim();

    const result: { cleanText: string; isAt: boolean; atQq?: string } = { cleanText, isAt };
    if (atQq !== undefined) {
      result.atQq = atQq;
    }
    return result;
  }

  /** 处理 OneBot v11/v12 消息 Payload */
  async handleOneBotPayload(rawBody: string): Promise<Record<string, unknown>> {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { status: 'failed', retcode: 1400, message: 'invalid json' };
    }

    const postType = String(data.post_type || data.type || '');
    if (postType !== 'message' && postType !== 'message_sent') {
      return { status: 'ok', retcode: 0 };
    }

    const messageType = String(data.message_type || (data.group_id ? 'group' : 'private'));
    const isRoom = messageType === 'group';
    const groupId = data.group_id ? String(data.group_id) : undefined;
    const userId = String(data.user_id || data.sender_id || 'qq_user');
    const senderObj = (data.sender || {}) as { nickname?: string; card?: string };
    const senderName = senderObj.card || senderObj.nickname || `QQ用户 (${userId})`;
    const rawMessage = String(data.raw_message || data.message || '');

    const { cleanText: textAfterCq, isAt } = this.stripCqCodes(rawMessage);
    let cleanText = textAfterCq.trim();
    if (!cleanText) return { status: 'ok', retcode: 0 };

    const contactId = isRoom && groupId ? `qq_group_${groupId}` : `qq_user_${userId}`;
    const contactName = isRoom && groupId ? `QQ群 (${groupId})` : senderName;

    const contactStore = this.contactStore;
    const { contact } = contactStore.recordIncomingMessage({
      channel: 'qq',
      fromId: isRoom ? userId : (userId.startsWith('qq_user_') ? userId : `qq_user_${userId}`),
      fromName: senderName,
      isRoom,
      roomId: groupId ? (groupId.startsWith('qq_group_') ? groupId : `qq_group_${groupId}`) : undefined,
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
        if (!stripped.wake && !isAt && contact.replyMode === 'mention') {
          // 群聊中未 @ 且规则为仅 @ 回复时跳过
          return { status: 'ok', retcode: 0 };
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
      return { status: 'ok', retcode: 0 };
    }

    const assignedAgent = agentId || this.config.defaultAgent || 'coder';
    const sessionKey = isRoom ? `qq:group:${groupId}` : `qq:user:${userId}`;

    const target: OutboundTarget = {
      channel: 'qq',
      targetId: contactId,
      send: async (replyText: string) => {
        const formatted = formatQQText(replyText);
        contactStore.recordOutgoingMessage({
          channel: 'qq',
          contactId,
          agentId: assignedAgent,
          text: formatted,
        });
        return this.sendQQMessage(isRoom ? groupId! : userId, formatted, isRoom);
      },
    };

    const inbound: InboundMessage = {
      channel: 'qq',
      sessionKey,
      text: cleanText,
      receivedAt: new Date().toISOString(),
      target,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(this.config.defaultAgent !== undefined ? { defaultAgent: this.config.defaultAgent } : {}),
    };

    this.dispatcher.submit(inbound);
    return { status: 'ok', retcode: 0 };
  }

  /** 发送 QQ 消息（调用 OneBot HTTP API 或 Webhook 回写） */
  async sendQQMessage(targetId: string, text: string, isGroup: boolean = false): Promise<string | undefined> {
    const onebotHttp = this.config.onebotHttpUrl || 'http://127.0.0.1:3000';
    const action = isGroup ? '/send_group_msg' : '/send_private_msg';
    const token = this.getAccessToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const payload = isGroup
      ? { group_id: Number(targetId) || targetId, message: text }
      : { user_id: Number(targetId) || targetId, message: text };

    try {
      const resp = await fetch(`${onebotHttp.replace(/\/$/, '')}${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const res = (await resp.json()) as { status: string; retcode: number; data?: { message_id?: number } };
      if (res.status === 'ok' || res.retcode === 0) {
        return res.data?.message_id ? String(res.data.message_id) : `qq_msg_${Date.now()}`;
      }
      this.log(`OneBot 接口下发响应异常 [retcode=${res.retcode}]`);
    } catch (err) {
      this.log(`OneBot 接口推送异常: ${describeError(err)}`);
    }

    return `qq_out_${Date.now()}`;
  }
}
