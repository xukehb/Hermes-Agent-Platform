import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ScheduleJobConfig, ScheduleExecutionRecord, ScheduleState } from './types.js';

const DATA_PATH = join(homedir(), '.hap', 'schedules.json');

function ensureDir(): void {
  const dir = dirname(DATA_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class ScheduleStore {
  private static instance: ScheduleStore;
  private readonly filePath: string;

  private constructor(filePath: string = DATA_PATH) {
    this.filePath = filePath;
  }

  static getInstance(filePath?: string): ScheduleStore {
    if (!ScheduleStore.instance) {
      ScheduleStore.instance = new ScheduleStore(filePath);
    }
    return ScheduleStore.instance;
  }

  load(): ScheduleState {
    ensureDir();
    if (!existsSync(this.filePath)) {
      return { jobs: [], history: [] };
    }
    try {
      const text = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(text) as Partial<ScheduleState>;
      return {
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        history: Array.isArray(data.history) ? data.history : [],
      };
    } catch {
      return { jobs: [], history: [] };
    }
  }

  save(state: ScheduleState): void {
    ensureDir();
    writeFileSync(this.filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  listJobs(): ScheduleJobConfig[] {
    return this.load().jobs;
  }

  getJob(id: string): ScheduleJobConfig | undefined {
    return this.listJobs().find((j) => j.id === id);
  }

  upsertJob(input: Partial<ScheduleJobConfig> & { name: string; cron: string; prompt: string }): ScheduleJobConfig {
    const state = this.load();
    const now = Date.now();
    const id = input.id || `sched_${now.toString(36)}_${randomUUID().slice(0, 4)}`;

    const existingIdx = state.jobs.findIndex((j) => j.id === id);
    const existing = existingIdx >= 0 ? state.jobs[existingIdx] : undefined;

    const job: ScheduleJobConfig = {
      id,
      name: input.name.trim(),
      cron: input.cron.trim(),
      agent: input.agent || 'coder',
      workspace: input.workspace?.trim(),
      model: input.model?.trim(),
      prompt: input.prompt.trim(),
      notifyChannels: input.notifyChannels && input.notifyChannels.length > 0 ? input.notifyChannels : ['logs'],
      enabled: input.enabled !== undefined ? input.enabled : true,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      lastRunAt: existing?.lastRunAt,
      lastStatus: existing?.lastStatus,
      lastOutput: existing?.lastOutput,
      lastDurationMs: existing?.lastDurationMs,
    };

    if (existingIdx >= 0) {
      state.jobs[existingIdx] = job;
    } else {
      state.jobs.push(job);
    }

    this.save(state);
    return job;
  }

  removeJob(id: string): boolean {
    const state = this.load();
    const initialLen = state.jobs.length;
    state.jobs = state.jobs.filter((j) => j.id !== id);
    if (state.jobs.length !== initialLen) {
      this.save(state);
      return true;
    }
    return false;
  }

  toggleJob(id: string, enabled?: boolean): ScheduleJobConfig | undefined {
    const state = this.load();
    const job = state.jobs.find((j) => j.id === id);
    if (!job) return undefined;

    job.enabled = enabled !== undefined ? enabled : !job.enabled;
    job.updatedAt = Date.now();
    this.save(state);
    return job;
  }

  recordExecution(record: Omit<ScheduleExecutionRecord, 'id'>): ScheduleExecutionRecord {
    const state = this.load();
    const fullRecord: ScheduleExecutionRecord = {
      id: `exec_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`,
      ...record,
    };

    // 更新 Job 的状态
    const job = state.jobs.find((j) => j.id === record.scheduleId);
    if (job) {
      job.lastRunAt = record.finishedAt;
      job.lastStatus = record.status;
      job.lastOutput = record.output;
      job.lastDurationMs = record.durationMs;
      job.updatedAt = Date.now();
    }

    // 保留最近 200 条执行历史
    state.history.unshift(fullRecord);
    if (state.history.length > 200) {
      state.history = state.history.slice(0, 200);
    }

    this.save(state);
    return fullRecord;
  }

  getHistory(scheduleId?: string, limit: number = 50): ScheduleExecutionRecord[] {
    const state = this.load();
    let list = state.history;
    if (scheduleId) {
      list = list.filter((h) => h.scheduleId === scheduleId);
    }
    return list.slice(0, limit);
  }
}
