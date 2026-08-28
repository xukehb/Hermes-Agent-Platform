import { randomUUID } from 'node:crypto';

export interface PendingApproval {
  id: string;
  userId: string;
  agent: string;
  action: string;
  reason?: string | undefined;
  createdAt: number;
  expiresAt: number;
  resolve: (approved: boolean) => void;
}

export class WeChatApprovalManager {
  private static instance: WeChatApprovalManager;
  private readonly pending = new Map<string, PendingApproval>(); // key: userId

  static getInstance(): WeChatApprovalManager {
    if (!WeChatApprovalManager.instance) {
      WeChatApprovalManager.instance = new WeChatApprovalManager();
    }
    return WeChatApprovalManager.instance;
  }

  hasPendingApproval(userId: string): boolean {
    const item = this.pending.get(userId);
    if (!item) return false;
    if (Date.now() > item.expiresAt) {
      this.pending.delete(userId);
      item.resolve(false);
      return false;
    }
    return true;
  }

  /**
   * 创建一个等待用户审批的高危操作。
   */
  async requestApproval(input: {
    userId: string;
    agent: string;
    action: string;
    reason?: string | undefined;
    timeoutSeconds?: number | undefined;
  }): Promise<{ promptText: string; waitPromise: Promise<boolean> }> {
    const id = `appr_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
    const timeout = (input.timeoutSeconds ?? 180) * 1000;
    const expiresAt = Date.now() + timeout;

    let resolver: (approved: boolean) => void = () => {};
    const waitPromise = new Promise<boolean>((resolve) => {
      resolver = resolve;
    });

    const item: PendingApproval = {
      id,
      userId: input.userId,
      agent: input.agent,
      action: input.action,
      reason: input.reason,
      createdAt: Date.now(),
      expiresAt,
      resolve: resolver,
    };

    this.pending.set(input.userId, item);

    // 自动超时定时器
    setTimeout(() => {
      if (this.pending.get(input.userId)?.id === id) {
        this.pending.delete(input.userId);
        resolver(false);
      }
    }, timeout);

    const promptText = [
      `🛡️ 【智能体高危操作审批请求】`,
      `• 执行智能体: [${input.agent}]`,
      `• 申请执行操作: ${input.action}`,
      input.reason ? `• 操作原因: ${input.reason}` : '',
      ``,
      `👉 请在 3 分钟内回复:`,
      `  [ 1 ] 🟢 批准执行`,
      `  [ 2 ] 🔴 拒绝拦截`,
    ].filter(Boolean).join('\n');

    return { promptText, waitPromise };
  }

  /**
   * 处理用户的回复。如果命中审批，返回处理结果提示语；否则返回 null。
   */
  handleUserReply(userId: string, replyText: string): { handled: boolean; approved?: boolean; replyNotice?: string } {
    const item = this.pending.get(userId);
    if (!item) return { handled: false };

    if (Date.now() > item.expiresAt) {
      this.pending.delete(userId);
      item.resolve(false);
      return { handled: true, approved: false, replyNotice: '⏰ 审批请求已超时（已默认拒绝拦截）。' };
    }

    const clean = replyText.trim().toLowerCase();

    // 批准关键词: 1, y, yes, 同意, 批准, 允许, ok
    if (['1', 'y', 'yes', '同意', '批准', '允许', 'ok', '确认'].includes(clean)) {
      this.pending.delete(userId);
      item.resolve(true);
      return { handled: true, approved: true, replyNotice: '🟢 已收到您的授权批准，智能体继续执行操作！' };
    }

    // 拒绝关键词: 2, n, no, 拒绝, 拦截, 取消, 不行
    if (['2', 'n', 'no', '拒绝', '拦截', '取消', '不行', '驳回'].includes(clean)) {
      this.pending.delete(userId);
      item.resolve(false);
      return { handled: true, approved: false, replyNotice: '🔴 已收到您的指令，已安全拦截并终止该高危操作。' };
    }

    return {
      handled: true,
      replyNotice: '⚠️ 当前有正在等待审批的高危操作，请回复 [1] 批准 或 [2] 拒绝。',
    };
  }
}
