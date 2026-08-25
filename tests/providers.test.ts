/**
 * 提供商层测试：事件归一化、重试退避、闸门、注册表。
 *
 * 覆盖 FR-PROV-001（线制分派与配置化提供商）、FR-PROV-002 / FR-PROV-003（凭据现取现用）、
 * FR-PROV-006（重试与错误分级）、FR-PROV-007（流式空闲看护）、
 * FR-ROUTE-006（并发与限速闸门）、FR-LOOP-008（finish_reason 校正）、
 * FR-LOOP-011A（Anthropic 四处不对称中的 max_tokens 必填与事件翻译）、FR-TASK-007（usage 统计）。
 *
 * 全部用例离线运行：真实 SDK 一律以注入的假客户端替换，环境变量一律用自造对象，
 * 绝不透传 process.env，避免开发机上的第三方端点变量干扰断言。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { describe, expect, it } from 'vitest';
import {
  AnthropicClient,
  GateRegistry,
  GatedProviderClient,
  MockProviderClient,
  OpenAiCompatibleClient,
  ProviderRegistry,
  RateGate,
  ToolCallAccumulator,
  agentGateRegistry,
  anthropicStreamError,
  collectWireEvents,
  computeBackoffMs,
  defaultProviderFactory,
  errorTurn,
  isAbortError,
  mapAnthropicStopReason,
  mapChatFinishReason,
  mentionsStreamOptions,
  normalizeProviderError,
  providerGateRegistry,
  readAnthropicUsage,
  readChatUsage,
  readToolCallChunks,
  textOfWireEvents,
  textTurn,
  toolCallTurn,
  withIdleTimeout,
  type AnthropicClientOptions,
  type GateClock,
  type OpenAiCompatibleClientOptions,
  type ProviderFactory,
  type ProviderFactoryContext,
} from '../src/providers/index.js';
import { HapError } from '../src/domain/index.js';
import type { HapErrorCode, WireEvent, WireRequest } from '../src/domain/index.js';
import type { ResolvedLimits, ResolvedProvider } from '../src/config/resolved.js';

/** 最小可用的提供商定义，按需覆盖字段。 */
function makeProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'test',
    name: 'Test',
    baseUrl: 'https://example.invalid/v1',
    envKey: 'TEST_API_KEY',
    wireApi: 'chat',
    defaultProtocol: 'openai-tools',
    httpHeaders: {},
    envHttpHeaders: {},
    requestMaxRetries: 0,
    streamMaxRetries: 0,
    // 默认关闭空闲看护，避免用例受真实计时器影响；看护本身有专门用例
    streamIdleTimeoutMs: 0,
    maxTokensDefault: 4096,
    ...overrides,
  };
}

/** 最小可用的 limits，闸门用例只关心并发与限速四个字段。 */
function makeLimits(overrides: Partial<ResolvedLimits> = {}): ResolvedLimits {
  return {
    maxIterations: 20,
    maxSubagentDepth: 2,
    toolTimeoutMs: 60_000,
    toolOutputMaxBytes: 65_536,
    compactThreshold: 0.8,
    dailyTokenBudget: 0,
    sessionRetentionDays: 30,
    ingressQueueSize: 100,
    providerConcurrency: {},
    providerRpm: {},
    agentConcurrency: {},
    agentRpm: {},
    defaultProviderConcurrency: 4,
    defaultAgentConcurrency: 2,
    ...overrides,
  };
}

/** 最小可用的线上请求。 */
function makeRequest(overrides: Partial<WireRequest> = {}): WireRequest {
  return { model: 'demo-model', messages: [{ role: 'user', content: 'hi' }], params: {}, ...overrides };
}

/** 把数组变成异步流，模拟 SSE 逐条到达。 */
async function* streamOf<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

/** 让出一次宏任务，用于观察排队状态。 */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 取末位元素；不用 Array.prototype.at 以免依赖 lib 版本。 */
function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/** 捕获异步抛错。顺利完成时反而抛错，避免「预期失败却静默通过」。 */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出错误，但调用顺利完成');
}

/** 断言并取出平台错误。 */
function asHapError(error: unknown): HapError {
  expect(error).toBeInstanceOf(HapError);
  return error as HapError;
}

type ChunkStream = Promise<AsyncIterable<Record<string, unknown>>>;
type CreateFake = (body: Record<string, unknown>) => ChunkStream;

/** 假 OpenAI 客户端：chat 线制。 */
function chatClientWith(create: CreateFake): NonNullable<OpenAiCompatibleClientOptions['client']> {
  return { chat: { completions: { create } } } as unknown as NonNullable<
    OpenAiCompatibleClientOptions['client']
  >;
}

/** 假 OpenAI 客户端：responses 线制。 */
function responsesClientWith(create: CreateFake): NonNullable<OpenAiCompatibleClientOptions['client']> {
  return { responses: { create } } as unknown as NonNullable<OpenAiCompatibleClientOptions['client']>;
}

/** 假 OpenAI 客户端：仅 models.list。 */
function modelsClientWith(list: () => ChunkStream): NonNullable<OpenAiCompatibleClientOptions['client']> {
  return { models: { list } } as unknown as NonNullable<OpenAiCompatibleClientOptions['client']>;
}

/** 假 Anthropic 客户端。 */
function anthropicClientWith(parts: Record<string, unknown>): NonNullable<AnthropicClientOptions['client']> {
  return parts as unknown as NonNullable<AnthropicClientOptions['client']>;
}

/** provider 列表转 Map。 */
function providerMap(list: readonly ResolvedProvider[]): Map<string, ResolvedProvider> {
  return new Map(list.map((provider) => [provider.id, provider]));
}

/** 可控时钟：sleep 直接推进虚拟时间，让限速用例确定性完成。 */
class FakeClock implements GateClock {
  private current = 1_000;

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.current += Math.max(0, ms);
    await Promise.resolve();
  }
}

describe('工具调用分片累积器', () => {
  it('name 后到时先缓存参数分片，name 就绪后补发', () => {
    const accumulator = new ToolCallAccumulator();
    expect(accumulator.ingest({ index: 0, id: 'call_a' })).toEqual([]);
    expect(accumulator.ingest({ index: 0, argsDelta: '{"cmd"' })).toEqual([]);
    expect(accumulator.ingest({ index: 0, name: 'shell' })).toEqual([
      { type: 'tool_call_start', index: 0, id: 'call_a', name: 'shell' },
      { type: 'tool_call_args_delta', index: 0, delta: '{"cmd"' },
    ]);
    expect(accumulator.ingest({ index: 0, argsDelta: ':"ls"}' })).toEqual([{ type: 'tool_call_args_delta', index: 0, delta: ':"ls"}' }]);
    expect(accumulator.hasCalls).toBe(true);
    expect(accumulator.flush()).toEqual([{ type: 'tool_call_end', index: 0 }]);
  });

  it('端点未给 id 时用下标兜底，name 首次写入生效', () => {
    const accumulator = new ToolCallAccumulator();
    expect(accumulator.ingest({ index: 2, name: 'read_file' })).toEqual([{ type: 'tool_call_start', index: 2, id: 'call_2', name: 'read_file' }]);
    // 后续分片重复给 name 与 id 不应改写已发布的 start
    expect(accumulator.ingest({ index: 2, id: 'late', name: 'other', argsDelta: '{}' })).toEqual([
      { type: 'tool_call_args_delta', index: 2, delta: '{}' },
    ]);
  });

  it('end 幂等，flush 不重复收束已结束槽位', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.ingest({ index: 0, name: 'shell' });
    expect(accumulator.end(0)).toEqual([{ type: 'tool_call_end', index: 0 }]);
    expect(accumulator.end(0)).toEqual([]);
    expect(accumulator.end(9)).toEqual([]);
    expect(accumulator.flush()).toEqual([]);
  });
});

describe('流式空闲看护', () => {
  it('阈值为 0 时透传全部事件', async () => {
    const items = [1, 2, 3];
    const collected: number[] = [];
    for await (const value of withIdleTimeout(streamOf(items), 0, { providerId: 'p', model: 'm' })) collected.push(value);
    expect(collected).toEqual(items);
  });

  it('相邻事件间隔超限时抛 PROVIDER_STREAM_IDLE', async () => {
    async function* stalled(): AsyncGenerator<number> {
      yield 1;
      // 永不 settle，模拟连接半开
      await new Promise<void>(() => undefined);
    }
    const iterator = withIdleTimeout(stalled(), 20, { providerId: 'deepseek', model: 'deepseek-chat' })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(1);
    const error = asHapError(await captureError(() => iterator.next()));
    expect(error.code).toBe('PROVIDER_STREAM_IDLE');
    expect(error.recoverable).toBe(true);
    expect(error.context).toMatchObject({ providerId: 'deepseek', idleMs: 20 });
  });
});

describe('退避与错误归一化', () => {
  it('Retry-After 优先于指数退避，并受上限约束', () => {
    const rateLimited = Object.assign(new Error('too many'), { status: 429, headers: { 'retry-after': '2' } });
    expect(computeBackoffMs(1, rateLimited)).toBe(2_000);
    expect(computeBackoffMs(1, rateLimited, { capMs: 500 })).toBe(500);
  });

  it('注入抖动后退避可预期，并在上限处收敛', () => {
    const options = { baseMs: 1_000, capMs: 8_000, jitter: (span: number) => span };
    expect(computeBackoffMs(1, undefined, options)).toBe(1_000);
    expect(computeBackoffMs(2, undefined, options)).toBe(2_000);
    expect(computeBackoffMs(9, undefined, options)).toBe(8_000);
  });

  it('状态码映射到对应错误码与可恢复性', () => {
    const cases: Array<{ label: string; error: unknown; code: HapErrorCode; recoverable: boolean }> = [
      { label: '429', error: Object.assign(new Error('rate'), { status: 429 }), code: 'PROVIDER_RATE_LIMIT', recoverable: true },
      { label: '401', error: Object.assign(new Error('unauthorized'), { status: 401 }), code: 'CONFIG_ENV_MISSING', recoverable: false },
      { label: '403', error: Object.assign(new Error('forbidden'), { status: 403 }), code: 'CONFIG_ENV_MISSING', recoverable: false },
      { label: '404', error: Object.assign(new Error('no model'), { status: 404 }), code: 'MODEL_NOT_FOUND', recoverable: false },
      { label: '503', error: Object.assign(new Error('boom'), { status: 503 }), code: 'PROVIDER_UNREACHABLE', recoverable: true },
      { label: '400', error: Object.assign(new Error('bad body'), { status: 400 }), code: 'PROVIDER_UNREACHABLE', recoverable: false },
      { label: 'ECONNREFUSED', error: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), code: 'PROVIDER_UNREACHABLE', recoverable: true },
      { label: 'fetch failed', error: new Error('fetch failed'), code: 'PROVIDER_UNREACHABLE', recoverable: true },
    ];
    for (const item of cases) {
      const normalized = normalizeProviderError(item.error, { providerId: 'deepseek', model: 'deepseek-chat', envKey: 'TEST_API_KEY' });
      expect(normalized.code, item.label).toBe(item.code);
      expect(normalized.recoverable, item.label).toBe(item.recoverable);
    }
  });

  it('凭据类错误只提示环境变量名', () => {
    const normalized = normalizeProviderError(Object.assign(new Error('unauthorized'), { status: 401 }), {
      providerId: 'deepseek',
      envKey: 'DEEPSEEK_API_KEY',
    });
    expect(normalized.message).toContain('DEEPSEEK_API_KEY');
    expect(normalized.context).toMatchObject({ envKey: 'DEEPSEEK_API_KEY' });
  });

  it('取消与已归一化错误按原样处理', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'APIUserAbortError' }))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    const aborted = normalizeProviderError(Object.assign(new Error('canceled'), { name: 'AbortError' }), { providerId: 'p' });
    expect(aborted.code).toBe('TASK_ABORTED');
    const already = normalizeProviderError(aborted, { providerId: 'p' });
    expect(already).toBe(aborted);
  });
});

describe('未知结构读取助手', () => {
  it('tool_calls 缺 index 时用下标兜底，对象参数序列化为字符串', () => {
    expect(readToolCallChunks([{ id: 'a', function: { name: 'x', arguments: { k: 1 } } }])).toEqual([
      { index: 0, id: 'a', name: 'x', argsDelta: '{"k":1}' },
    ]);
    expect(readToolCallChunks(null)).toEqual([]);
  });

  it('usage 兼容三套命名，total 缺失时相加', () => {
    expect(readChatUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(readChatUsage({ input_tokens: 5, output_tokens: 1, total_tokens: 9 })).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 9 });
    expect(readChatUsage({ prompt_tokens: 2, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } })).toEqual({
      promptTokens: 2,
      completionTokens: 2,
      totalTokens: 4,
      reasoningTokens: 1,
    });
    expect(readChatUsage({})).toBeUndefined();
  });
});

describe('限速闸门', () => {
  it('并发上限满时排队，释放后放行且 release 幂等', async () => {
    const gate = new RateGate('p', { concurrency: 1, rpm: 0 });
    const first = await gate.acquire();
    expect(gate.active).toBe(1);
    const pending = gate.acquire();
    await tick();
    expect(gate.queued).toBe(1);
    first();
    first();
    const second = await pending;
    expect(gate.active).toBe(1);
    second();
    expect(gate.active).toBe(0);
  });

  it('滑动窗口内超过 rpm 时等待窗口滚动', async () => {
    const clock = new FakeClock();
    const gate = new RateGate('p', { concurrency: 0, rpm: 2 }, clock);
    const first = await gate.acquire();
    const second = await gate.acquire();
    expect(gate.windowUsage).toBe(2);
    const before = clock.now();
    const third = await gate.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(60_000);
    expect(gate.windowUsage).toBe(1);
    first();
    second();
    third();
    expect(gate.active).toBe(0);
  });

  it('闸门配置按 limits 生成，同键复用实例并可热更新', () => {
    const limits = makeLimits({
      providerConcurrency: { deepseek: 3 },
      providerRpm: { deepseek: 60 },
      agentConcurrency: { coder: 1 },
      defaultProviderConcurrency: 2,
      defaultAgentConcurrency: 4,
    });
    const providers = providerGateRegistry(limits);
    expect(providers.settingsFor('deepseek')).toEqual({ concurrency: 3, rpm: 60 });
    expect(providers.settingsFor('openai')).toEqual({ concurrency: 2, rpm: 0 });
    expect(providers.gate('deepseek')).toBe(providers.gate('deepseek'));
    expect(providers.keys()).toEqual(['deepseek']);
    providers.refresh({ concurrency: { deepseek: 5 } });
    expect(providers.settingsFor('deepseek')).toEqual({ concurrency: 5, rpm: 60 });

    const agents = agentGateRegistry(limits);
    expect(agents.settingsFor('coder')).toEqual({ concurrency: 1, rpm: 0 });
    expect(agents.settingsFor('writer')).toEqual({ concurrency: 4, rpm: 0 });
  });

  it('闸门包装的客户端把许可持有到流结束', async () => {
    const gate = new RateGate('mock', { concurrency: 1, rpm: 0 });
    const inner = new MockProviderClient({ turns: [textTurn('一'), textTurn('二')] });
    const gated = new GatedProviderClient(inner, gate);
    expect(gated.providerId).toBe('mock');
    expect(gated.wireApi).toBe('chat');

    const firstStream = gated.send(makeRequest())[Symbol.asyncIterator]();
    await firstStream.next();
    expect(gate.active).toBe(1);

    const secondStream = gated.send(makeRequest())[Symbol.asyncIterator]();
    const blocked = secondStream.next();
    await tick();
    expect(gate.queued).toBe(1);

    // 提前结束第一条流 → finally 释放许可 → 第二条流放行
    await firstStream.return?.(undefined);
    const resumed = await blocked;
    expect(resumed.done).toBe(false);
    await secondStream.return?.(undefined);
    expect(gate.active).toBe(0);
  });
});

describe('OpenAI 兼容客户端 · chat 线制', () => {
  it('正文、推理、usage 与 finish 按稳定顺序发出', async () => {
    const chunks: Record<string, unknown>[] = [
      { choices: [{ delta: { reasoning_content: '思考' } }] },
      { choices: [{ delta: { content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const client = new OpenAiCompatibleClient({ provider: makeProvider(), apiKey: 'k', client: chatClientWith(async () => streamOf(chunks)) });
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events.map((event) => event.type)).toEqual(['reasoning_delta', 'text_delta', 'text_delta', 'usage', 'finish']);
    expect(textOfWireEvents(events)).toBe('你好');
    expect(events[3]).toEqual({ type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
    expect(last(events)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('工具调用即使 finish_reason 为 stop 也归为 tool_calls', async () => {
    const chunks: Record<string, unknown>[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'shell', arguments: '{"command"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const client = new OpenAiCompatibleClient({ provider: makeProvider({ id: 'zhipu' }), apiKey: 'k', client: chatClientWith(async () => streamOf(chunks)) });
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events.map((event) => event.type)).toEqual(['tool_call_start', 'tool_call_args_delta', 'tool_call_args_delta', 'tool_call_end', 'finish']);
    expect(events[0]).toEqual({ type: 'tool_call_start', index: 0, id: 'call_a', name: 'shell' });
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('system 提示前置为 system 消息，采样参数与 stop 正确落位', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAiCompatibleClient({
      provider: makeProvider(),
      apiKey: 'k',
      client: chatClientWith(async (body) => {
        bodies.push(body);
        return streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] as Record<string, unknown>[]);
      }),
    });
    await collectWireEvents(
      client.send(makeRequest({ system: '你是助手', maxTokens: 256, stop: ['<end>'], params: { temperature: 0.2 } })),
    );
    const body = bodies[0] ?? {};
    expect(body.model).toBe('demo-model');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(256);
    expect(body.stop).toEqual(['<end>']);
    expect(body.temperature).toBe(0.2);
    expect(body.stream_options).toEqual({ include_usage: true });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('端点不支持 stream_options 时当场降级并对后续请求生效', async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const client = new OpenAiCompatibleClient({
      provider: makeProvider(),
      apiKey: 'k',
      client: chatClientWith(async (body) => {
        bodies.push(body);
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('Unrecognized request argument supplied: stream_options'), { status: 400 });
        return streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }] as Record<string, unknown>[]);
      }),
    });
    expect(textOfWireEvents(await collectWireEvents(client.send(makeRequest())))).toBe('ok');
    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(bodies[1]?.stream_options).toBeUndefined();
    await collectWireEvents(client.send(makeRequest()));
    expect(bodies[2]?.stream_options).toBeUndefined();
    expect(mentionsStreamOptions(Object.assign(new Error('stream_options'), { status: 400 }))).toBe(true);
    expect(mentionsStreamOptions(Object.assign(new Error('stream_options'), { status: 500 }))).toBe(false);
  });

  it('建流阶段可恢复失败按 stream_max_retries 重试', async () => {
    let attempts = 0;
    const client = new OpenAiCompatibleClient({
      provider: makeProvider({ streamMaxRetries: 1 }),
      apiKey: 'k',
      client: chatClientWith(async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('server error'), { status: 500, headers: { 'retry-after': '0' } });
        return streamOf([{ choices: [{ delta: { content: '恢复' }, finish_reason: 'stop' }] }] as Record<string, unknown>[]);
      }),
    });
    expect(textOfWireEvents(await collectWireEvents(client.send(makeRequest())))).toBe('恢复');
    expect(attempts).toBe(2);
  });

  it('已吐出事件后失败不重放，直接上抛交由上层换模型', async () => {
    let attempts = 0;
    const client = new OpenAiCompatibleClient({
      provider: makeProvider({ streamMaxRetries: 3 }),
      apiKey: 'k',
      client: chatClientWith(async () => {
        attempts += 1;
        return (async function* (): AsyncGenerator<Record<string, unknown>> {
          yield { choices: [{ delta: { content: '半句' } }] };
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        })();
      }),
    });
    const events: WireEvent[] = [];
    const error = asHapError(
      await captureError(async () => {
        for await (const event of client.send(makeRequest())) events.push(event);
      }),
    );
    expect(attempts).toBe(1);
    expect(textOfWireEvents(events)).toBe('半句');
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
  });

  it('finish_reason 映射覆盖各分支', () => {
    expect(mapChatFinishReason('stop', true)).toBe('tool_calls');
    expect(mapChatFinishReason('function_call', false)).toBe('tool_calls');
    expect(mapChatFinishReason('length', false)).toBe('length');
    expect(mapChatFinishReason('error', false)).toBe('error');
    expect(mapChatFinishReason(undefined, false)).toBe('stop');
  });
});

describe('OpenAI 兼容客户端 · responses 线制', () => {
  it('output_text、推理摘要与 function_call 事件正确翻译', async () => {
    const chunks: Record<string, unknown>[] = [
      { type: 'response.reasoning_summary_text.delta', delta: '推理' },
      { type: 'response.output_text.delta', delta: '结果' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'fc_1', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'fc_1', name: 'read_file', arguments: '{"path":"a"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
    ];
    const client = new OpenAiCompatibleClient({
      provider: makeProvider({ id: 'openai', wireApi: 'responses' }),
      apiKey: 'k',
      client: responsesClientWith(async () => streamOf(chunks)),
    });
    expect(client.wireApi).toBe('responses');
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events.map((event) => event.type)).toEqual([
      'reasoning_delta',
      'text_delta',
      'tool_call_start',
      'tool_call_args_delta',
      'tool_call_end',
      'usage',
      'finish',
    ]);
    expect(events[2]).toEqual({ type: 'tool_call_start', index: 1, id: 'fc_1', name: 'read_file' });
    expect(events[3]).toEqual({ type: 'tool_call_args_delta', index: 1, delta: '{"path":"a"}' });
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('仅在 output_item.done 给出完整参数时补发一次', async () => {
    const chunks: Record<string, unknown>[] = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_2', name: 'list_dir' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_2', name: 'list_dir', arguments: '{"path":"."}' } },
      { type: 'response.completed', response: {} },
    ];
    const client = new OpenAiCompatibleClient({
      provider: makeProvider({ id: 'openai', wireApi: 'responses' }),
      apiKey: 'k',
      client: responsesClientWith(async () => streamOf(chunks)),
    });
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events.map((event) => event.type)).toEqual(['tool_call_start', 'tool_call_args_delta', 'tool_call_end', 'finish']);
    expect(events[1]).toEqual({ type: 'tool_call_args_delta', index: 0, delta: '{"path":"."}' });
  });

  it('请求体使用 instructions 与 max_output_tokens', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAiCompatibleClient({
      provider: makeProvider({ id: 'openai', wireApi: 'responses' }),
      apiKey: 'k',
      client: responsesClientWith(async (body) => {
        bodies.push(body);
        return streamOf([{ type: 'response.completed', response: {} }] as Record<string, unknown>[]);
      }),
    });
    await collectWireEvents(client.send(makeRequest({ system: '系统提示', maxTokens: 512, params: { reasoning: { effort: 'high' } } })));
    const body = bodies[0] ?? {};
    expect(body.instructions).toBe('系统提示');
    expect(body.max_output_tokens).toBe(512);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(true);
  });

  it('流内 error 事件归为可恢复错误', async () => {
    const chunks: Record<string, unknown>[] = [{ type: 'error', message: '上游中断' }];
    const client = new OpenAiCompatibleClient({
      provider: makeProvider({ id: 'openai', wireApi: 'responses' }),
      apiKey: 'k',
      client: responsesClientWith(async () => streamOf(chunks)),
    });
    const error = asHapError(await captureError(() => collectWireEvents(client.send(makeRequest()))));
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(error.message).toContain('上游中断');
  });

  it('自检把 404 视为可达但不支持列举，5xx 视为不可达', async () => {
    const notFound = new OpenAiCompatibleClient({
      provider: makeProvider(),
      apiKey: 'k',
      client: modelsClientWith(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }),
    });
    const partial = await notFound.check();
    expect(partial.reachable).toBe(true);
    expect(partial.models).toEqual([]);
    expect(partial.error).toContain('404');

    const broken = new OpenAiCompatibleClient({
      provider: makeProvider(),
      apiKey: 'k',
      client: modelsClientWith(async () => {
        throw Object.assign(new Error('bad gateway'), { status: 502 });
      }),
    });
    const failed = await broken.check();
    expect(failed.reachable).toBe(false);
    expect(failed.handshakeMs).toBeGreaterThanOrEqual(0);
  });

  it('模型列举按字典序返回并忽略无 id 条目', async () => {
    const client = new OpenAiCompatibleClient({
      provider: makeProvider(),
      apiKey: 'k',
      client: modelsClientWith(async () => streamOf([{ id: 'zeta' }, { id: 'alpha' }, {}] as Record<string, unknown>[])),
    });
    expect(await client.listModels()).toEqual(['alpha', 'zeta']);
    const result = await client.check();
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(['alpha', 'zeta']);
  });
});

describe('Anthropic 客户端', () => {
  const anthropicProvider = makeProvider({
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.invalid/v1',
    envKey: 'ANTHROPIC_API_KEY',
    wireApi: 'anthropic-messages',
    defaultProtocol: 'anthropic',
    maxTokensDefault: 8192,
  });

  it('Messages SSE 翻译为统一事件序列，usage 合并两侧读数', async () => {
    const chunks: Record<string, unknown>[] = [
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开始' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"patch"' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    const bodies: Record<string, unknown>[] = [];
    const client = new AnthropicClient({
      provider: anthropicProvider,
      apiKey: 'k',
      client: anthropicClientWith({
        messages: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(body);
            return streamOf(chunks);
          },
        },
      }),
    });
    expect(client.wireApi).toBe('anthropic-messages');
    expect(client.providerId).toBe('anthropic');
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'tool_call_start',
      'tool_call_args_delta',
      'tool_call_args_delta',
      'tool_call_end',
      'usage',
      'finish',
    ]);
    expect(events[1]).toEqual({ type: 'tool_call_start', index: 1, id: 'toolu_1', name: 'apply_patch' });
    expect(events[events.length - 2]).toEqual({ type: 'usage', usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 } });
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls' });
    // max_tokens 必填，缺省时用 provider 兜底
    expect(bodies[0]?.max_tokens).toBe(8192);
  });

  it('thinking_delta 映射为推理增量，签名分片被忽略', async () => {
    const chunks: Record<string, unknown>[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const client = new AnthropicClient({
      provider: anthropicProvider,
      apiKey: 'k',
      client: anthropicClientWith({ messages: { create: async () => streamOf(chunks) } }),
    });
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events).toEqual([
      { type: 'reasoning_delta', text: '嗯' },
      { type: 'text_delta', text: '答' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('非流式降级形态下从 content_block 补发整体参数', async () => {
    const chunks: Record<string, unknown>[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'shell', input: { command: 'ls' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ];
    const client = new AnthropicClient({
      provider: anthropicProvider,
      apiKey: 'k',
      client: anthropicClientWith({ messages: { create: async () => streamOf(chunks) } }),
    });
    const events = await collectWireEvents(client.send(makeRequest()));
    expect(events.map((event) => event.type)).toEqual(['tool_call_start', 'tool_call_args_delta', 'tool_call_end', 'finish']);
    expect(events[1]).toEqual({ type: 'tool_call_args_delta', index: 0, delta: '{"command":"ls"}' });
  });

  it('system、stop_sequences、tools 与采样参数正确落位', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new AnthropicClient({
      provider: anthropicProvider,
      apiKey: 'k',
      client: anthropicClientWith({
        messages: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(body);
            return streamOf([{ type: 'message_stop' }] as Record<string, unknown>[]);
          },
        },
      }),
    });
    await collectWireEvents(
      client.send(
        makeRequest({
          system: '系统',
          maxTokens: 1024,
          stop: ['<stop>'],
          params: { temperature: 0.1 },
          tools: [{ name: 'shell', input_schema: { type: 'object' } }],
        }),
      ),
    );
    const body = bodies[0] ?? {};
    expect(body.system).toBe('系统');
    expect(body.max_tokens).toBe(1024);
    expect(body.stop_sequences).toEqual(['<stop>']);
    expect(body.temperature).toBe(0.1);
    expect(body.tools).toEqual([{ name: 'shell', input_schema: { type: 'object' } }]);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('流内 overloaded_error 归为可恢复，invalid_request_error 归为致命', async () => {
    const chunks: Record<string, unknown>[] = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'error', error: { type: 'overloaded_error', message: '过载' } },
    ];
    const client = new AnthropicClient({
      provider: anthropicProvider,
      apiKey: 'k',
      client: anthropicClientWith({ messages: { create: async () => streamOf(chunks) } }),
    });
    const error = asHapError(await captureError(() => collectWireEvents(client.send(makeRequest()))));
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
    expect(error.recoverable).toBe(true);
    expect(error.message).toContain('过载');

    expect(asHapError(anthropicStreamError({ error: { type: 'rate_limit_error', message: 'x' } }, 'anthropic', 'm')).code).toBe('PROVIDER_RATE_LIMIT');
    expect(asHapError(anthropicStreamError({ error: { type: 'invalid_request_error', message: 'y' } }, 'anthropic', 'm')).recoverable).toBe(false);
  });

  it('usage 把缓存 token 计入 prompt 侧', () => {
    expect(readAnthropicUsage({ input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 2 })).toEqual({
      prompt: 18,
      completion: 2,
    });
    expect(readAnthropicUsage({ output_tokens: 4 })).toEqual({ prompt: undefined, completion: 4 });
    expect(readAnthropicUsage({})).toBeUndefined();
    expect(readAnthropicUsage(null)).toBeUndefined();
  });

  it('stop_reason 映射覆盖各分支', () => {
    expect(mapAnthropicStopReason('tool_use', false)).toBe('tool_calls');
    expect(mapAnthropicStopReason('max_tokens', false)).toBe('length');
    expect(mapAnthropicStopReason('end_turn', false)).toBe('stop');
    expect(mapAnthropicStopReason('stop_sequence', false)).toBe('stop');
    expect(mapAnthropicStopReason('pause_turn', false)).toBe('stop');
    expect(mapAnthropicStopReason('end_turn', true)).toBe('tool_calls');
  });

  it('自检读取模型列表', async () => {
    const client = new AnthropicClient({
      provider: anthropicProvider,
      apiKey: 'k',
      client: anthropicClientWith({ models: { list: async () => streamOf([{ id: 'claude-sonnet-4-5' }] as Record<string, unknown>[]) } }),
    });
    const result = await client.check();
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(['claude-sonnet-4-5']);
  });
});

describe('假提供商客户端', () => {
  it('按脚本逐轮回放并记录请求', async () => {
    const client = new MockProviderClient({ providerId: 'mock-x' });
    client.push(textTurn('第一轮', { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, reasoning: '想一下' }), toolCallTurn([{ name: 'shell', args: { command: 'ls' } }]));
    const first = await collectWireEvents(client.send(makeRequest()));
    expect(first.map((event) => event.type)).toEqual(['reasoning_delta', 'text_delta', 'usage', 'finish']);
    expect(textOfWireEvents(first)).toBe('第一轮');
    const second = await collectWireEvents(client.send(makeRequest({ model: 'other' })));
    expect(second.map((event) => event.type)).toEqual(['tool_call_start', 'tool_call_args_delta', 'tool_call_end', 'finish']);
    expect(client.callCount).toBe(2);
    expect(client.requests).toHaveLength(2);
    expect(client.lastRequest?.model).toBe('other');
    expect((await client.check()).reachable).toBe(true);
  });

  it('脚本耗尽时抛错，repeatLast 时复用末轮，errorTurn 原样抛出', async () => {
    const exhausted = new MockProviderClient({ turns: [textTurn('唯一')] });
    await collectWireEvents(exhausted.send(makeRequest()));
    expect(asHapError(await captureError(() => collectWireEvents(exhausted.send(makeRequest())))).code).toBe('PROVIDER_UNREACHABLE');

    const repeating = new MockProviderClient({ turns: [textTurn('复用')], repeatLast: true });
    await collectWireEvents(repeating.send(makeRequest()));
    expect(textOfWireEvents(await collectWireEvents(repeating.send(makeRequest())))).toBe('复用');
    repeating.reset();
    expect(repeating.callCount).toBe(0);
    expect(repeating.requests).toHaveLength(0);

    const failing = new MockProviderClient({ turns: [errorTurn(new Error('脚本错误'))] });
    const error = await captureError(() => collectWireEvents(failing.send(makeRequest())));
    expect((error as Error).message).toBe('脚本错误');
  });

  it('按 chunkSize 切分正文与工具参数', () => {
    const text = textTurn('一二三四五', { chunkSize: 2 });
    expect((text.events ?? []).filter((event) => event.type === 'text_delta')).toHaveLength(3);

    const call = toolCallTurn([{ id: 'c9', name: 'write_file', args: { path: 'a', content: 'b' } }], { text: '先说明', chunkSize: 5 });
    const deltas = (call.events ?? []).filter((event): event is Extract<WireEvent, { type: 'tool_call_args_delta' }> => event.type === 'tool_call_args_delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((event) => event.delta).join('')).toBe(JSON.stringify({ path: 'a', content: 'b' }));
  });
});

describe('提供商注册表', () => {
  it('未配置的提供商报 PROVIDER_NOT_FOUND 并列出可用项', async () => {
    const registry = new ProviderRegistry(providerMap([makeProvider({ id: 'deepseek' })]), { env: {} });
    const error = asHapError(await captureError(async () => registry.provider('openai')));
    expect(error.code).toBe('PROVIDER_NOT_FOUND');
    expect(error.message).toContain('deepseek');
    expect(registry.ids).toEqual(['deepseek']);
    expect(registry.has('deepseek')).toBe(true);
    expect(registry.has('openai')).toBe(false);
  });

  it('env_key 为空时报 CONFIG_ENV_MISSING 并附变量名', async () => {
    const provider = makeProvider({ id: 'deepseek', envKey: 'DEEPSEEK_API_KEY' });
    const registry = new ProviderRegistry(providerMap([provider]), { env: { DEEPSEEK_API_KEY: '   ' } });
    const error = asHapError(await captureError(async () => registry.credential(provider)));
    expect(error.code).toBe('CONFIG_ENV_MISSING');
    expect(error.message).toContain('DEEPSEEK_API_KEY');
  });

  it('无 env_key 的提供商不要求凭据', () => {
    const provider = makeProvider({ id: 'ollama', envKey: undefined, baseUrl: 'http://localhost:11434/v1' });
    const registry = new ProviderRegistry(providerMap([provider]), { env: {} });
    expect(registry.credential(provider)).toBeUndefined();
  });

  it('env_http_headers 运行时取值，缺失即报错', async () => {
    const provider = makeProvider({
      id: 'openrouter',
      envKey: 'OPENROUTER_API_KEY',
      httpHeaders: { 'X-Title': 'HAP' },
      envHttpHeaders: { 'HTTP-Referer': 'HAP_SITE_URL' },
    });
    const ready = new ProviderRegistry(providerMap([provider]), { env: { OPENROUTER_API_KEY: 'k', HAP_SITE_URL: 'https://hap.local' } });
    expect(ready.resolveHeaders(provider)).toEqual({ 'X-Title': 'HAP', 'HTTP-Referer': 'https://hap.local' });

    const missing = new ProviderRegistry(providerMap([provider]), { env: { OPENROUTER_API_KEY: 'k' } });
    const error = asHapError(await captureError(async () => missing.resolveHeaders(provider)));
    expect(error.code).toBe('CONFIG_ENV_MISSING');
    expect(error.message).toContain('HAP_SITE_URL');
  });

  it('客户端按 id 缓存，invalidate 与 refresh 后重建', () => {
    let built = 0;
    const contexts: ProviderFactoryContext[] = [];
    const factory: ProviderFactory = (context) => {
      built += 1;
      contexts.push(context);
      return new MockProviderClient({ providerId: context.provider.id });
    };
    const registry = new ProviderRegistry(providerMap([makeProvider({ id: 'deepseek' })]), { env: { TEST_API_KEY: 'secret' }, factory });
    const first = registry.client('deepseek');
    expect(registry.client('deepseek')).toBe(first);
    expect(built).toBe(1);
    expect(contexts[0]?.apiKey).toBe('secret');
    expect(contexts[0]?.headers).toEqual({});

    registry.invalidate('deepseek');
    registry.client('deepseek');
    expect(built).toBe(2);
    registry.invalidate();
    registry.client('deepseek');
    expect(built).toBe(3);

    registry.refresh(providerMap([makeProvider({ id: 'zhipu' })]));
    expect(registry.ids).toEqual(['zhipu']);
  });

  it('提供 gates 时客户端被闸门包装且许可正确归还', async () => {
    const gates = new GateRegistry({ concurrency: { deepseek: 1 } });
    const registry = new ProviderRegistry(providerMap([makeProvider({ id: 'deepseek' })]), {
      env: { TEST_API_KEY: 'k' },
      gates,
      factory: () => new MockProviderClient({ turns: [textTurn('好')], repeatLast: true }),
    });
    const client = registry.client('deepseek');
    expect(client).toBeInstanceOf(GatedProviderClient);
    expect(textOfWireEvents(await collectWireEvents(client.send(makeRequest())))).toBe('好');
    expect(gates.gate('deepseek').active).toBe(0);
  });

  it('自检把凭据缺失转成不可达结果而非抛错', async () => {
    const registry = new ProviderRegistry(providerMap([makeProvider({ id: 'deepseek', envKey: 'MISSING_KEY' })]), { env: {} });
    const results = await registry.checkAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.reachable).toBe(false);
    expect(results[0]?.error).toContain('MISSING_KEY');
  });

  it('默认工厂只按 wire_api 分派线制', () => {
    const anthropic = defaultProviderFactory({ provider: makeProvider({ id: 'anthropic', wireApi: 'anthropic-messages' }), apiKey: 'k', headers: {} });
    expect(anthropic).toBeInstanceOf(AnthropicClient);
    expect(anthropic.wireApi).toBe('anthropic-messages');

    const chat = defaultProviderFactory({ provider: makeProvider({ id: 'zhipu', wireApi: 'chat' }), apiKey: 'k', headers: { 'X-Title': 'HAP' } });
    expect(chat).toBeInstanceOf(OpenAiCompatibleClient);
    expect(chat.wireApi).toBe('chat');

    const responses = defaultProviderFactory({ provider: makeProvider({ id: 'openai', wireApi: 'responses' }), apiKey: 'k', headers: {} });
    expect(responses.wireApi).toBe('responses');
  });
});
