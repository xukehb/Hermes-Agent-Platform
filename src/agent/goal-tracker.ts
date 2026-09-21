/**
 * 目标模式（Goal Mode）状态与里程碑追踪器。
 *
 * 负责目标规划的生命周期管理、子里程碑状态机运转、进度百分比计算
 * 以及向图形界面 (GUI) 和终端 (CLI) 提供格式化的 Markdown 与事件模型。
 */

export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type GoalStatus = 'planning' | 'in_progress' | 'evaluating' | 'completed' | 'failed' | 'aborted';

export interface GoalMilestone {
  id: string;
  title: string;
  description?: string | undefined;
  status: MilestoneStatus;
  result?: string | undefined;
  updatedAt: string;
}

export interface GoalLogEntry {
  timestamp: string;
  note: string;
  milestoneId?: string | undefined;
}

export interface GoalPlan {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  progress: number;
  milestones: GoalMilestone[];
  currentMilestoneId?: string | undefined;
  logs: GoalLogEntry[];
  summary?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export class GoalTracker {
  private plan: GoalPlan;

  constructor(title: string, description = '') {
    const now = new Date().toISOString();
    this.plan = {
      id: 'goal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      title: title.trim(),
      description: description.trim(),
      status: 'planning',
      progress: 0,
      milestones: [],
      logs: [{ timestamp: now, note: '目标初始化：' + title.trim() }],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 初始化或重置里程碑清单 */
  setMilestones(items: Array<{ id?: string | undefined; title: string; description?: string | undefined }>): GoalPlan {
    const now = new Date().toISOString();
    this.plan.milestones = items.map((item, index) => ({
      id: item.id || 'm-' + (index + 1),
      title: item.title.trim(),
      ...(item.description ? { description: item.description.trim() } : {}),
      status: index === 0 ? 'in_progress' : 'pending',
      updatedAt: now,
    }));
    if (this.plan.milestones.length > 0) {
      this.plan.status = 'in_progress';
      this.plan.currentMilestoneId = this.plan.milestones[0]?.id;
    }
    this.recalculateProgress();
    this.plan.updatedAt = now;
    this.addLog('已规划 ' + this.plan.milestones.length + ' 个核心里程碑');
    return this.getPlan();
  }

  /** 更新指定里程碑状态 */
  updateMilestone(id: string, status: MilestoneStatus, result?: string): GoalPlan {
    const target = this.plan.milestones.find((m) => m.id === id || m.title === id);
    if (!target) {
      throw new Error('未找到 ID 或标题为 "' + id + '" 的里程碑');
    }

    const now = new Date().toISOString();
    target.status = status;
    if (result !== undefined) {
      target.result = result;
    }
    target.updatedAt = now;

    // 自动流转当前进行中的里程碑
    if (status === 'completed') {
      const nextPending = this.plan.milestones.find((m) => m.status === 'pending');
      if (nextPending) {
        nextPending.status = 'in_progress';
        nextPending.updatedAt = now;
        this.plan.currentMilestoneId = nextPending.id;
      } else {
        this.plan.currentMilestoneId = undefined;
      }
    } else if (status === 'in_progress') {
      this.plan.currentMilestoneId = target.id;
    }

    this.recalculateProgress();
    this.plan.updatedAt = now;
    this.addLog('里程碑 [' + target.title + '] 状态变更为: ' + status + (result ? ' (' + result + ')' : ''), target.id);
    return this.getPlan();
  }

  /** 记录单步思考或阶段性进展笔记 */
  addLog(note: string, milestoneId?: string): void {
    const entry: GoalLogEntry = {
      timestamp: new Date().toISOString(),
      note: note.trim(),
      ...(milestoneId ? { milestoneId } : {}),
    };
    this.plan.logs.push(entry);
    if (this.plan.logs.length > 100) {
      this.plan.logs = this.plan.logs.slice(-100);
    }
  }

  /** 标记整个目标圆满达成 */
  complete(summary: string): GoalPlan {
    const now = new Date().toISOString();
    for (const m of this.plan.milestones) {
      if (m.status !== 'completed' && m.status !== 'failed') {
        m.status = 'completed';
        m.updatedAt = now;
      }
    }
    this.plan.status = 'completed';
    this.plan.progress = 100;
    this.plan.summary = summary.trim();
    this.plan.currentMilestoneId = undefined;
    this.plan.updatedAt = now;
    this.addLog('🎉 目标达成：' + summary.trim());
    return this.getPlan();
  }

  /** 标记目标受阻失败 */
  fail(reason: string): GoalPlan {
    const now = new Date().toISOString();
    this.plan.status = 'failed';
    this.plan.summary = '未达成：' + reason.trim();
    this.plan.updatedAt = now;
    this.addLog('❌ 目标终止：' + reason.trim());
    return this.getPlan();
  }

  /** 重新计算目标整体进度百分比 */
  private recalculateProgress(): void {
    if (this.plan.milestones.length === 0) {
      this.plan.progress = this.plan.status === 'completed' ? 100 : 0;
      return;
    }
    const completedCount = this.plan.milestones.filter((m) => m.status === 'completed').length;
    const inProgressCount = this.plan.milestones.filter((m) => m.status === 'in_progress').length;
    const rawProgress = Math.round(((completedCount + inProgressCount * 0.4) / this.plan.milestones.length) * 100);
    this.plan.progress = Math.min(100, Math.max(0, rawProgress));
    if (completedCount === this.plan.milestones.length) {
      this.plan.status = 'completed';
      this.plan.progress = 100;
    }
  }

  /** 获取当前计划深拷贝 */
  getPlan(): GoalPlan {
    return JSON.parse(JSON.stringify(this.plan)) as GoalPlan;
  }

  /** 输出优雅的 Markdown 进度展示卡片 */
  toMarkdown(): string {
    const statusEmoji: Record<MilestoneStatus, string> = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      failed: '❌',
    };

    const statusBadge: Record<GoalStatus, string> = {
      planning: '🎯 规划中',
      in_progress: '⚡ 执行中',
      evaluating: '🔍 验收中',
      completed: '🎉 已达成',
      failed: '❌ 未完成',
      aborted: '🛑 已中止',
    };

    const progressBar = this.renderProgressBar(this.plan.progress);
    const lines: string[] = [
      '### 🎯 目标执行状态：' + (this.plan.title || '当前任务'),
      '',
      '- **当前阶段**：`' + statusBadge[this.plan.status] + '`  |  **总进度**：`' + this.plan.progress + '%`',
      '- **进度条**：' + progressBar,
      '',
      '**里程碑规划与达成情况**：',
    ];

    if (this.plan.milestones.length === 0) {
      lines.push('*（尚在制定子里程碑计划中...）*');
    } else {
      for (const m of this.plan.milestones) {
        const isCurrent = m.id === this.plan.currentMilestoneId;
        const pointer = isCurrent ? ' 👉 ' : ' ';
        const titleText = isCurrent ? '**' + m.title + '** *(当前执行)*' : m.title;
        lines.push(pointer + statusEmoji[m.status] + ' `' + m.id + '` ' + titleText);
        if (m.result) {
          lines.push('    └─ 💡 结果: ' + m.result);
        }
      }
    }

    if (this.plan.summary) {
      lines.push('', '> **总结与交付产物**：' + this.plan.summary);
    }

    return lines.join('\n');
  }

  private renderProgressBar(percent: number): string {
    const totalBars = 12;
    const filled = Math.round((percent / 100) * totalBars);
    const empty = Math.max(0, totalBars - filled);
    return '`[' + '█'.repeat(filled) + '░'.repeat(empty) + ']` ' + percent + '%';
  }
}
