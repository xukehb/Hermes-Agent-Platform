/**
 * 工具层公共类型契约（FR-TOOL-001~007）。
 *
 * 设计要点：
 * - ToolModule 把「模型看到的声明」（definition）与「本地执行体」（handler）绑在一起，
 *   注册表只搬运 ToolModule，不关心工具是内置还是来自 MCP 服务器。
 * - 参数校验独立成 validate 而非塞进 handler：executor 需要在校验失败时按 FR-LOOP-009
 *   把错误回灌给模型，而不是抛异常终止 loop。
 * - spawn_subagent 通过 ToolContext.spawn 注入，避免 tools 层反向依赖 agent 层形成循环依赖。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ResolvedAgent, ResolvedPaths } from '../config/resolved.js';
import type { ControlExecutionContext } from '../control-plane/index.js';
import type { TaskExecutionContext } from '../telemetry/index.js';
import type { TokenUsage, ToolDefinition, TraceEvent } from '../domain/index.js';

/** 工具执行的原始产出。isError 为 true 时仍然回灌给模型，由模型决定如何纠正。 */
export interface ToolOutput {
  content: string;
  isError?: boolean;
}

/** 子智能体派生请求（FR-ROUTE-007~009）。 */
export interface SubagentRequest {
  /** 发起方智能体 id */
  parentAgentId: string;
  /** 目标子智能体 id */
  agentId: string;
  task: string;
  context?: string;
  /** 目标子智能体所处深度，根任务为 0 */
  depth: number;
  /** 父任务 id，用于 trace 串联 */
  parentTaskId: string;
  signal: AbortSignal;
}

/** 子智能体执行结果。 */
export interface SubagentOutcome {
  text: string;
  taskId?: string;
  usage?: TokenUsage;
}

/** 由 agent 层注入的派生器。 */
export type SubagentSpawner = (request: SubagentRequest) => Promise<SubagentOutcome>;

/** 工具执行上下文。每次任务构造一次，同一任务内的所有工具调用共享。 */
export interface ToolContext {
  /** 已解析的智能体，提供 workspace（FR-TOOL-004）与 limits（FR-TOOL-005/007） */
  agent: ResolvedAgent;
  paths: ResolvedPaths;
  taskId: string;
  /** 任务级取消信号；executor 会在其上叠加工具级超时 */
  signal: AbortSignal;
  /** 当前智能体所处派生深度，根任务为 0 */
  depth: number;
  env: Record<string, string | undefined>;
  /** 来自已配对 Bot 的可信服务器控制上下文；只能由通道/GUI 后端注入。 */
  control?: ControlExecutionContext | undefined;
  /** Optional one-time approval supplied by a control-plane adapter. */
  approvedRequestId?: string | undefined;
  approvalStore?: {
    createApprovalRequest?(input: {
      id: string;
      bindingId: string;
      operatorId: string;
      requestId: string;
      commandKind: string;
      argsDigest: string;
      risk: string;
      expiresAt: string;
    }): void;
    consumeApproval(input: {
      id: string;
      bindingId: string;
      operatorId: string;
      requestId: string;
      commandKind: string;
      argsDigest: string;
      consumedAt: string;
    }): boolean;
  } | undefined;
  audit?: {
    recordAudit(input: {
      id: string;
      at?: string;
      bindingId?: string | undefined;
      operatorId?: string | undefined;
      requestId?: string | undefined;
      tool: string;
      decision: string;
      detail: string;
    }): void;
  } | undefined;
  executionContext?: TaskExecutionContext | undefined;
  /** 子智能体派生器，未注入时 spawn_subagent 以可恢复错误回灌 */
  spawn?: SubagentSpawner;
  /** trace 回调（FR-TASK-005 的工具调用一栏） */
  onTrace?: (event: TraceEvent) => void;
}

/** 参数校验结果。ok 时返回带默认值的规范化参数。 */
export type ToolValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; issues: string[] };

/** 工具执行体。args 已通过 validate 规范化。 */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;

/** 一个可注册的工具。 */
export interface ToolModule {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** 缺省表示不做本地校验（MCP 工具由服务器侧校验） */
  validate?: (args: Record<string, unknown>) => ToolValidation;
  /** 注入前的原始名称，存在时说明发生过重命名（FR-TOOL-006） */
  renamedFrom?: string;
}

/** 工具来源。内置工具与每个 MCP 服务器各是一个来源。 */
export interface ToolSource {
  id: string;
  list(): Promise<ToolModule[]>;
  close?(): Promise<void>;
}

/** 重命名映射，进入 trace（FR-TOOL-006）。 */
export interface ToolRename {
  from: string;
  to: string;
  source: string;
  /** 触发原因：mcp 前缀注入或同名冲突 */
  reason: 'mcp-namespace' | 'collision';
}
