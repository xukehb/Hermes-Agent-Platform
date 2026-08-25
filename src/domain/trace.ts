/**
 * 结构化 trace 事件定义（FR-TASK-005）。
 *
 * trace 必须覆盖七类信息：配置生效来源、路由决策层级、协议适配选择、
 * 每轮请求耗时、每次工具调用的入参摘要与耗时、模型切换事件、token 用量。
 * 下面的事件联合类型与这七项逐一对应，缺一项即视为 FR-TASK-005 未满足。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ProtocolName, TokenUsage } from './types.js';

/** 配置键的生效来源层级（FR-CFG-002 的六层） */
export type ConfigLayer = 'cli' | 'env' | 'agent' | 'profile' | 'defaults' | 'builtin';

/** 路由命中层级（FR-ROUTE-003 的四级） */
export type RouteLayer = 'explicit' | 'channel-binding' | 'capability' | 'global-default';

/**
 * 协议来源层级（FR-LOOP-012 的探测继承链）。
 * model-explicit 为实现补充层：模型条目自身声明的 protocol 属于显式配置，
 * 排在名称启发式之前，理由见 protocol/detect.ts 的说明。
 */
export type ProtocolSource =
  | 'agent-explicit'
  | 'model-explicit'
  | 'model-name-hermes'
  | 'provider-default'
  | 'global-default';

export type TraceEvent =
  | { kind: 'config'; at: string; key: string; value: unknown; layer: ConfigLayer }
  | { kind: 'route'; at: string; agentId: string; layer: RouteLayer; detail?: string }
  | { kind: 'protocol'; at: string; protocol: ProtocolName; source: ProtocolSource; model: string }
  | { kind: 'request'; at: string; providerId: string; model: string; protocol: ProtocolName; iteration: number; durationMs: number; usage?: TokenUsage }
  | { kind: 'tool'; at: string; name: string; argsDigest: string; durationMs: number; isError: boolean; truncated: boolean }
  | { kind: 'model-switch'; at: string; from: string; to: string; reason: string; retranslations: number }
  | { kind: 'usage'; at: string; providerId: string; model: string; usage: TokenUsage }
  | { kind: 'note'; at: string; message: string; data?: Record<string, unknown> };

/** 一次任务的完整 trace。 */
export interface TaskTrace {
  taskId: string;
  agentId: string;
  sessionKey: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';
  events: TraceEvent[];
  /** 落盘的完整 trace 文件路径（FR-TASK-006 需回复该路径） */
  filePath?: string;
}

/** 生成入参摘要：仅保留键名与标量值的截断形态，避免 trace 膨胀与凭据外泄。 */
export function digestArgs(args: Record<string, unknown>, maxLength = 200): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    parts.push(key + '=' + summarizeValue(value));
  }
  const joined = parts.join(', ');
  return joined.length > maxLength ? joined.slice(0, maxLength) + '…' : joined;
}

function summarizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 60 ? JSON.stringify(value.slice(0, 60)) + '…' : JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.length + ' items]';
  if (typeof value === 'object') return '{' + Object.keys(value as object).length + ' keys}';
  return typeof value;
}
