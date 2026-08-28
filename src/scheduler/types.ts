/**
 * 智能体主动 Cron 工作流调度引擎类型定义。
 */

export interface ScheduleJobConfig {
  id: string;
  name: string;
  cron: string;
  agent: string;
  workspace?: string | undefined;
  model?: string | undefined;
  prompt: string;
  notifyChannels: ('wechat' | 'telegram' | 'logs')[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | undefined;
  lastStatus?: ('success' | 'failed' | 'running') | undefined;
  lastOutput?: string | undefined;
  lastDurationMs?: number | undefined;
}

export interface ScheduleExecutionRecord {
  id: string;
  scheduleId: string;
  scheduleName: string;
  agent: string;
  prompt: string;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'failed';
  durationMs: number;
  output: string;
  error?: string | undefined;
}

export interface ScheduleState {
  jobs: ScheduleJobConfig[];
  history: ScheduleExecutionRecord[];
}
