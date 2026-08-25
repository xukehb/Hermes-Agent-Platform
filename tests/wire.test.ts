/**
 * 线制级测试：不经 MockProviderClient，直接驱动真实的 OpenAI / Anthropic SDK，
 * 只把最底层的 fetch 换成本地假服务端。
 *
 * 为什么需要这一层：providers.test.ts 走的是注入客户端，覆盖的是「注册表如何分派」；
 * 而请求体字段名（max_tokens / max_output_tokens / instructions）、baseURL 拼接、
 * 自定义请求头下发、SSE 帧到 WireEvent 的映射，全部只在真 SDK 路径上执行。
 * 这些恰恰是换服务商时最容易出错的地方，因此必须锁死。
 *
 * 约束：假 fetch 全程返回内存里的字节流，不产生任何真实网络连接。
 *
 * 日期：2026-08-24  执行者：Codex
 */
import { describe, expect, it } from 'vitest';

import { AnthropicClient } from '../src/providers/anthropic.js';
import { OpenAiCompatibleClient } from '../src/providers/openai-compatible.js';
import { BUILTIN_PROVIDERS } from '../src/config/defaults.js';
import type { ResolvedProvider } from '../src/config/resolved.js';
import type { WireEvent, WireRequest } from '../src/domain/index.js';

/** 一次被假服务端捕获的请求，供断言检查线制细节。 */
interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 假 fetch：把给定 SSE 帧按行拼成响应流，同时记录请求。 */
function sseFetch(frames: readonly string[], captured: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const raw = await request.text();
    captured.push({ url: request.url, headers, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) });
    const payload = frames.map((frame) => 'data: ' + frame + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/**
 * 假 fetch（Anthropic 版）：Messages SSE 必须带 event: 行。
 *
 * Anthropic SDK 按 sse.event 分派帧类型，只发 data: 会被整流丢弃，
 * 因此这里从帧体的 type 字段回填 event 名。
 */
function anthropicSseFetch(frames: readonly string[], captured: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const raw = await request.text();
    captured.push({ url: request.url, headers, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) });
    const payload = frames
      .map((frame) => {
        const name = String((JSON.parse(frame) as { type?: unknown }).type ?? 'message_delta');
        return 'event: ' + name + '\ndata: ' + frame + '\n\n';
      })
      .join('');
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/** 假 fetch：返回一个非流式 JSON 响应，用于 models 列举。 */
function jsonFetch(payload: unknown, captured: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({ url: request.url, headers, body: {} });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** 假 fetch：固定返回错误状态，用于错误归一化。 */
function errorFetch(status: number, message: string): typeof fetch {
  return (async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function provider(patch: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'wire',
    name: 'Wire 测试通道',
    baseUrl: 'https://wire.test/v1',
    envKey: 'WIRE_KEY',
    wireApi: 'chat',
    defaultProtocol: 'openai-tools',
    httpHeaders: {},
    envHttpHeaders: {},
    requestMaxRetries: 0,
    streamMaxRetries: 0,
    streamIdleTimeoutMs: 30000,
    maxTokensDefault: 4096,
    ...patch,
  };
}

function request(patch: Partial<WireRequest> = {}): WireRequest {
  return {
    model: 'wire-model',
    messages: [{ role: 'user', content: '你好' }],
    params: { temperature: 0.3 },
    ...patch,
  };
}

async function drain(source: AsyncIterable<WireEvent>): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

/** 只取文本增量拼成整串，便于断言正文。 */
function textOf(events: readonly WireEvent[]): string {
  return events
    .filter((event): event is { type: 'text_delta'; text: string } => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
}

describe('chat 线制（OpenAI 兼容端点）', () => {
  it('请求打到 base_url + /chat/completions，并带上凭据与自定义头', async () => {
    const captured: Captured[] = [];
    const client = new OpenAiCompatibleClient({
      provider: provider({ httpHeaders: { 'X-Tenant': 'hap' } }),
      apiKey: 'sk-wire',
      headers: { 'X-Tenant': 'hap' },
      fetch: sseFetch(['{"choices":[{"delta":{"content":"好"},"finish_reason":null}]}'], captured),
    });

    await drain(client.send(request()));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://wire.test/v1/chat/completions');
    expect(captured[0]?.headers['authorization']).toBe('Bearer sk-wire');
    expect(captured[0]?.headers['x-tenant']).toBe('hap');
  });

  it('采样参数透传，显式字段不被 params 覆盖，并按 chat 线制命名 max_tokens', async () => {
    const captured: Captured[] = [];
    const client = new OpenAiCompatibleClient({
      provider: provider(),
      apiKey: 'sk-wire',
      fetch: sseFetch(['{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}'], captured),
    });

    await drain(client.send(request({ params: { temperature: 0.3, model: '不该生效' }, maxTokens: 321, stop: ['</tool_call>'] })));

    const body = captured[0]?.body ?? {};
    expect(body['model']).toBe('wire-model');
    expect(body['temperature']).toBe(0.3);
    expect(body['max_tokens']).toBe(321);
    expect(body['stop']).toEqual(['</tool_call>']);
    expect(body['stream']).toBe(true);
  });

  it('system 提示被前置为 system 消息，不会静默丢失', async () => {
    const captured: Captured[] = [];
    const client = new OpenAiCompatibleClient({
      provider: provider(),
      apiKey: 'sk-wire',
      fetch: sseFetch(['{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}'], captured),
    });

    await drain(client.send(request({ system: '你是助手' })));

    const messages = captured[0]?.body['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(messages).toHaveLength(2);
  });

  it('分片正文按序拼接，推理增量单独成事件，usage 在 finish 之前送出', async () => {
    const events = await drain(
      new OpenAiCompatibleClient({
        provider: provider(),
        apiKey: 'sk-wire',
        fetch: sseFetch(
          [
            '{"choices":[{"delta":{"reasoning_content":"先想一下"},"finish_reason":null}]}',
            '{"choices":[{"delta":{"content":"结论"},"finish_reason":null}]}',
            '{"choices":[{"delta":{"content":"是这样"},"finish_reason":"stop"}]}',
            '{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
          ],
          [],
        ),
      }).send(request()),
    );

    expect(textOf(events)).toBe('结论是这样');
    expect(events.some((event) => event.type === 'reasoning_delta')).toBe(true);
    const usageIndex = events.findIndex((event) => event.type === 'usage');
    const finishIndex = events.findIndex((event) => event.type === 'finish');
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(finishIndex);
    const usage = events[usageIndex];
    expect(usage?.type === 'usage' ? usage.usage.totalTokens : 0).toBe(18);
  });

  it('工具调用分片被还原为 start / args_delta / end，finish 归一为 tool_calls', async () => {
    const events = await drain(
      new OpenAiCompatibleClient({
        provider: provider(),
        apiKey: 'sk-wire',
        fetch: sseFetch(
          [
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}',
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
          ],
          [],
        ),
      }).send(request({ tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }] })),
    );

    const start = events.find((event) => event.type === 'tool_call_start');
    expect(start?.type === 'tool_call_start' ? start.name : '').toBe('read_file');
    expect(start?.type === 'tool_call_start' ? start.id : '').toBe('call_1');
    const args = events
      .filter((event): event is { type: 'tool_call_args_delta'; index: number; delta: string } => event.type === 'tool_call_args_delta')
      .map((event) => event.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.txt' });
    expect(events.some((event) => event.type === 'tool_call_end')).toBe(true);
    const finish = events[events.length - 1];
    expect(finish?.type === 'finish' ? finish.reason : '').toBe('tool_calls');
  });

  it('端点退化为非流式 message 形态时仍能取到正文', async () => {
    const events = await drain(
      new OpenAiCompatibleClient({
        provider: provider(),
        apiKey: 'sk-wire',
        fetch: sseFetch(['{"choices":[{"message":{"content":"整段返回"},"finish_reason":"stop"}]}'], []),
      }).send(request()),
    );

    expect(textOf(events)).toBe('整段返回');
  });

  it('无凭据端点不发 Authorization 之外的占位泄漏，且请求可正常完成', async () => {
    const captured: Captured[] = [];
    await drain(
      new OpenAiCompatibleClient({
        provider: provider({ baseUrl: 'http://localhost:11434/v1', envKey: undefined }),
        apiKey: undefined,
        fetch: sseFetch(['{"choices":[{"delta":{"content":"本地"},"finish_reason":"stop"}]}'], captured),
      }).send(request()),
    );

    expect(captured[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('上游 4xx 被归一为带提供商与环境变量提示的错误', async () => {
    const client = new OpenAiCompatibleClient({
      provider: provider(),
      apiKey: 'sk-wire',
      fetch: errorFetch(401, 'invalid api key'),
    });

    let message = '';
    try {
      await drain(client.send(request()));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('wire');
    expect(message).toContain('WIRE_KEY');
  });

  it('check 走 /models，可达时返回排序后的模型标识', async () => {
    const captured: Captured[] = [];
    const result = await new OpenAiCompatibleClient({
      provider: provider(),
      apiKey: 'sk-wire',
      fetch: jsonFetch({ object: 'list', data: [{ id: 'zeta' }, { id: 'alpha' }] }, captured),
    }).check();

    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(['alpha', 'zeta']);
    expect(captured[0]?.url).toBe('https://wire.test/v1/models');
  });

  it('端点不提供 /models 列举时仍判定为可达', async () => {
    const result = await new OpenAiCompatibleClient({
      provider: provider(),
      apiKey: 'sk-wire',
      fetch: errorFetch(404, 'not found'),
    }).check();

    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.error ?? '').toContain('404');
  });
});

describe('responses 线制（OpenAI 官方端点）', () => {
  it('请求打到 /responses，系统提示走 instructions，输出上限走 max_output_tokens', async () => {
    const captured: Captured[] = [];
    const client = new OpenAiCompatibleClient({
      provider: provider({ wireApi: 'responses' }),
      apiKey: 'sk-wire',
      fetch: sseFetch(['{"type":"response.output_text.delta","delta":"嗨"}', '{"type":"response.completed"}'], captured),
    });

    await drain(client.send(request({ system: '你是助手', maxTokens: 555 })));

    expect(captured[0]?.url).toBe('https://wire.test/v1/responses');
    const body = captured[0]?.body ?? {};
    expect(body['instructions']).toBe('你是助手');
    expect(body['max_output_tokens']).toBe(555);
    expect(body['max_tokens']).toBeUndefined();
    expect(body['input']).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('推理摘要与正文分流，函数调用参数分片被还原', async () => {
    const events = await drain(
      new OpenAiCompatibleClient({
        provider: provider({ wireApi: 'responses' }),
        apiKey: 'sk-wire',
        fetch: sseFetch(
          [
            '{"type":"response.reasoning_summary_text.delta","delta":"思路"}',
            '{"type":"response.output_text.delta","delta":"正文"}',
            '{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"list_dir"}}',
            '{"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\".\\"}"}',
            '{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"list_dir"}}',
            '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
          ],
          [],
        ),
      }).send(request()),
    );

    expect(textOf(events)).toBe('正文');
    const reasoning = events.find((event) => event.type === 'reasoning_delta');
    expect(reasoning?.type === 'reasoning_delta' ? reasoning.text : '').toBe('思路');
    const start = events.find((event) => event.type === 'tool_call_start');
    expect(start?.type === 'tool_call_start' ? start.name : '').toBe('list_dir');
    const args = events
      .filter((event): event is { type: 'tool_call_args_delta'; index: number; delta: string } => event.type === 'tool_call_args_delta')
      .map((event) => event.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: '.' });
  });
});

describe('anthropic-messages 线制', () => {
  it('请求打到 /messages，system 为顶层字段，缺失 max_tokens 时用提供商兜底值', async () => {
    const captured: Captured[] = [];
    const client = new AnthropicClient({
      // base_url 止于域名：SDK 自行拼 /v1/messages
      provider: provider({ baseUrl: 'https://wire.test', wireApi: 'anthropic-messages', defaultProtocol: 'anthropic', maxTokensDefault: 2048 }),
      apiKey: 'sk-ant',
      fetch: anthropicSseFetch(
        [
          '{"type":"message_start","message":{"usage":{"input_tokens":4}}}',
          '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
          '{"type":"content_block_stop","index":0}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          '{"type":"message_stop"}',
        ],
        captured,
      ),
    });

    const events = await drain(client.send(request({ system: '你是助手' })));

    expect(captured[0]?.url).toBe('https://wire.test/v1/messages');
    const body = captured[0]?.body ?? {};
    expect(body['system']).toBe('你是助手');
    expect(body['max_tokens']).toBe(2048);
    expect(textOf(events)).toBe('你好');
    const finish = events[events.length - 1];
    expect(finish?.type === 'finish' ? finish.reason : '').toBe('stop');
  });

  it('tool_use 的 input_json_delta 累积后还原为完整参数', async () => {
    const events = await drain(
      new AnthropicClient({
        provider: provider({ baseUrl: 'https://wire.test', wireApi: 'anthropic-messages', defaultProtocol: 'anthropic' }),
        apiKey: 'sk-ant',
        fetch: anthropicSseFetch(
          [
            '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"search","input":{}}}',
            '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
            '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"hap\\"}"}}',
            '{"type":"content_block_stop","index":0}',
            '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
            '{"type":"message_stop"}',
          ],
          [],
        ),
      }).send(request({ tools: [{ name: 'search', input_schema: { type: 'object' } }] })),
    );

    const start = events.find((event) => event.type === 'tool_call_start');
    expect(start?.type === 'tool_call_start' ? start.name : '').toBe('search');
    const args = events
      .filter((event): event is { type: 'tool_call_args_delta'; index: number; delta: string } => event.type === 'tool_call_args_delta')
      .map((event) => event.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ q: 'hap' });
    const finish = events[events.length - 1];
    expect(finish?.type === 'finish' ? finish.reason : '').toBe('tool_calls');
  });

  it('anthropic 预置的 base_url 不带 /v1，否则 SDK 会拼出 /v1/v1/messages', () => {
    const preset = BUILTIN_PROVIDERS['anthropic'];
    expect(preset?.base_url).toBe('https://api.anthropic.com');
    expect(preset?.base_url?.endsWith('/v1')).toBe(false);
  });

  it('OpenAI 线制的预置 base_url 必须带版本段，SDK 不会补', () => {
    for (const id of ['deepseek', 'openai', 'openrouter', 'nous', 'ollama']) {
      expect(BUILTIN_PROVIDERS[id]?.base_url?.endsWith('/v1')).toBe(true);
    }
  });
});
