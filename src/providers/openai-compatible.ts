/**
 * OpenAI 兼容客户端：一份实现覆盖 chat 与 responses 两条线制。
 *
 * 覆盖的提供商（预置八家中的七家）：deepseek、openai、zhipu、gemini、
 * openrouter、nous、ollama。它们的差异全部落在配置里（base_url / env_key /
 * wire_api / default_protocol），代码层零分支——这是 FR-PROV-001「新增提供商
 * 只改配置」得以成立的前提。
 *
 * 两条线制的取舍：openai 官方端点默认走 responses（推理模型的
 * reasoning summary 只在该端点下发），其余兼容端点走 chat。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import OpenAI from 'openai';
import { RecoverableError, describeError, readStatus } from '../domain/index.js';
import type { FinishReason, ProviderCheckResult, ProviderClient, TokenUsage, WireApi, WireEvent, WireRequest } from '../domain/index.js';
import type { ResolvedProvider } from '../config/resolved.js';
import { asNumber, asRecord, asString, firstString, readChatUsage, readContentText, readToolCallChunks } from './read.js';
import { computeBackoffMs, normalizeProviderError, sleep } from './retry.js';
import { ToolCallAccumulator, withIdleTimeout } from './stream.js';

/** SDK 参数类型以「反推」方式取得，避免锁死 openai 包的内部导出路径。 */
type OpenAiClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;
type ChatCreateParams = Parameters<OpenAI['chat']['completions']['create']>[0];
type ChatRequestOptions = NonNullable<Parameters<OpenAI['chat']['completions']['create']>[1]>;
type ResponsesCreateParams = Parameters<OpenAI['responses']['create']>[0];
type ModelsListOptions = NonNullable<Parameters<OpenAI['models']['list']>[0]>;

/** provider models 列举上限，防止某些代理返回上万条把终端刷爆。 */
const MODEL_LIST_CAP = 500;

/** 构造参数。client 可注入，测试用假客户端即可绕过网络。 */
export interface OpenAiCompatibleClientOptions {
  provider: ResolvedProvider;
  /** 现取现用的凭据；无凭据端点（Ollama）传 undefined */
  apiKey: string | undefined;
  headers?: Record<string, string>;
  client?: OpenAI;
  fetch?: OpenAiClientOptions['fetch'];
}

export class OpenAiCompatibleClient implements ProviderClient {
  readonly providerId: string;
  /** 'chat' 或 'responses'；anthropic-messages 由 AnthropicClient 承接，不会进到这里 */
  readonly wireApi: WireApi;
  private readonly provider: ResolvedProvider;
  private readonly client: OpenAI;
  /**
   * 是否支持 stream_options.include_usage。
   * 首次遇到 400 且报文提及 stream_options 时置 false 并当场重试一次，
   * 之后该实例不再发送该参数（部分兼容端点未实现此扩展）。
   */
  private streamUsageSupported = true;

  constructor(options: OpenAiCompatibleClientOptions) {
    this.provider = options.provider;
    this.providerId = options.provider.id;
    this.wireApi = options.provider.wireApi === 'responses' ? 'responses' : 'chat';
    this.client = options.client ?? new OpenAI(this.clientOptions(options));
  }

  async *send(request: WireRequest, signal?: AbortSignal): AsyncIterable<WireEvent> {
    const maxAttempts = Math.max(0, this.provider.streamMaxRetries) + 1;
    for (let attempt = 1; ; attempt += 1) {
      let emitted = false;
      try {
        const source = this.wireApi === 'responses' ? this.responsesEvents(request, signal) : this.chatEvents(request, signal);
        for await (const event of source) {
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
    const page = await this.client.models.list(this.modelsListOptions(signal));
    const ids: string[] = [];
    for await (const model of page) {
      const id = asString(asRecord(model)?.id);
      if (id !== undefined) ids.push(id);
      if (ids.length >= MODEL_LIST_CAP) break;
    }
    return ids.sort((left, right) => left.localeCompare(right));
  }

  private clientOptions(options: OpenAiCompatibleClientOptions): OpenAiClientOptions {
    const clientOptions: OpenAiClientOptions = {
      // 无凭据端点仍需占位串，SDK 会拒绝空值；该串不会被服务端校验
      apiKey: options.apiKey ?? 'not-required',
      baseURL: options.provider.baseUrl,
      maxRetries: options.provider.requestMaxRetries,
    };
    const headers = options.headers;
    if (headers !== undefined && Object.keys(headers).length > 0) clientOptions.defaultHeaders = headers;
    if (options.fetch !== undefined) clientOptions.fetch = options.fetch;
    return clientOptions;
  }

  private requestOptions(signal?: AbortSignal): ChatRequestOptions {
    const options: Record<string, unknown> = {};
    if (signal !== undefined) options.signal = signal;
    return options as ChatRequestOptions;
  }

  private modelsListOptions(signal?: AbortSignal): ModelsListOptions {
    const options: Record<string, unknown> = {};
    if (signal !== undefined) options.signal = signal;
    return options as ModelsListOptions;
  }

  /** chat 线制请求体。params 先展开，保证显式字段不被采样参数覆盖。 */
  private chatBody(request: WireRequest, includeUsage: boolean): Record<string, unknown> {
    const messages = [...request.messages];
    // chat 线制没有顶层 system；适配器若把系统提示放在 system 字段，这里前置为消息，避免静默丢失
    if (request.system !== undefined && request.system !== '') {
      messages.unshift({ role: 'system', content: request.system });
    }
    const body: Record<string, unknown> = { ...request.params, model: request.model, messages, stream: true };
    if (request.tools !== undefined && request.tools.length > 0) body.tools = request.tools;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.stop !== undefined && request.stop.length > 0) body.stop = request.stop;
    if (includeUsage) body.stream_options = { include_usage: true };
    return body;
  }

  /** responses 线制请求体。该端点无 stop 参数，hermes-native 的收束由标签解析器负责。 */
  private responsesBody(request: WireRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { ...request.params, model: request.model, input: request.messages, stream: true };
    if (request.system !== undefined && request.system !== '') body.instructions = request.system;
    if (request.tools !== undefined && request.tools.length > 0) body.tools = request.tools;
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
    return body;
  }

  private async openChatStream(request: WireRequest, signal?: AbortSignal): Promise<AsyncIterable<Record<string, unknown>>> {
    const options = this.requestOptions(signal);
    try {
      const stream = await this.client.chat.completions.create(this.chatBody(request, this.streamUsageSupported) as unknown as ChatCreateParams, options);
      return stream as unknown as AsyncIterable<Record<string, unknown>>;
    } catch (error) {
      if (this.streamUsageSupported && mentionsStreamOptions(error)) {
        this.streamUsageSupported = false;
        const retried = await this.client.chat.completions.create(this.chatBody(request, false) as unknown as ChatCreateParams, options);
        return retried as unknown as AsyncIterable<Record<string, unknown>>;
      }
      throw error;
    }
  }

  private async openResponsesStream(request: WireRequest, signal?: AbortSignal): Promise<AsyncIterable<Record<string, unknown>>> {
    const stream = await this.client.responses.create(this.responsesBody(request) as unknown as ResponsesCreateParams, this.requestOptions(signal));
    return stream as unknown as AsyncIterable<Record<string, unknown>>;
  }

  /**
   * chat 线制事件映射。
   *
   * finish 事件刻意推迟到流末尾发出：带 include_usage 的最后一个 chunk
   * 在 finish_reason 之后才携带 usage，若立刻发 finish，下游会看到
   * 「finish 之后还有 usage」的乱序。
   */
  private async *chatEvents(request: WireRequest, signal?: AbortSignal): AsyncGenerator<WireEvent> {
    const raw = await this.openChatStream(request, signal);
    const guarded = withIdleTimeout(raw, this.provider.streamIdleTimeoutMs, { providerId: this.providerId, model: request.model });
    const calls = new ToolCallAccumulator();
    let rawFinish: string | undefined;
    let usage: TokenUsage | undefined;
    for await (const chunk of guarded) {
      const parsedUsage = readChatUsage(chunk.usage);
      if (parsedUsage !== undefined) usage = parsedUsage;
      const choices = chunk.choices;
      const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
      if (choice === undefined) continue;
      // delta 是流式字段；message 是少数代理在退化为非流式响应时的形态
      const delta = asRecord(choice.delta) ?? asRecord(choice.message);
      if (delta !== undefined) {
        const reasoning = firstString(delta.reasoning_content, delta.reasoning, delta.thinking);
        if (reasoning !== undefined) yield { type: 'reasoning_delta', text: reasoning };
        const content = readContentText(delta.content);
        if (content !== '') yield { type: 'text_delta', text: content };
        for (const toolChunk of readToolCallChunks(delta.tool_calls)) {
          for (const event of calls.ingest(toolChunk)) yield event;
        }
      }
      const finish = asString(choice.finish_reason);
      if (finish !== undefined && rawFinish === undefined) rawFinish = finish;
    }
    for (const event of calls.flush()) yield event;
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', reason: mapChatFinishReason(rawFinish, calls.hasCalls) };
  }

  /** responses 线制事件映射。事件名以 SSE 的 type 字段为准。 */
  private async *responsesEvents(request: WireRequest, signal?: AbortSignal): AsyncGenerator<WireEvent> {
    const raw = await this.openResponsesStream(request, signal);
    const guarded = withIdleTimeout(raw, this.provider.streamIdleTimeoutMs, { providerId: this.providerId, model: request.model });
    const calls = new ToolCallAccumulator();
    /** 记录哪些槽位收到过参数分片，用于在 output_item.done 时判断是否需要补发整体参数 */
    const streamedArgs = new Set<number>();
    let finish: FinishReason | undefined;
    let usage: TokenUsage | undefined;
    for await (const chunk of guarded) {
      const type = asString(chunk.type) ?? '';
      if (type === 'response.output_text.delta') {
        const text = asString(chunk.delta);
        if (text !== undefined) yield { type: 'text_delta', text };
        continue;
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        const text = asString(chunk.delta);
        if (text !== undefined) yield { type: 'reasoning_delta', text };
        continue;
      }
      if (type === 'response.output_item.added') {
        const item = asRecord(chunk.item);
        if (item !== undefined && asString(item.type) === 'function_call') {
          const index = asNumber(chunk.output_index) ?? 0;
          const toolChunk: import('./stream.js').ToolCallChunk = { index };
          const id = firstString(item.call_id, item.id);
          if (id !== undefined) toolChunk.id = id;
          const name = asString(item.name);
          if (name !== undefined) toolChunk.name = name;
          for (const event of calls.ingest(toolChunk)) yield event;
        }
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const delta = asString(chunk.delta);
        if (delta !== undefined) {
          const index = asNumber(chunk.output_index) ?? 0;
          streamedArgs.add(index);
          for (const event of calls.ingest({ index, argsDelta: delta })) yield event;
        }
        continue;
      }
      if (type === 'response.output_item.done') {
        const item = asRecord(chunk.item);
        if (item !== undefined && asString(item.type) === 'function_call') {
          const index = asNumber(chunk.output_index) ?? 0;
          // 未收到过分片说明该端点只在 done 里给完整参数，此时补发一次，否则会得到空参数
          if (!streamedArgs.has(index)) {
            const args = asString(item.arguments);
            if (args !== undefined) for (const event of calls.ingest({ index, argsDelta: args })) yield event;
          }
          for (const event of calls.end(index)) yield event;
        }
        continue;
      }
      if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        const response = asRecord(chunk.response);
        const parsedUsage = readChatUsage(response?.usage);
        if (parsedUsage !== undefined) usage = parsedUsage;
        if (type === 'response.completed') finish = calls.hasCalls ? 'tool_calls' : 'stop';
        else if (type === 'response.incomplete') finish = 'length';
        else finish = 'error';
        continue;
      }
      if (type === 'error') {
        const message = firstString(chunk.message, asRecord(chunk.error)?.message) ?? '响应流报告未知错误';
        throw new RecoverableError('PROVIDER_UNREACHABLE', 'responses 流内错误（' + this.providerId + '）：' + message, {
          context: { providerId: this.providerId, model: request.model },
        });
      }
    }
    for (const event of calls.flush()) yield event;
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', reason: finish ?? (calls.hasCalls ? 'tool_calls' : 'stop') };
  }
}

/**
 * chat 线制 finish_reason 映射。
 *
 * hasCalls 参与判定的原因：zhipu、ollama 等端点在返回工具调用时
 * 仍给 finish_reason=stop，若照搬会让 agent loop 误判为对话结束、
 * 丢掉这一轮工具执行（FR-LOOP-008）。
 */
export function mapChatFinishReason(raw: string | undefined, hasCalls: boolean): FinishReason {
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool_calls';
  if (raw === 'length' || raw === 'max_tokens') return 'length';
  if (raw === 'error') return 'error';
  return hasCalls ? 'tool_calls' : 'stop';
}

/** 判定 400 是否由 stream_options 不被支持引起。 */
export function mentionsStreamOptions(error: unknown): boolean {
  if (readStatus(error) !== 400) return false;
  return /stream_options/i.test(describeError(error));
}
