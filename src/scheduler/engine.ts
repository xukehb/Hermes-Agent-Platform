import { AgentOrchestrator } from '../agent/index.js';
import { isCronMatch } from './cron-parser.js';
import { ScheduleStore } from './storage.js';
import type { ScheduleJobConfig, ScheduleExecutionRecord } from './types.js';

export interface SchedulerEngineOptions {
  configPath?: string | undefined;
  log?: ((message: string) => void) | undefined;
  onNotify?: ((channel: 'wechat' | 'telegram' | 'logs', title: string, content: string) => Promise<void> | void) | undefined;
}

/** 生成本地时区的调度分钟键，包含日期以避免跨天误去重。 */
export function getSchedulerMinuteKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 判断当前 tick 是否已经在同一分钟执行过。 */
export function shouldRunSchedulerTick(lastKey: string | undefined, now: Date): boolean {
  return lastKey !== getSchedulerMinuteKey(now);
}

/** 调度层在同一分钟内拒绝正在执行的任务，避免长任务重叠。 */
export function shouldStartScheduledJob(lastKey: string | undefined, now: Date, isRunning: boolean): boolean {
  return !isRunning && shouldRunSchedulerTick(lastKey, now);
}

export class SchedulerEngine {
  private static instance: SchedulerEngine;
  private readonly store: ScheduleStore;
  private readonly log: (msg: string) => void;
  private readonly onNotify?: ((channel: 'wechat' | 'telegram' | 'logs', title: string, content: string) => Promise<void> | void) | undefined;
  private readonly configPath?: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly lastExecutedMinuteByJob = new Map<string, string>();
  private readonly runningJobIds = new Set<string>();

  constructor(options: SchedulerEngineOptions = {}) {
    this.store = ScheduleStore.getInstance();
    this.log = options.log || (() => {});
    this.onNotify = options.onNotify;
    this.configPath = options.configPath;
  }

  static getInstance(options?: SchedulerEngineOptions): SchedulerEngine {
    if (!SchedulerEngine.instance) {
      SchedulerEngine.instance = new SchedulerEngine(options);
    }
    return SchedulerEngine.instance;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log('[Scheduler] 智能体 Cron 调度引擎已启动');

    this.timer = setInterval(() => {
      this.checkAndTick();
    }, 20000); // 每 20 秒检查一次当前分钟

    // 立即执行一次 tick 检查
    this.checkAndTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log('[Scheduler] 智能体 Cron 调度引擎已停止');
  }

  private checkAndTick(): void {
    if (!this.running) return;

    const now = new Date();
    const jobs = this.store.listJobs().filter((j) => j.enabled);
    for (const job of jobs) {
      const currentMinuteKey = getSchedulerMinuteKey(now);
      const persistedMinuteKey = job.lastTriggeredAt ? getSchedulerMinuteKey(new Date(job.lastTriggeredAt)) : undefined;
      const lastMinuteKey = this.lastExecutedMinuteByJob.get(job.id) || persistedMinuteKey;
      if (!shouldStartScheduledJob(lastMinuteKey, now, this.runningJobIds.has(job.id))) continue;
      if (isCronMatch(job.cron, now)) {
        this.lastExecutedMinuteByJob.set(job.id, currentMinuteKey);
        this.store.markTriggered(job.id, now.getTime());
        this.log(`[Scheduler] 触发定时任务 [${job.name}] (${job.cron}) -> 智能体 [${job.agent}]`);
        // 异步执行，不阻塞调度循环
        this.executeJob(job).catch((err) => {
          this.log(`[Scheduler] 任务 [${job.name}] 执行异常: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

  }

  async executeJob(job: ScheduleJobConfig): Promise<ScheduleExecutionRecord> {
    if (this.runningJobIds.has(job.id)) {
      throw new Error(`任务 [${job.name}] 正在执行中，拒绝重叠运行`);
    }
    this.runningJobIds.add(job.id);
    const startTime = Date.now();
    this.log(`[Scheduler] 正在执行任务 [${job.name}] (智能体: ${job.agent})...`);

    try {
      const orchestrator = new AgentOrchestrator(this.configPath ? { configPath: this.configPath } : {});
      await orchestrator.loadMcpTools();

      const res = await orchestrator.runTask({
        agentId: job.agent,
        input: job.prompt,
        workspace: job.workspace,
        model: job.model,
        sessionKey: `cron:${job.id}`,
      });

      const finishTime = Date.now();
      const durationMs = finishTime - startTime;
      const output = res.text || (res.status === 'done' ? '（任务执行完成，无输出文本）' : `任务执行状态: ${res.status}`);

      const record = this.store.recordExecution({
        scheduleId: job.id,
        scheduleName: job.name,
        agent: job.agent,
        prompt: job.prompt,
        startedAt: startTime,
        finishedAt: finishTime,
        status: res.status === 'done' ? 'success' : 'failed',
        durationMs,
        output,
        error: res.error,
      });

      if (res.status === 'done') {
        this.log(`[Scheduler] ✓ 任务 [${job.name}] 运行成功 (耗时: ${durationMs}ms)`);
        await this.dispatchNotifications(job, output, 'success');
      } else {
        this.log(`[Scheduler] ✗ 任务 [${job.name}] 运行失败: ${res.error || res.status}`);
        await this.dispatchNotifications(job, `任务执行失败：${res.error || res.status}`, 'failed');
      }

      return record;
    } catch (err) {
      const finishTime = Date.now();
      const durationMs = finishTime - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      const record = this.store.recordExecution({
        scheduleId: job.id,
        scheduleName: job.name,
        agent: job.agent,
        prompt: job.prompt,
        startedAt: startTime,
        finishedAt: finishTime,
        status: 'failed',
        durationMs,
        output: '',
        error: errorMsg,
      });

      this.log(`[Scheduler] ✗ 任务 [${job.name}] 运行失败: ${errorMsg}`);
      await this.dispatchNotifications(job, `任务执行失败：${errorMsg}`, 'failed');

      return record;
    } finally {
      this.runningJobIds.delete(job.id);
    }
  }

  private async dispatchNotifications(job: ScheduleJobConfig, content: string, status: 'success' | 'failed'): Promise<void> {
    const channels = job.notifyChannels || ['logs'];
    const title = `【定时工作流${status === 'success' ? '报告' : '异常报警'}】${job.name}`;
    const formattedContent = `${title}\n- 触发时间: ${new Date().toLocaleString()}\n- 执行智能体: ${job.agent}\n\n${content}`;

    for (const ch of channels) {
      try {
        if (this.onNotify) {
          await this.onNotify(ch, title, formattedContent);
        }
      } catch (err) {
        this.log(`[Scheduler] 推送通知到 [${ch}] 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async runJobNow(id: string): Promise<ScheduleExecutionRecord> {
    const job = this.store.getJob(id);
    if (!job) {
      throw new Error(`未找到定时任务: ${id}`);
    }
    return this.executeJob(job);
  }
}
