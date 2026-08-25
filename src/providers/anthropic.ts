/**
 * Anthropic Messages 线制客户端。
 *
 * 单独成文件而非塞进 openai-compatible 的原因是四处结构性不对称
 * （FR-LOOP-011A）：工具用 input_schema、input 已是对象、工具结果以
 * user 角色的 tool_result 块回灌、max_tokens 必填。前三点由协议适配器
 * 负责，本文件承担第四点与「事件名完全不同的 SSE 流」的翻译。
 *
 * 事件翻译对照：
 * - message_start        → 记录 input_tokens
 * - content_block_start  → tool_use 块开启一个工具调用槽位
 * - content_block_delta  → text_delta / thinking_delta / input_json_delta
 * - content_block_stop   → 结束对应槽位
 * - message_delta        → stop_reason 与累计 output_tokens
 * - message_stop         → 流末尾，补发 usage 与 finish
 *
 * 凭据约束：构造时显式给出 apiKey 与 authToken: null，阻断 SDK 自行读取
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。
 * 否则开发机上遗留的第三方代理变量会静默覆盖配置文件里的端点。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import Anthropic from '@anthropic-ai/sdk';
import { FatalError, RecoverableError, readStatus } from '../domain/index.js';
import type { FinishReason, ProviderCheckResult, ProviderClient, WireApi, WireEvent, WireRequest } from '../domain/index.js';
import type { ResolvedProvider } from '../config/resolved.js';
import { asNumber, asRecord, asString, firstString } from './read.js';
import { computeBackoffMs, normalizeProviderError, sleep } from './retry.js';
import { ToolCallAccumulator, withIdleTimeout } from './stream.js';
import type { ToolCallChunk } from './stream.js';

/** SDK 类型以「反推」方式取得，避免锁死 @anthropic-ai/sdk 的内部导出路径。 */
type AnthropicSdkOptions = NonNullable<ConstructorParameters<typeof Anthropic>[0]>;
type MessageCreateParams = Parameters<Anthropic['messages']['create']>[0];
type MessageRequestOptions = NonNullable<Parameters<Anthropic['messages']['create']>[1]>;
type ModelsListOptions = NonNullable<Parameters<Anthropic['models']['list']>[1]>;

/** models 列举上限，与 openai 兼容客户端保持一致。 */
const MODEL_LIST_CAP = 500;

/** 构造参数。client 可注入，测试用假客户端即可绕过网络。 */
export interface AnthropicClientOptions {
  provider: ResolvedProvider;
  /** 现取现用的凭据；缺省时以占位串阻断 SDK 的凭据自动发现链 */
  apiKey: string | undefined;
  headers?: Record<string, string>;
  client?: Anthropic;
  fetch?: AnthropicSdkOptions['fetch'];
}

/** usage 的两侧读数。Anthropic 把输入放 message_start、输出放 message_delta。 */
interface AnthropicUsageParts {
  prompt: number | undefined;
  completion: number | undefined;
}

export class AnthropicClient implements ProviderClient {
  readonly providerId: string;
  readonly wireApi: WireApi = 'anthropic-messages';
  private readonly provider: ResolvedProvider;
  private readonly client: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.provider = options.provider;
    this.providerId = options.provider.id;
    this.client = options.client ?? new Anthropic(this.clientOptions(options));
  }

  async *send(request: WireRequest, signal?: AbortSignal): AsyncIterable<WireEvent> {
    const maxAttempts = Math.max(0, this.provider.streamMaxRetries) + 1;
    for (let attempt = 1; ; attempt += 1) {
      let emitted = false;
      try {
        for await (const event of this.messageEvents(request, signal)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const normalized = normalizeProviderError(error, {
          providerId: this.providerId,
          model: request.model,
          envKey: this.provider.envKey,
          phase: emitted ? 'stream' : 'request',
        });
        // 已有事件外泄时不能重放：会造成重复正文。交给上层按降级链换模型（FR-LOOP-015）
        if (emitted || attempt >= maxAttempts || !normalized.recoverable) throw normalized;
        await sleep(computeBackoffMs(attempt, error), signal);
      }
    }
  }

  async check(signal?: AbortSignal): Promise<ProviderCheckResult> {
    const started = Date.now();
    try {
      const models = await this.listModels(signal);
      return { providerId: this.providerId, reachable: true, handshakeMs: Date.now() - started, models };
    } catch (error) {
      const status = readStatus(error);
      // 能收到 404/405 说明网络与路由是通的，仅是该端点不提供模型列举
      if (status === 404 || status === 405 || status === 501) {
        return {
          providerId: this.providerId,
          reachable: true,
          handshakeMs: Date.now() - started,
          models: [],
          error: '端点未提供 /models 列举（HTTP ' + String(status) + '），可达性已确认',
        };
      }
      return {
        providerId: this.providerId,
        reachable: false,
        handshakeMs: Date.now() - started,
        models: [],
        error: normalizeProviderError(error, { providerId: this.providerId, envKey: this.provider.envKey, phase: 'check' }).message,
      };
    }
  }

  /** 列举端点模型标识，按字典序返回，最多 MODEL_LIST_CAP 条。 */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const page = await this.client.models.list(undefined, this.modelsListOptions(signal));
    const ids: string[] = [];
    for await (const model of page) {
      const id = asString(asRecord(model)?.id);
      if (id !== undefined) ids.push(id);
      if (ids.length >= MODEL_LIST_CAP) break;
    }
    return ids.sort((left, right) => left.localeCompare(right));
  }

  private clientOptions(options: AnthropicClientOptions): AnthropicSdkOptions {
    const sdkOptions: AnthropicSdkOptions = {
      // 无凭据场景（自建 Anthropic 兼容网关）仍给占位串，避免 SDK 走凭据自动发现
      apiKey: options.apiKey ?? 'not-required',
      authToken: null,
      baseURL: options.provider.baseUrl,
      maxRetries: options.provider.requestMaxRetries,
    };
    const headers = options.headers;
    if (headers !== undefined && Object.keys(headers).length > 0) sdkOptions.defaultHeaders = headers;
    if (options.fetch !== undefined) sdkOptions.fetch = options.fetch;
    return sdkOptions;
  }

  private requestOptions(signal?: AbortSignal): MessageRequestOptions {
    const options: Record<string, unknown> = {};
    if (signal !== undefined) options.signal = signal;
    return options as MessageRequestOptions;
  }

  private modelsListOptions(signal?: AbortSignal): ModelsListOptions {
    const options: Record<string, unknown> = {};
    if (signal !== undefined) options.signal = signal;
    return options as ModelsListOptions;
  }

  /**
   * 组装请求体。params 先展开，保证显式字段不被采样参数覆盖。
   *
   * max_tokens 是 Anthropic 的必填字段，缺失会直接 400。
   * 因此这里以 provider.max_tokens_default 兜底（FR-LOOP-011A 第 4 点）。
   */
  private messageBody(request: WireRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...request.params,
      model: request.model,
      messages: request.messages,
      stream: true,
      max_tokens: request.maxTokens ?? this.provider.maxTokensDefault,
    };
    if (request.system !== undefined && request.system !== '') body.system = request.system;
    if (request.tools !== undefined && request.tools.length > 0) body.tools = request.tools;
    if (request.stop !== undefined && request.stop.length > 0) body.stop_sequences = request.stop;
    return body;
  }

  private async openStream(request: WireRequest, signal?: AbortSignal): Promise<AsyncIterable<Record<string, unknown>>> {
    const stream = await this.client.messages.create(this.messageBody(request) as unknown as MessageCreateParams, this.requestOptions(signal));
    return stream as unknown as AsyncIterable<Record<string, unknown>>;
  }

  /** Messages SSE → WireEvent 翻译。 */
  private async *messageEvents(request: WireRequest, signal?: AbortSignal): AsyncGenerator<WireEvent> {
    const raw = await this.openStream(request, signal);
    const guarded = withIdleTimeout(raw, this.provider.streamIdleTimeoutMs, { providerId: this.providerId, model: request.model });
    const calls = new ToolCallAccumulator();
    /** content_block_start 里带的完整 input（非流式降级形态），仅在没有分片时补发 */
    const blockInputs = new Map<number, string>();
    /** 收到过 input_json_delta 的槽位 */
    const streamedArgs = new Set<number>();
    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;
    let stopReason: string | undefined;

    for await (const chunk of guarded) {
      const type = asString(chunk.type) ?? '';

      if (type === 'message_start') {
        const parts = readAnthropicUsage(asRecord(chunk.message)?.usage);
        if (parts !== undefined) {
          if (parts.prompt !== undefined) promptTokens = parts.prompt;
          if (parts.completion !== undefined) completionTokens = parts.completion;
          sawUsage = true;
        }
        continue;
      }

      if (type === 'content_block_start') {
        const block = asRecord(chunk.content_block);
        if (block !== undefined && asString(block.type) === 'tool_use') {
          const index = asNumber(chunk.index) ?? 0;
          const toolChunk: ToolCallChunk = { index };
          const id = asString(block.id);
          if (id !== undefined) toolChunk.id = id;
          const name = asString(block.name);
          if (name !== undefined) toolChunk.name = name;
          for (const event of calls.ingest(toolChunk)) yield event;
          // 正常流式下这里恒为 {}，参数走 input_json_delta；
          // 少数网关把整体 input 直接放这里且不再发分片，故先缓存、到块结束再判断是否补发
          const input = asRecord(block.input);
          if (input !== undefined && Object.keys(input).length > 0) blockInputs.set(index, JSON.stringify(input));
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const delta = asRecord(chunk.delta);
        const deltaType = asString(delta?.type) ?? '';
        if (deltaType === 'text_delta') {
          const text = asString(delta?.text);
          if (text !== undefined) yield { type: 'text_delta', text };
        } else if (deltaType === 'thinking_delta') {
          const text = asString(delta?.thinking);
          if (text !== undefined) yield { type: 'reasoning_delta', text };
        } else if (deltaType === 'input_json_delta') {
          const partial = asString(delta?.partial_json);
          if (partial !== undefined) {
            const index = asNumber(chunk.index) ?? 0;
            streamedArgs.add(index);
            for (const event of calls.ingest({ index, argsDelta: partial })) yield event;
          }
        }
        // signature_delta（思考签名）与 citations_delta 在下游没有对应语义，忽略
        continue;
      }

      if (type === 'content_block_stop') {
        const index = asNumber(chunk.index) ?? 0;
        if (!streamedArgs.has(index)) {
          const buffered = blockInputs.get(index);
          if (buffered !== undefined) {
            for (const event of calls.ingest({ index, argsDelta: buffered })) yield event;
          }
        }
        for (const event of calls.end(index)) yield event;
        continue;
      }

      if (type === 'message_delta') {
        const reason = asString(asRecord(chunk.delta)?.stop_reason);
        if (reason !== undefined) stopReason = reason;
        const parts = readAnthropicUsage(chunk.usage);
        if (parts !== undefined) {
          if (parts.prompt !== undefined) promptTokens = parts.prompt;
          // output_tokens 是累计值，直接覆盖而不是累加
          if (parts.completion !== undefined) completionTokens = parts.completion;
          sawUsage = true;
        }
        continue;
      }

      if (type === 'error') {
        throw anthropicStreamError(chunk, this.providerId, request.model);
      }
      // message_stop 无需处理：循环自然结束后统一补发 usage 与 finish
    }

    for (const event of calls.flush()) yield event;
    if (sawUsage) {
      yield { type: 'usage', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
    }
    yield { type: 'finish', reason: mapAnthropicStopReason(stopReason, calls.hasCalls) };
  }
}

/**
 * 读取 Anthropic usage。
 *
 * 缓存命中与缓存写入的 token 计入 prompt 侧：它们同样按输入计费，
 * 若忽略会让日预算统计系统性偏低（FR-TASK-007）。
 */
export function readAnthropicUsage(value: unknown): AnthropicUsageParts | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const input = asNumber(record.input_tokens);
  const cacheWrite = asNumber(record.cache_creation_input_tokens);
  const cacheRead = asNumber(record.cache_read_input_tokens);
  const output = asNumber(record.output_tokens);
  if (input === undefined && cacheWrite === undefined && cacheRead === undefined && output === undefined) return undefined;
  const prompt = input === undefined && cacheWrite === undefined && cacheRead === undefined ? undefined : (input ?? 0) + (cacheWrite ?? 0) + (cacheRead ?? 0);
  return { prompt, completion: output };
}

/**
 * stop_reason 映射。
 *
 * hasCalls 参与判定的理由同 chat 线制：部分网关在工具调用轮返回 end_turn，
 * 照搬会让 agent loop 丢掉这一轮工具执行（FR-LOOP-008）。
 * end_turn / stop_sequence / refusal / pause_turn 在无工具调用时一律归为 stop。
 */
export function mapAnthropicStopReason(raw: string | undefined, hasCalls: boolean): FinishReason {
  if (raw === 'tool_use') return 'tool_calls';
  if (raw === 'max_tokens') return 'length';
  return hasCalls ? 'tool_calls' : 'stop';
}

/**
 * 流内 error 事件 → 平台错误。
 *
 * overloaded_error 与 rate_limit_error 是 Anthropic 高峰期的常态，
 * 归为可恢复以走退避重试；其余（invalid_request_error 等）归为致命，
 * 重试只会重复失败。
 */
export function anthropicStreamError(chunk: Record<string, unknown>, providerId: string, model: string): Error {
  const error = asRecord(chunk.error);
  const kind = asString(error?.type) ?? 'unknown_error';
  const detail = firstString(error?.message, chunk.message) ?? '流内未提供错误描述';
  const message = 'Anthropic 流内错误（' + providerId + '/' + model + '，' + kind + '）：' + detail;
  const context = { providerId, model, anthropicErrorType: kind };
  if (kind === 'rate_limit_error') {
    return new RecoverableError('PROVIDER_RATE_LIMIT', message, { userMessage: '模型侧限流，正在退避重试。', context });
  }
  if (kind === 'overloaded_error' || kind === 'api_error' || kind === 'timeout_error') {
    return new RecoverableError('PROVIDER_UNREACHABLE', message, { userMessage: '提供商暂时不可用，正在重试。', context });
  }
  return new FatalError('PROVIDER_UNREACHABLE', message, { context });
}
