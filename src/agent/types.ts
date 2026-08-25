/**
 * 智能体层公共类型（FR-TASK-001~008、FR-LOOP-*、FR-ROUTE-*）。
 *
 * 这里只放跨模块共享的契约，不放实现。SessionStore 定义在本层而非 storage 层，
 * 是为了让智能体循环依赖抽象接口而不是 SQLite 实现：测试用内存桩替换即可，
 * 也避免 agent → storage 的硬依赖形成循环（storage 需要 agent 的消息类型）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type {
  AgentMessage,
  FinishReason,
  ProtocolName,
  TaskTrace,
  TokenUsage,
  ToolCall,
  ToolResult,
  TraceEvent,
} from '../domain/index.js';
import type { ResolvedAgent, ResolvedPaths } from '../config/index.js';
import type { SubagentSpawner } from '../tools/index.js';

/** 任务状态。与 TaskTrace.status 保持同一套取值，避免两处枚举漂移。 */
export type TaskStatus = TaskTrace['status'];

/** 单轮循环的终止原因。stop 为正常收尾，其余为受限收尾（须告知用户）。 */
export type StopReason = 'stop' | 'max_iterations' | 'fallback_exhausted' | 'aborted';

/**
 * 面向通道的任务事件流。
 *
 * 通道（Telegram / HTTP / CLI）只消费本类型，不接触协议事件与线制事件，
 * 因此新增厂商或协议不会波及通道层。
 */
export type TaskEvent =
  | { type: 'iteration'; index: number }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; result: ToolResult }
  | { type: 'model_switch'; from: string; to: string; reason: string }
  | { type: 'notice'; message: string }
  | { type: 'usage'; usage: TokenUsage };

export type TaskEventSink = (event: TaskEvent) => void;

/** 一次循环的产出。messages 为本次新增的消息（不含入参历史），便于增量落库。 */
export interface LoopResult {
  /** 面向用户的正文 */
  text: string;
  /** 推理段；是否展示由 agent.reasoningVisible 决定（FR-LOOP-005） */
  reasoning: string;
  /** 本次新增的消息序列：assistant 与 tool 交替 */
  messages: AgentMessage[];
  usage: TokenUsage;
  /** 实际使用的工具调用轮数 */
  iterations: number;
  /** 最终生效的 provider/model 全名 */
  model: string;
  protocol: ProtocolName;
  finishReason: FinishReason;
  stopReason: StopReason;
  /** 降级过程中的历史重译次数（FR-LOOP-015） */
  retranslations: number;
}

/** 循环入参。history 须已包含本轮用户消息。 */
export interface LoopRequest {
  agent: ResolvedAgent;
  history: AgentMessage[];
  /** 已组装完成的 system 提示（身份段 + 职责段 + 环境段） */
  systemPrompt: string;
  taskId: string;
  signal: AbortSignal;
  /** 子智能体派生深度，顶层任务为 0（FR-ROUTE-009） */
  depth: number;
  paths: ResolvedPaths;
  env: Record<string, string | undefined>;
  /** 未注入时 spawn_subagent 会以工具错误拒绝（FR-ROUTE-008） */
  spawn?: SubagentSpawner;
  onEvent?: TaskEventSink;
  onTrace?: (event: TraceEvent) => void;
}

/** 任务运行请求（编排层入口）。 */
export interface RunTaskRequest {
  /** 目标智能体；缺省走四级路由（FR-ROUTE-003） */
  agentId?: string;
  /** 用户指令原文 */
  input: string;
  /** 会话键：Telegram 用 chat:<id>，CLI 用 cli:<agent>，子智能体用 sub:<父任务> */
  sessionKey?: string;
  attachments?: AgentMessage['attachments'];
  /** 通道绑定的默认智能体，路由第二优先级 */
  channelDefaultAgent?: string;
  depth?: number;
  /** 外部取消信号，与内部任务信号联动（FR-TASK-003） */
  signal?: AbortSignal;
  onEvent?: TaskEventSink;
}

/** 任务结果。 */
export interface TaskOutcome extends LoopResult {
  taskId: string;
  agentId: string;
  sessionKey: string;
  status: TaskStatus;
  /** 完整 trace 的本地文件路径（FR-TASK-006） */
  tracePath: string;
  /** 失败时的用户可读原因 */
  error?: string;
}

/** 任务持久化记录（FR-TASK-004/007/008）。 */
export interface TaskRow {
  taskId: string;
  agentId: string;
  sessionKey: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  iterations: number;
  usage: TokenUsage;
  /** 最终生效模型全名 */
  model: string;
  title?: string;
  error?: string;
  tracePath?: string;
}

/** 用量明细行（FR-TASK-007 的三个维度）。 */
export interface UsageRow {
  at: string;
  agentId: string;
  providerId: string;
  model: string;
  usage: TokenUsage;
}

/** 用量聚合结果。 */
export interface UsageAggregate {
  agentId: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

/**
 * 会话与任务持久化接口。
 *
 * 全部方法同步：底层是 better-sqlite3（同步 API），包成异步只会带来虚假的并发假象。
 */
export interface SessionStore {
  /** 取会话历史，limit 为条数上限（从最近往前取） */
  history(sessionKey: string, limit?: number): AgentMessage[];
  appendMessages(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void;
  /** 用压缩后的历史整体替换会话（FR-LOOP-013） */
  replaceHistory(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void;
  clearSession(sessionKey: string): void;

  beginTask(row: TaskRow): void;
  updateTask(taskId: string, patch: Partial<TaskRow>): void;
  task(taskId: string): TaskRow | undefined;
  tasksBySession(sessionKey: string, status?: TaskStatus): TaskRow[];
  /** 启动期用于把残留的 running 任务标记为 interrupted（FR-TASK-008） */
  runningTasks(): TaskRow[];

  recordUsage(row: UsageRow): void;
  usageSince(since: string): UsageAggregate[];
  /** 某智能体某日已消耗 token 总量，用于日预算闸门（FR-TASK-007） */
  dailyTokens(agentId: string, day: string): number;

  /** 清理超过保留期的会话数据 */
  prune(retentionDays: number): number;
  close(): void;
}

/** 子智能体派生所需的最小上下文，由编排层注入 loop。 */
export interface SubagentDeps {
  spawner: SubagentSpawner;
}
