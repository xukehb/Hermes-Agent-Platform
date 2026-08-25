/**
 * 错误分类：规格 §6 的两分法在类型系统中的落地。
 *
 * - RecoverableError：以 <tool_response> 或提示形式回灌模型/用户后继续。
 * - FatalError：终止当前任务并保留 trace。
 *
 * 约束：错误消息中不得出现 API Key（FR-PROV-002），构造消息时只引用 env 变量名。
 *
 * 日期：2026-08-24  执行者：Codex
 */

/** 错误码。与 §6 错误处理表逐行对应，便于测试断言与 trace 聚合。 */
export type HapErrorCode =
  | 'CONFIG_PARSE'
  | 'CONFIG_INVALID'
  | 'CONFIG_ENV_MISSING'
  | 'CONFIG_CONFLICT'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_STREAM_IDLE'
  | 'FALLBACK_EXHAUSTED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_INVALID_ARGS'
  | 'TOOL_FAILED'
  | 'TOOL_TIMEOUT'
  | 'TAG_UNCLOSED'
  | 'MAX_ITERATIONS'
  | 'CONTEXT_OVERFLOW'
  | 'SUBAGENT_FORBIDDEN'
  | 'SUBAGENT_DEPTH'
  | 'BUDGET_EXHAUSTED'
  | 'AGENT_NOT_FOUND'
  | 'MODEL_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'TASK_ABORTED'
  | 'CHANNEL_DISCONNECTED';

/** 平台错误基类。code 决定 §6 表格中的处置分支。 */
export abstract class HapError extends Error {
  abstract readonly recoverable: boolean;
  readonly code: HapErrorCode;
  /** 面向用户的中文提示；缺省时由通道层按 code 生成 */
  readonly userMessage?: string;
  /** 结构化上下文，进入 trace */
  readonly context: Record<string, unknown>;

  constructor(code: HapErrorCode, message: string, options?: { userMessage?: string; context?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.context = options?.context ?? {};
    if (options?.userMessage !== undefined) this.userMessage = options.userMessage;
  }
}

/** 可恢复错误：回灌后继续。 */
export class RecoverableError extends HapError {
  readonly recoverable = true;
}

/** 不可恢复错误：终止任务并保留 trace。 */
export class FatalError extends HapError {
  readonly recoverable = false;
}

/** 配置类错误统一走启动期中止路径，输出「文件 + 键路径 + 期望 + 实际」四元组（FR-CFG-004）。 */
export class ConfigError extends FatalError {
  constructor(code: HapErrorCode, message: string, context?: Record<string, unknown>) {
    super(code, message, { userMessage: message, context: context ?? {} });
  }
}

/** 判断错误是否值得重试（FR-PROV-006）：429、5xx、连接中断三类。 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HapError) {
    return error.code === 'PROVIDER_RATE_LIMIT' || error.code === 'PROVIDER_UNREACHABLE' || error.code === 'PROVIDER_STREAM_IDLE';
  }
  const status = readStatus(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  const code = readSysCode(error);
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ENOTFOUND' || code === 'UND_ERR_SOCKET';
}

/** 从各 SDK 抛出的错误对象中提取 HTTP 状态码。 */
export function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  const response = record.response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** 提取 Node 系统级错误码（含被 SDK 包装一层的场景）。 */
export function readSysCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  const cause = record.cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** 读取 429 响应中的 Retry-After（秒），供退避使用（§6 限流行）。 */
export function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const headers = (error as Record<string, unknown>).headers;
  if (headers === undefined || headers === null) return undefined;
  let raw: unknown;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    raw = (headers as { get: (name: string) => unknown }).get('retry-after');
  } else if (typeof headers === 'object') {
    raw = (headers as Record<string, unknown>)['retry-after'];
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** 归一化错误消息，用于 trace 与用户提示。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}
