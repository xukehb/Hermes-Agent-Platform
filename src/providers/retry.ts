/**
 * 提供商层的重试策略与错误归一化。
 *
 * 为什么需要归一化：openai 与 @anthropic-ai/sdk 抛出的错误对象结构不同
 * （status / statusCode / response.status、headers 是 Headers 或普通对象），
 * 而上层只需要判断两件事——「可恢复 → 退避重试或换模型」「不可恢复 → 终止任务」。
 * 因此在此处一次性收敛为 domain/errors 的 RecoverableError / FatalError。
 *
 * 状态码映射（对应规格 §6 与 FR-PROV-006）：
 * - 429           → PROVIDER_RATE_LIMIT（可恢复，尊重 Retry-After）
 * - 401 / 403     → CONFIG_ENV_MISSING（不可恢复，提示环境变量名）
 * - 404           → MODEL_NOT_FOUND（不可恢复，通常是模型标识写错）
 * - 5xx / 连接错误 → PROVIDER_UNREACHABLE（可恢复）
 * - 其余 4xx       → PROVIDER_UNREACHABLE（不可恢复，多为请求体不合法）
 *
 * 凭据约束（FR-PROV-002）：message 与 context 只引用环境变量名，
 * apiKey 从不进入任何错误对象，因此不需要额外的脱敏器。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { FatalError, HapError, RecoverableError, describeError, readRetryAfterMs, readStatus, readSysCode } from '../domain/index.js';

/** 归入「连接问题」的 Node / undici 系统错误码。 */
const RETRYABLE_SYS_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** 归一化所需的调用上下文。全部字段都会进入 trace，故不含凭据本身。 */
export interface ProviderErrorContext {
  providerId: string;
  model?: string;
  /** 凭据所在的环境变量名，仅用于 401/403 的可操作提示 */
  envKey?: string | undefined;
  /** 出错阶段，便于 trace 区分建流失败与流中断 */
  phase?: 'request' | 'stream' | 'check';
}

/** 判断是否为取消导致的错误。openai SDK 抛 APIUserAbortError，fetch 抛 AbortError。 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && (name === 'AbortError' || name === 'APIUserAbortError' || name === 'TimeoutError')) return true;
  return readSysCode(error) === 'ABORT_ERR';
}

/** 组装进入 trace 的结构化上下文，只保留已定义的键。 */
function toContext(context: ProviderErrorContext, status?: number, sysCode?: string): Record<string, unknown> {
  const record: Record<string, unknown> = { providerId: context.providerId };
  if (context.model !== undefined) record.model = context.model;
  if (context.envKey !== undefined) record.envKey = context.envKey;
  if (context.phase !== undefined) record.phase = context.phase;
  if (status !== undefined) record.status = status;
  if (sysCode !== undefined) record.sysCode = sysCode;
  return record;
}

/** 把任意 SDK 错误映射为平台错误。已是 HapError 的原样返回，避免重复包装丢失上下文。 */
export function normalizeProviderError(error: unknown, context: ProviderErrorContext): HapError {
  if (error instanceof HapError) return error;

  const detail = describeError(error);
  const status = readStatus(error);
  const sysCode = readSysCode(error);
  const base = toContext(context, status, sysCode);
  const where = context.providerId + (context.model === undefined ? '' : '/' + context.model);

  if (isAbortError(error)) {
    return new FatalError('TASK_ABORTED', '请求被取消（' + where + '）：' + detail, {
      userMessage: '任务已取消。',
      context: base,
      cause: error,
    });
  }

  if (status === 429) {
    const retryAfterMs = readRetryAfterMs(error);
    const context429 = retryAfterMs === undefined ? base : { ...base, retryAfterMs };
    return new RecoverableError('PROVIDER_RATE_LIMIT', '提供商限流（' + where + '）：' + detail, {
      userMessage: '模型侧限流，正在退避重试。',
      context: context429,
      cause: error,
    });
  }

  if (status === 401 || status === 403) {
    const hint = context.envKey === undefined ? '该提供商未配置 env_key，请确认端点是否需要凭据' : '请检查环境变量 ' + context.envKey;
    return new FatalError('CONFIG_ENV_MISSING', '提供商拒绝凭据（' + where + '，HTTP ' + String(status) + '）：' + hint, {
      userMessage: '提供商凭据无效：' + hint + '。',
      context: base,
      cause: error,
    });
  }

  if (status === 404) {
    return new FatalError('MODEL_NOT_FOUND', '端点或模型不存在（' + where + '）：' + detail, {
      userMessage: '模型标识在该提供商上不存在，请用 hap provider models 核对。',
      context: base,
      cause: error,
    });
  }

  if (status !== undefined && status >= 500) {
    return new RecoverableError('PROVIDER_UNREACHABLE', '提供商服务端错误（' + where + '，HTTP ' + String(status) + '）：' + detail, {
      userMessage: '提供商暂时不可用，正在重试。',
      context: base,
      cause: error,
    });
  }

  if (status === undefined && sysCode !== undefined && RETRYABLE_SYS_CODES.has(sysCode)) {
    return new RecoverableError('PROVIDER_UNREACHABLE', '连接提供商失败（' + where + '，' + sysCode + '）：' + detail, {
      userMessage: '网络连接失败，正在重试。',
      context: base,
      cause: error,
    });
  }

  if (status === undefined && sysCode === undefined && /fetch failed|network|socket hang up/i.test(detail)) {
    return new RecoverableError('PROVIDER_UNREACHABLE', '连接提供商失败（' + where + '）：' + detail, {
      userMessage: '网络连接失败，正在重试。',
      context: base,
      cause: error,
    });
  }

  return new FatalError('PROVIDER_UNREACHABLE', '请求被提供商拒绝（' + where + (status === undefined ? '' : '，HTTP ' + String(status)) + '）：' + detail, {
    context: base,
    cause: error,
  });
}

/** 退避参数。jitter 可注入，便于测试得到确定值。 */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** 返回 [0, span) 内的抖动量 */
  jitter?: (span: number) => number;
}

/**
 * 计算第 attempt 次重试前的等待时长（attempt 从 1 开始）。
 *
 * 采用「半固定 + 半抖动」的指数退避：base * 2^(attempt-1) 后取一半为固定量，
 * 另一半随机，避免多智能体同时撞同一提供商造成重试潮。
 * 若响应带 Retry-After，则直接尊重该值（上限仍受 capMs 约束）。
 */
export function computeBackoffMs(attempt: number, error?: unknown, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 500;
  const capMs = options.capMs ?? 30_000;
  const retryAfterMs = readRetryAfterMs(error);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, capMs);
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const window = Math.min(baseMs * Math.pow(2, exponent), capMs);
  const jitter = options.jitter ?? ((span: number) => Math.random() * span);
  return Math.round(window / 2 + jitter(window / 2));
}

/** 若已取消则立即抛出 TASK_ABORTED，供各处入口统一使用。 */
export function throwIfAborted(signal: AbortSignal | undefined, what = '任务'): void {
  if (signal?.aborted === true) {
    throw new FatalError('TASK_ABORTED', what + '已被取消', { userMessage: '任务已取消。' });
  }
}

/** 可被取消的等待。取消时抛 TASK_ABORTED，而不是静默返回，避免上层误以为等待成功。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal, '退避等待');
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new FatalError('TASK_ABORTED', '退避等待被取消', { userMessage: '任务已取消。' }));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
