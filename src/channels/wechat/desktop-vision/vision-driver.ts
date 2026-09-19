import { randomUUID } from 'node:crypto';
import type { ChannelAttachments } from '../../types.js';
import type { WeChatPersonalDriver } from '../../wechat.js';
import { type CapturedWindow, captureWeChatWindow, isWeChatRunning } from './capture.js';
import { type SendReplyOptions, type ActionDriverResult, sendWeChatReply } from './action-driver.js';
import { type WeChatVisionParseResult, type VisionParserOptions, parseWeChatScreen } from './vision-parser.js';

export interface DesktopVisionDriverOptions {
  pollIntervalMs?: number | undefined;
  visionModel?: string | undefined;
  log?: ((line: string) => void) | undefined;
  /** 测试注入函数 */
  captureFn?: (() => Promise<CapturedWindow>) | undefined;
  parseFn?: ((image: Buffer | string, options?: VisionParserOptions | undefined) => Promise<WeChatVisionParseResult>) | undefined;
  sendFn?: ((options: SendReplyOptions) => Promise<ActionDriverResult>) | undefined;
  isWeChatRunningFn?: (() => Promise<boolean>) | undefined;
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

  private readonly captureFn: () => Promise<CapturedWindow>;
  private readonly parseFn: (image: Buffer | string, options?: VisionParserOptions | undefined) => Promise<WeChatVisionParseResult>;
  private readonly sendFn: (options: SendReplyOptions) => Promise<ActionDriverResult>;
  private readonly isWeChatRunningFn: () => Promise<boolean>;

  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private readonly processedFingerprints = new Set<string>();
  private readonly fingerprintHistory: string[] = [];
  private lastActiveTarget: string | undefined;

  constructor(options: DesktopVisionDriverOptions = {}) {
    this.pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? 3000);
    this.visionModel = options.visionModel;
    this.log = options.log ?? (() => undefined);

    this.captureFn = options.captureFn ?? captureWeChatWindow;
    this.parseFn = options.parseFn ?? parseWeChatScreen;
    this.sendFn = options.sendFn ?? sendWeChatReply;
    this.isWeChatRunningFn = options.isWeChatRunningFn ?? isWeChatRunning;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.log('[DesktopVision] 桌面微信视觉代管驱动启动中...');

    // 检查微信客户端进程
    const isRunning = await this.isWeChatRunningFn().catch(() => false);
    if (!isRunning) {
      this.log('[DesktopVision] 提示：未检测到正在运行的微信客户端，请先打开并登录桌面端微信');
    } else {
      this.log('[DesktopVision] 检测到微信桌面客户端已在运行中');
    }

    // SightFlow 模式无需重新扫码，直接接管本地桌面已登录微信
    const loginUser = { id: 'desktop_wechat_host', name: '桌面微信代管 (SightFlow模式)' };
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
    this.onLogout?.('桌面视觉代管驱动已停止');
    this.log('[DesktopVision] 桌面微信视觉代管驱动已安全停止');
  }

  /** 单次视觉扫描与决策处理 (See & Think) */
  async tick(): Promise<void> {
    if (!this.started || this.scanning) return;
    this.scanning = true;

    try {
      // 1. See: 捕获屏幕/微信窗口
      const captured = await this.captureFn();
      if (!captured.ok || (!captured.buffer && !captured.base64)) {
        return;
      }

      // 2. Think: 调用视觉多模态 VLM 分析界面
      const input = captured.buffer || captured.base64!;
      const parseOpts: VisionParserOptions = {};
      if (this.visionModel) {
        parseOpts.model = this.visionModel;
      }
      const parsed = await this.parseFn(input, parseOpts);

      if (!parsed.ok || !parsed.hasWeChatWindow) {
        return;
      }

      if (parsed.chatTarget) {
        this.lastActiveTarget = parsed.chatTarget;
      }

      // 3. 判断是否需要回复来自好友的消息
      if (!parsed.needsReply || !parsed.lastMessage) {
        return;
      }

      const msg = parsed.lastMessage;
      // 我方发送的消息不触发自动回复
      if (msg.isFromMe) {
        return;
      }

      const cleanText = msg.text.trim();
      if (!cleanText) {
        return;
      }

      // 消息去重指纹计算（目标:发送者:消息内容）
      const chatTarget = parsed.chatTarget || msg.sender;
      const fingerprint = `${chatTarget}:${msg.sender}:${cleanText}`;

      if (this.processedFingerprints.has(fingerprint)) {
        // 该条消息此前已经处理过，直接跳过防重复轰炸
        return;
      }

      // 记录去重缓存
      this.addFingerprint(fingerprint);

      this.log(`[DesktopVision] 识别到来自 [${chatTarget}] 的好友新消息: "${cleanText}"`);

      const isRoom = Boolean(parsed.isGroup);
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

    this.log(`[DesktopVision] 准备向 [${targetId}] 执行桌面模拟回复...`);

    // 记录自己的回复到指纹库，防止下一帧巡检误判为对方发来的新消息
    const myReplyFp = `${targetId}:me:${text.trim()}`;
    this.addFingerprint(myReplyFp);

    const result = await this.sendFn({
      targetName: targetId,
      text,
      delayMs: 350,
      restoreFocus: true,
    });

    if (!result.ok) {
      this.log(`[DesktopVision] 消息发送失败: ${result.error}`);
      throw new Error(result.error || '桌面自动化发送微信消息失败');
    }

    this.log(`[DesktopVision] 消息已成功模拟输入并发送给 [${targetId}]`);
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
