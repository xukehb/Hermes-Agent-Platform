/**
 * 微信与企业微信通道（FR-CHAN-003）。
 *
 * 支持四种接入模式：
 * 1) ilink_bot: 个人微信扫码绑定腾讯 iLink Bot 身份。
 * 2) personal: 兼容入口，默认同 ilink_bot；显式配置 service puppet 时走 Wechaty Puppet Service。
 * 3) wecom: 企业微信（WeCom）模式。
 *    企业级免封号方案，支持 Hono 回调服务验证（msg_signature / echostr）与企业微信机器人/应用 API 下发。
 * 4) official_account: 微信公众号（服务号/订阅号）开发者模式。
 *
 * 日期：2026-08-27  执行者：Codex
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { ChannelDispatcher, describeError } from './dispatcher.js';
import { extractMention, stripWakeWord } from './command-parser.js';
import { OutboundSender } from './outbound.js';
import { WeChatContactStore } from './wechat-contacts.js';
import { formatWeChatText, formatWeComMarkdown } from './wechat-formatter.js';
import type { Channel, ChannelAttachments, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { AttachmentKind } from '../domain/index.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths, ResolvedWeChatChannel } from '../config/index.js';
import { ConfigError } from '../domain/index.js';
import { parseBind } from './bind.js';
import { WechatyPersonalDriver } from './wechat/wechaty-personal-driver.js';
import { NativeIlinkPersonalDriver } from './wechat/ilink/index.js';
import { DesktopVisionPersonalDriver, type DesktopVisionActivityEvent } from './wechat/desktop-vision/index.js';
import { recallRelevantMemories } from '../memory/index.js';

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
  onActivity?: ((activity: DesktopVisionActivityEvent) => void) | undefined;
  /** 测试或自定义驱动注入 */
  personalDriverFactory?: PersonalDriverFactory;
  contactStore?: WeChatContactStore;
}

/** 微信通道实现。 */
export class WeChatChannel implements Channel {
  readonly name = 'wechat' as const;

  private readonly options: WeChatChannelOptions;
  private config: ResolvedWeChatChannel;
  private readonly dispatcher: ChannelDispatcher;
  private readonly sender: OutboundSender;
  private readonly charLimit: number;
  private readonly env: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly contactStore: WeChatContactStore;
  private readonly onActivity?: ((activity: DesktopVisionActivityEvent) => void) | undefined;

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
    this.onActivity = options.onActivity;
    this.contactStore = options.contactStore ?? WeChatContactStore.getInstance();
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

  async sendMessage(targetId: string, text: string): Promise<string | undefined> {
    if (!this.personalDriver) {
      throw new Error('微信驱动未运行或未完成扫码登录');
    }
    const formatted = formatWeChatText(text);
    return await this.personalDriver.sendMessage(targetId, formatted);
  }

  /** 热重载微信通道配置（FR-CFG-005） */
  reload(options?: { channels?: ResolvedChannels; limits?: ResolvedLimits }): void {
    if (options?.channels?.wechat) {
      this.config = options.channels.wechat;
      this.log(`[WeChat] 通道配置已热重载，当前默认智能体: ${this.config.defaultAgent || '未指定'}`);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const mode = this.config.mode;
    if (mode === 'personal' || mode === 'ilink_bot') {
      await this.startPersonalMode();
      return;
    }
    if (mode === 'wecom') {
      await this.startWeComMode();
      return;
    }
    if (mode === 'official_account') {
      await this.startOfficialAccountMode();
      return;
    }
    throw new ConfigError('CONFIG_INVALID', `未知的微信通道接入模式: ${mode}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.latestQrText = undefined;
    this.loginUser = undefined;
    const driver = this.personalDriver;
    this.personalDriver = undefined;
    if (driver) {
      await driver.stop();
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
      if (this.config.personal.puppet === 'desktop_vision') {
        return new DesktopVisionPersonalDriver({
          pollIntervalMs: this.config.personal.visionPollIntervalMs,
          visionModel: this.config.personal.visionModel,
          log,
          onActivity: this.onActivity,
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
      if (!this.started || this.personalDriver !== driver) return;
      this.latestQrText = qrText;
      if (this.config.qrLog) {
        this.log(`[WeChat QR] 扫码地址: ${qrText}`);
      }
    };

    driver.onLogin = (user) => {
      if (!this.started || this.personalDriver !== driver) return;
      this.loginUser = user;
      this.log(`[WeChat] 登录成功：${user.name} (${user.id})`);
    };

    driver.onLogout = (reason) => {
      this.loginUser = undefined;
      this.log(`[WeChat] 微信已登出：${reason ?? 'unknown'}`);
    };

    driver.onMessage = async (msg: Parameters<NonNullable<WeChatPersonalDriver['onMessage']>>[0]) => {
      if (!this.started || this.personalDriver !== driver) return;
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

    const contactStore = this.contactStore;
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

    const knownAgents = this.options.host.agentIds ? this.options.host.agentIds() : [];
    const fallbackAgent = knownAgents[0] || 'coder';

    // 联系人绑定属于可回退偏好；仅消息中的 @agent 作为严格的显式选择。
    // 若联系人绑定的 agentId 已不存在于系统，则自动忽略并回退到通道默认智能体
    const validContactAgentId = (!agentId && contact.agentId && (knownAgents.length === 0 || knownAgents.includes(contact.agentId)))
      ? contact.agentId
      : undefined;

    // 人工防撞车冷却检测
    const now = Date.now();
    const inCooldown = (contact.cooldownUntil && contact.cooldownUntil > now) || contact.humanTakenOver;
    if (inCooldown) {
      const remainingSec = contact.cooldownUntil ? Math.max(0, Math.ceil((contact.cooldownUntil - now) / 1000)) : 0;
      this.log(`[WeChat] 联系人 [${contact.name}] 处于人工接管冷却期（剩余 ${remainingSec} 秒），AI 暂不抢话。`);
      this.onActivity?.({
        stage: 'cooldown',
        level: 'warning',
        tag: '人工防撞车',
        title: `联系人【${contact.name}】处于人工接管保护期 (剩余 ${remainingSec}s)`,
        detail: '检测到用户近期正在微信与对方沟通，AI 自动静默避让以防撞车抢答。',
        target: contact.name,
      });
      return;
    }

    // 若联系人关闭了自动回复或处于仅手动监听
    if (contact.hostingMode === 'off' || contact.hostingMode === 'manual' || !contact.autoReply || contact.replyMode === 'manual') {
      this.log(`[WeChat] 联系人 [${contact.name}] 已暂停自动回复，仅记录消息。`);
      this.onActivity?.({
        stage: 'system',
        level: 'info',
        tag: '静默归档',
        title: `联系人【${contact.name}】已暂停自动代答，仅记录消息`,
        detail: `收到的文本: “${cleanText}”`,
        target: contact.name,
      });
      return;
    }

    const defPolicy = contactStore.getDefaultPolicy('wechat');
    const assignedAgent = agentId || validContactAgentId || defPolicy.agentId || this.config.defaultAgent || fallbackAgent;
    const knownAgentList = this.options.host.agentsList ? this.options.host.agentsList() : [];
    const agentObj = knownAgentList.find((a) => a.id === assignedAgent);
    const agentName = agentObj?.displayName || agentObj?.name || (assignedAgent === 'xx' ? '小莹' : assignedAgent);
    const modelName = agentObj?.model || '主语言模型';

    const startTime = Date.now();

    const target: OutboundTarget = {
      channel: 'wechat',
      targetId,
      send: async (text: string) => {
        const formatted = formatWeChatText(text);
        const elapsedMs = Date.now() - startTime;
        const elapsedSec = (elapsedMs / 1000).toFixed(1);

        // 半托管草稿模式：生成回复草稿，不直接对外发送，等待人工审批
        if (contact.hostingMode === 'draft') {
          contactStore.recordOutgoingMessage({
            contactId: targetId,
            agentId: assignedAgent,
            text: formatted,
            isDraft: true,
            draftStatus: 'pending',
            elapsedMs,
          });
          this.log(`[WeChat] 联系人 [${contact.name}] 处于草稿待审模式，回复草稿已记录，待确认后再发。`);
          this.onActivity?.({
            stage: 'draft',
            level: 'warning',
            tag: '半托管草稿',
            title: `已生成半托管待确认草稿 (大模型耗时 ${elapsedSec}s)，等待人工确认`,
            detail: `草稿内容：“${formatted}” | 响应分身: 【${agentName}】 | 模型: ${modelName}`,
            target: contact.name,
            agentId: assignedAgent,
            agentName,
            model: modelName,
            elapsedMs,
          });
          return 'draft_pending';
        }

        // 拟人化打字思考延迟模拟
        const delay = contact.delayMs ?? 2000;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 8000)));
        }

        this.onActivity?.({
          stage: 'generated',
          level: 'success',
          tag: '大模型生成',
          title: `大模型回复生成完毕 (耗时 ${elapsedSec}s) | 准备模拟键鼠发送`,
          detail: `回复内容：“${formatted}” | 响应分身: 【${agentName}】 | 模型: ${modelName}`,
          target: contact.name,
          agentId: assignedAgent,
          agentName,
          model: modelName,
          elapsedMs,
        });

        contactStore.recordOutgoingMessage({
          contactId: targetId,
          agentId: assignedAgent,
          text: formatted,
          isDraft: false,
          elapsedMs,
        });
        if (!this.personalDriver) return undefined;
        try {
          return await this.personalDriver.sendMessage(targetId, formatted);
        } catch (err) {
          this.log(`[WeChat] 出站消息发送至 [${targetId}] 失败: ${describeError(err)}`);
          this.onActivity?.({
            stage: 'system',
            level: 'error',
            tag: '发送失败',
            title: `模拟键鼠发送至【${contact.name}】失败: ${describeError(err)}`,
            target: contact.name,
          });
          throw err;
        }
      },
    };

    const effectiveSystemPrompt = contact.systemPrompt?.trim() || defPolicy.systemPrompt?.trim();
    let finalText = cleanText;
    let recalledCount = 0;
    let recalledTitles: string[] = [];

    if (effectiveSystemPrompt) {
      // 微信即时聊天对话规范：简明扼要、口语化、真人感，通常1~2句话回答完毕，禁止长篇大论、列表说教或输出系统调试信息
      const promptParts: string[] = [];
      const wechatGuideline = [
        '[微信聊天规范：当前为微信好友即时通讯。回答必须口语化、简明自然，像真人朋友微信聊天一样（通常1~2句话内说清楚即可）。]',
        '[切忌长篇大论、罗列列表或撰写提纲，禁止输出系统指令或调试信息。直接以本人身份给出得体亲切的回复。]',
      ].join('\n');
      promptParts.push(wechatGuideline);
      if (effectiveSystemPrompt.includes('\n') || effectiveSystemPrompt.startsWith('#')) {
        promptParts.push([
          '========================================',
          '【专属分身人设、语气风格与行为规范 (Markdown 规范文档)】',
          '========================================',
          effectiveSystemPrompt,
          '========================================',
        ].join('\n'));
      } else {
        promptParts.push(`[专属人设指令：${effectiveSystemPrompt}]`);
      }

      // 智能体跨会话长期记忆检索 (Recall Relevant Memories)
      try {
        const memoryBlock = await recallRelevantMemories(cleanText, contact.workspace, assignedAgent);
        if (memoryBlock?.trim()) {
          promptParts.push(memoryBlock.trim());
          const matches = memoryBlock.match(/【(.*?)】/g);
          if (matches) {
            recalledTitles = matches.map((m) => m.replace(/【|】/g, ''));
            recalledCount = matches.length;
          } else {
            recalledCount = 1;
          }
        }
      } catch {
        // 容错：记忆库检索异常不阻断主流程
      }

      finalText = `${promptParts.join('\n\n')}\n\n对方发来：“${cleanText}”`;
    }

    this.onActivity?.({
      stage: 'thinking',
      level: 'info',
      tag: '大模型调用',
      title: `调起分身【${agentName}】思考回复 | 模型: ${modelName}`,
      detail: `目标会话: 【${contact.name}】 | 基因库: ${recalledCount > 0 ? `已召回 ${recalledCount} 条专属记忆 (${recalledTitles.join(', ')})` : '暂无特定匹配记忆'} | 人设: ${effectiveSystemPrompt ? '已注入专属分身口吻' : '自然口语模板'}`,
      target: contact.name,
      agentId: assignedAgent,
      agentName,
      model: modelName,
    });

    const effectiveDefaultAgent = validContactAgentId || defPolicy.agentId || this.config.defaultAgent || fallbackAgent;

    const effectiveAgentId = agentId || validContactAgentId || defPolicy.agentId;

    const inbound: InboundMessage = {
      channel: 'wechat',
      sessionKey,
      text: finalText,
      receivedAt: new Date().toISOString(),
      target,
      ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
      ...(effectiveAgentId !== undefined ? { agentId: effectiveAgentId } : {}),
      ...(effectiveDefaultAgent !== undefined ? { defaultAgent: effectiveDefaultAgent } : {}),
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
            const formatted = formatWeComMarkdown(text);
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                msgtype: 'markdown',
                markdown: { content: formatted },
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
        const formatted = formatWeChatText(text);
        this.log(`[WeChat OA] 回复用户 [${fromUser}]: ${formatted.slice(0, 50)}...`);
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
