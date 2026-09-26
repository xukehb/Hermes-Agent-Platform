import { randomUUID } from 'node:crypto';
import type { ChannelAttachments } from '../../types.js';
import type { WeChatPersonalDriver } from '../../wechat.js';
import { type CapturedWindow, captureWeChatWindow, isWeChatRunning } from './capture.js';
import { type SendReplyOptions, type ActionDriverResult, sendWeChatReply } from './action-driver.js';
import { type WeChatVisionParseResult, type VisionParserOptions, parseWeChatScreen } from './vision-parser.js';
import { checkImagesDiff, isTextSentByMe, type ImageDiffResult } from './ocr-parser.js';
import { normalizeContactName, isGarbageContactName, ChannelContactStore } from '../../contacts-store.js';

export interface DesktopVisionActivityEvent {
  stage: 'detected' | 'thinking' | 'generated' | 'executing' | 'sent' | 'cooldown' | 'draft' | 'system' | 'scan';
  level: 'info' | 'success' | 'warning' | 'error';
  tag: string;
  title: string;
  detail?: string | undefined;
  target?: string | undefined;
  sender?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  model?: string | undefined;
  elapsedMs?: number | undefined;
}

export interface DesktopVisionDriverOptions {
  pollIntervalMs?: number | undefined;
  visionModel?: string | undefined;
  log?: ((line: string) => void) | undefined;
  onActivity?: ((activity: DesktopVisionActivityEvent) => void) | undefined;
  /** 测试注入函数 */
  captureFn?: (() => Promise<CapturedWindow>) | undefined;
  parseFn?: ((image: Buffer | string, options?: VisionParserOptions | undefined) => Promise<WeChatVisionParseResult>) | undefined;
  sendFn?: ((options: SendReplyOptions) => Promise<ActionDriverResult>) | undefined;
  isWeChatRunningFn?: (() => Promise<boolean>) | undefined;
  checkDiffFn?: ((img1: Buffer | string, img2: Buffer | string) => Promise<ImageDiffResult>) | undefined;
}

/**
 * 桌面微信视觉代管驱动 (SightFlow 模式)
 *
 * 通过 抓屏 (See) -> 多模态 VLM 理解 (Think) -> 桌面键鼠自动化 (Do)
 * 零侵入、免微信封号风险，真实实现好友收发消息与智能体回复。
 */
export class DesktopVisionPersonalDriver implements WeChatPersonalDriver {
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

  private readonly pollIntervalMs: number;
  private readonly visionModel: string | undefined;
  private readonly log: (line: string) => void;
  private readonly onActivity?: ((activity: DesktopVisionActivityEvent) => void) | undefined;

  private readonly captureFn: () => Promise<CapturedWindow>;
  private readonly parseFn: (image: Buffer | string, options?: VisionParserOptions | undefined) => Promise<WeChatVisionParseResult>;
  private readonly sendFn: (options: SendReplyOptions) => Promise<ActionDriverResult>;
  private readonly isWeChatRunningFn: () => Promise<boolean>;
  private readonly checkDiffFn: (img1: Buffer | string, img2: Buffer | string) => Promise<ImageDiffResult>;

  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private readonly processedFingerprints = new Set<string>();
  private readonly fingerprintHistory: string[] = [];
  private readonly recentSentTexts = new Set<string>();
  private readonly recentSentList: string[] = [];
  private chatBaselineBuffer: Buffer | undefined;
  private lastSentTimestamp = 0;
  private lastActiveTarget: string | undefined;
  private readonly targetCoordsMap = new Map<string, [number, number]>();

  constructor(options: DesktopVisionDriverOptions = {}) {
    this.pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? 3000);
    this.visionModel = options.visionModel;
    this.log = options.log ?? (() => undefined);
    this.onActivity = options.onActivity;

    this.captureFn = options.captureFn ?? captureWeChatWindow;
    this.parseFn = options.parseFn ?? parseWeChatScreen;
    this.sendFn = options.sendFn ?? sendWeChatReply;
    this.isWeChatRunningFn = options.isWeChatRunningFn ?? isWeChatRunning;
    this.checkDiffFn = options.checkDiffFn ?? checkImagesDiff;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.log('[DesktopVision] 桌面微信视觉代管驱动启动中...');
    this.onActivity?.({
      stage: 'system',
      level: 'info',
      tag: '静默巡检',
      title: '桌面微信视觉代管驱动已就绪，正在后台静默巡检微信来信...',
    });

    // 检查微信客户端进程
    const isRunning = await this.isWeChatRunningFn().catch(() => false);
    if (!isRunning) {
      this.log('[DesktopVision] 提示：未检测到正在运行的微信客户端，请先打开并登录桌面端微信');
    } else {
      this.log('[DesktopVision] 检测到微信桌面客户端已在运行中');
    }

    // SightFlow 模式无需重新扫码，直接接管本地桌面已登录微信
    const loginUser = {
      id: 'desktop_wechat_host',
      name: isRunning ? '桌面微信 (SightFlow 已接管桌面客户端)' : '桌面微信 (SightFlow 等待打开客户端)',
    };
    this.onLogin?.(loginUser);

    // 启动视觉巡检轮询循环
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);

    // 立即执行一次探测
    await this.tick();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.scanning = false;
    this.processedFingerprints.clear();
    this.fingerprintHistory.length = 0;
    this.recentSentTexts.clear();
    this.recentSentList.length = 0;
    this.chatBaselineBuffer = undefined;
    this.lastSentTimestamp = 0;
    this.onLogout?.('桌面视觉代管驱动已停止');
    this.log('[DesktopVision] 桌面微信视觉代管驱动已安全停止');
  }

  /** 单次视觉扫描与决策处理 (See & Think) */
  async tick(): Promise<void> {
    if (!this.started || this.scanning) return;

    // 刚刚发送过消息且未建立基线时，微信 UI 正在执行动画，暂停扫描避免竞争
    if (!this.chatBaselineBuffer && this.lastSentTimestamp > 0 && Date.now() - this.lastSentTimestamp < 2000) {
      return;
    }

    this.scanning = true;

    try {
      // 1. See: 捕获屏幕/微信窗口
      const captured = await this.captureFn();
      if (!captured.ok || (!captured.buffer && !captured.base64)) {
        return;
      }

      // 1.1 像素基线比对 (SightFlow 模式核心防护)：
      // 若聊天视窗像素与回复后建立的基线高度一致 (无新气泡出现)，直接跳过耗费资源的 OCR / VLM
      if (this.chatBaselineBuffer && captured.buffer) {
        const diff = await this.checkDiffFn(this.chatBaselineBuffer, captured.buffer);
        if (!diff.hasDiff) {
          // 聊天视窗无新气泡出现，跳过本轮分析，彻底杜绝误读自己绿色气泡
          return;
        }
        // 检测到有真实变化 (新消息到来或切换了窗口)，清除基线以触发后续解析
        this.chatBaselineBuffer = undefined;
      }

      // 2. Think: 调用视觉多模态 / macOS 原生 OCR 分析界面
      const input = captured.buffer || captured.base64!;
      const parseOpts: VisionParserOptions = {
        knownSentTexts: this.recentSentTexts,
      };
      if (this.visionModel) {
        parseOpts.model = this.visionModel;
      }
      const parsed = await this.parseFn(input, parseOpts);

      if (!parsed.ok || !parsed.hasWeChatWindow) {
        return;
      }

      if (parsed.chatTarget) {
        const normTarget = normalizeContactName(parsed.chatTarget) || parsed.chatTarget;
        if (isGarbageContactName(normTarget)) {
          return;
        }
        if (parsed.chatTargetCoords) {
          this.targetCoordsMap.set(parsed.chatTarget, parsed.chatTargetCoords);
          this.targetCoordsMap.set(normTarget, parsed.chatTargetCoords);
        }
        if (!parsed.chatTargetCoords) {
          this.lastActiveTarget = normTarget;
        }
      }

      // 3. 检查是否有最后一条消息 (来自好友 或 来自我方/用户)
      if (!parsed.lastMessage) {
        return;
      }

      const msg = parsed.lastMessage;
      const cleanText = msg.text.trim();
      if (!cleanText) {
        return;
      }

      const rawTarget = parsed.chatTarget || msg.sender;
      const chatTarget = normalizeContactName(rawTarget) || rawTarget;
      if (isGarbageContactName(chatTarget)) {
        this.log(`[DesktopVision] 忽略伪目标/非好友目标: "${chatTarget}"`);
        return;
      }

      // 4. 我方发送的消息处理 (人工回复感知与防撞车保护)
      if (msg.isFromMe) {
        // 检查是否为 AI 最近发送的回复
        const isSentByAI =
          isTextSentByMe(cleanText, this.recentSentTexts) ||
          this.recentSentTexts.has(cleanText) ||
          this.recentSentTexts.has(msg.text);

        if (isSentByAI) {
          // AI 刚发出的消息，忽略巡检
          return;
        }

        // 核心突破：如果不是 AI 刚刚发送的，则是用户【人类机主】在微信客户端主动发送/回复的消息！
        const humanFp = `human:${chatTarget}:${cleanText}`;
        if (!this.processedFingerprints.has(humanFp)) {
          this.addFingerprint(humanFp);
          this.recentSentTexts.add(cleanText);

          this.log(`[DesktopVision] 识别到用户人工向【${chatTarget}】发送了微信消息: "${cleanText}"`);

          // 1. 同步记录到联系人历史库中，sender 标记为 'human'
          const contactStore = ChannelContactStore.getInstance();
          contactStore.recordOutgoingMessage({
            channel: 'wechat',
            contactId: chatTarget,
            sender: 'human',
            text: cleanText,
          });

          // 2. 触发人工接管防撞车冷却期 (默认 10 分钟或联系人设定值)
          const contact = contactStore.findContact(chatTarget, 'wechat');
          const cooldownMinutes = contact?.cooldownMinutes ?? 10;
          if (contact) {
            contact.cooldownUntil = Date.now() + cooldownMinutes * 60 * 1000;
            contact.humanTakenOver = false;
            contactStore.upsertContact(contact);
          }

          // 3. 上报 live feed
          this.onActivity?.({
            stage: 'cooldown',
            level: 'warning',
            tag: '人工回复',
            title: `检测到用户人工回复【${chatTarget}】：“${cleanText}”`,
            detail: `已将消息记录为人工发出，并启动 ${cooldownMinutes} 分钟人工防撞车冷却保护，AI 自动避让静默。`,
            target: chatTarget,
          });
        }
        return;
      }

      // 5. 判断是否需要回复来自好友的消息
      if (!parsed.needsReply) {
        return;
      }

      // 严格检查是否为最近由我方 AI 或用户发送过的文本，防止回音与死循环
      const isEchoOfSent =
        isTextSentByMe(cleanText, this.recentSentTexts) ||
        this.recentSentTexts.has(cleanText) ||
        this.recentSentTexts.has(msg.text);
      if (isEchoOfSent) {
        this.log(`[DesktopVision] 忽略我方刚刚发送的回复文本片段回音: "${cleanText}"`);
        return;
      }

      // 消息去重指纹计算（目标:发送者:消息内容，以及纯内容指纹）
      const fingerprints = [
        `${chatTarget}:${msg.sender}:${cleanText}`,
        `${chatTarget}:${cleanText}`,
      ];

      if (fingerprints.some((fp) => this.processedFingerprints.has(fp))) {
        // 该条消息此前已经处理过，直接跳过防重复轰炸
        return;
      }

      // 记录去重缓存
      for (const fp of fingerprints) {
        this.addFingerprint(fp);
      }

      this.log(`[DesktopVision] 识别到来自 [${chatTarget}] 的好友新消息: "${cleanText}"`);
      const isRoom = Boolean(parsed.isGroup);
      this.onActivity?.({
        stage: 'detected',
        level: 'info',
        tag: '微信来信',
        title: `识别到来自【${chatTarget}】的新消息：“${cleanText}”`,
        detail: `判定: 需要智能体代答 | 发送者: ${msg.sender || chatTarget} | 目标类型: ${isRoom ? `群聊 (${chatTarget})` : '好友私聊'}`,
        target: chatTarget,
        sender: msg.sender || chatTarget,
      });
      const msgId = `dv_${Date.now()}_${randomUUID().slice(0, 8)}`;

      // 派发入站消息给平台上层（触发智能体思考与决策流）
      if (isRoom && chatTarget) {
        await this.onMessage?.({
          id: msgId,
          fromId: chatTarget,
          fromName: msg.sender || chatTarget,
          isRoom: true,
          roomId: chatTarget,
          roomName: chatTarget,
          text: cleanText,
        });
      } else {
        await this.onMessage?.({
          id: msgId,
          fromId: chatTarget,
          fromName: msg.sender || chatTarget,
          isRoom: false,
          text: cleanText,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`[DesktopVision] 视觉分析循环异常: ${errorMsg}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * 发送回复消息 (Do: 键鼠动作执行)
   */
  async sendMessage(targetId: string, text: string): Promise<string | undefined> {
    if (!text || text.trim() === '') {
      return undefined;
    }

    const cleanSent = text.trim();
    this.log(`[DesktopVision] 准备向 [${targetId}] 执行桌面模拟回复...`);
    this.onActivity?.({
      stage: 'executing',
      level: 'warning',
      tag: '动作模拟',
      title: `准备模拟键鼠操作聚焦微信窗口，向【${targetId}】键入回复...`,
      detail: `待发送文本 (${cleanSent.length} 字): “${cleanSent.slice(0, 80)}${cleanSent.length > 80 ? '...' : ''}”`,
      target: targetId,
    });

    // 记录自己的回复到文本指纹库，防止下一帧巡检误判为对方发来的新消息
    this.recentSentTexts.add(cleanSent);
    this.recentSentList.push(cleanSent);
    const sentLines = cleanSent.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of sentLines) {
      if (line.length >= 2) {
        this.recentSentTexts.add(line);
        this.recentSentList.push(line);
      }
      if (line.length > 8) {
        const tail = line.slice(-8).trim();
        if (tail) {
          this.recentSentTexts.add(tail);
          this.recentSentList.push(tail);
        }
      }
    }
    while (this.recentSentList.length > 200) {
      const oldest = this.recentSentList.shift();
      if (oldest) this.recentSentTexts.delete(oldest);
    }
    this.lastSentTimestamp = Date.now();

    const myReplyFp1 = `${targetId}:me:${cleanSent}`;
    const myReplyFp2 = `${targetId}:${targetId}:${cleanSent}`;
    const myReplyFp3 = `${targetId}:${cleanSent}`;
    this.addFingerprint(myReplyFp1);
    this.addFingerprint(myReplyFp2);
    this.addFingerprint(myReplyFp3);

    const targetCoords = this.targetCoordsMap.get(targetId) || this.targetCoordsMap.get(normalizeContactName(targetId));
    const switchToTarget = Boolean(targetCoords || (this.lastActiveTarget && this.lastActiveTarget !== targetId));

    const result = await this.sendFn({
      targetName: targetId,
      targetCoords,
      switchToTarget,
      text,
      delayMs: 350,
      restoreFocus: true,
    });

    if (!result.ok) {
      this.log(`[DesktopVision] 消息发送失败: ${result.error}`);
      this.onActivity?.({
        stage: 'system',
        level: 'error',
        tag: '动作异常',
        title: `桌面模拟发送给【${targetId}】失败: ${result.error || '执行异常'}`,
        target: targetId,
      });
      throw new Error(result.error || '桌面自动化发送微信消息失败');
    }

    this.lastActiveTarget = targetId;
    this.lastSentTimestamp = Date.now();
    this.log(`[DesktopVision] 消息已成功模拟输入并发送给 [${targetId}]`);
    this.onActivity?.({
      stage: 'sent',
      level: 'success',
      tag: '发送成功',
      title: `消息已成功模拟键入并发送至微信会话【${targetId}】！`,
      detail: `完整内容: “${cleanSent}”`,
      target: targetId,
    });

    // 记录刚刚发送后的屏幕基线快照 (SightFlow 模式)
    // 等待 450ms 让微信 UI 渲染绿色气泡完成
    await new Promise((resolve) => setTimeout(resolve, 450));
    try {
      const baselineCapture = await this.captureFn();
      if (baselineCapture?.buffer) {
        this.chatBaselineBuffer = baselineCapture.buffer;
        this.log(`[DesktopVision] 已更新聊天视窗像素基线快照 (SightFlow 模式)`);
      }
    } catch {
      // 忽略基线快照捕获异常
    }

    return `out_${Date.now()}_${randomUUID().slice(0, 6)}`;
  }

  /** 维护有限长度的去重指纹滑动窗口 */
  private addFingerprint(fp: string): void {
    this.processedFingerprints.add(fp);
    this.fingerprintHistory.push(fp);
    if (this.fingerprintHistory.length > 500) {
      const oldest = this.fingerprintHistory.shift();
      if (oldest) this.processedFingerprints.delete(oldest);
    }
  }

  async syncContacts(): Promise<{ contacts: number; rooms: number; syncedAt: number }> {
    return {
      contacts: 1,
      rooms: 0,
      syncedAt: Date.now(),
    };
  }
}
