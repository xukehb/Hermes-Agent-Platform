/**
 * 协议层测试：标签状态机、线制解析器、四个适配器往返等价、协议探测。
 *
 * 覆盖 FR-LOOP-001~009（ChatML 组装、工具清单注入、标签解析、跨 chunk 还原、
 * 未闭合标记、finish_reason 校正、参数校验回灌）、FR-LOOP-011 / FR-LOOP-011A
 * （四协议线制翻译与 Anthropic 四处不对称）、FR-LOOP-012（协议探测继承链）、
 * FR-LOOP-015（跨协议降级重译整段历史）、FR-CHAN-013（图片与文档附件内联）。
 *
 * 全部离线运行：模型输出由 MockProviderClient 脚本化，附件写入临时目录真实落盘，
 * 不读取 process.env，避免开发机上的第三方端点变量干扰断言。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentMessage, ToolCall, ToolDefinition, WireApi, WireEvent } from '../src/domain/index.js';
import { MockProviderClient, textTurn, toolCallTurn } from '../src/providers/index.js';
import {
  AnthropicAdapter,
  DeepSeekAdapter,
  GLOBAL_DEFAULT_PROTOCOL,
  HERMES_TAGS,
  HermesNativeAdapter,
  IM_END,
  IM_START,
  OpenAiToolsAdapter,
  PROTOCOL_NAMES,
  StreamTagParser,
  WireProtocolParser,
  collectProtocolEvents,
  collectSystemPrompt,
  composeHermesSystem,
  detectProtocol,
  estimateHistoryTokens,
  estimateTokens,
  normalizeSchema,
  parseToolArguments,
  protocolAdapter,
  reasoningOfProtocolEvents,
  renderChatML,
  renderToolCallTag,
  renderToolResponseTag,
  splitUserContent,
  suffixPrefixLength,
  textOfProtocolEvents,
  toolCallsOfProtocolEvents,
  toolResultText,
  type AdapterContext,
  type ProtocolEvent,
  type ProtocolParser,
  type TagEvent,
} from '../src/protocol/index.js';

/** 断言式取值：tsconfig 开启 noUncheckedIndexedAccess，测试内统一收敛越界处理。 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error('索引越界：' + String(index));
  return item;
}

/** 把线制侧的 unknown 视为对象，便于逐字段断言。 */
function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('期望对象，实际：' + JSON.stringify(value));
  }
  return value as Record<string, unknown>;
}

/** 把线制侧的 unknown 视为数组。 */
function arr(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('期望数组，实际：' + JSON.stringify(value));
  return value as unknown[];
}

/** responses 线制条目的判别字段：工具条目看 type，普通消息看 role。 */
function entryKind(entry: unknown): string {
  const record = rec(entry);
  const type = record.type;
  if (typeof type === 'string') return type;
  const role = record.role;
  return typeof role === 'string' ? role : 'unknown';
}

/** 逐字符喂入，模拟最恶劣的分片：任何标签都会被切断。 */
function feedChars(parser: StreamTagParser, text: string): TagEvent[] {
  const events: TagEvent[] = [];
  for (const char of text) events.push(...parser.push(char));
  events.push(...parser.end());
  return events;
}

/** 抽取 close 事件的标签名与标签体。 */
function closedTags(events: readonly TagEvent[]): { name: string; content: string }[] {
  const result: { name: string; content: string }[] = [];
  for (const event of events) {
    if (event.kind === 'close') result.push({ name: event.name, content: event.content });
  }
  return result;
}

/** 按事件种类抽取标签名，保持出现顺序。 */
function tagNames(events: readonly TagEvent[], kind: TagEvent['kind']): string[] {
  const names: string[] = [];
  for (const event of events) {
    if (event.kind === kind && 'name' in event) names.push(event.name);
  }
  return names;
}

/** 拼接标签状态机吐出的普通文本。 */
function plainText(events: readonly TagEvent[]): string {
  return events
    .filter((event): event is { kind: 'text'; text: string } => event.kind === 'text')
    .map((event) => event.text)
    .join('');
}

/** 顺序喂入线制事件并收尾，返回全部语义事件。 */
function runWire(parser: ProtocolParser, events: readonly WireEvent[]): ProtocolEvent[] {
  const output: ProtocolEvent[] = [];
  for (const event of events) output.push(...parser.push(event));
  output.push(...parser.end());
  return output;
}

/** 语义事件的类型序列，用于断言顺序（incomplete 必须排在 finish 之前）。 */
function typesOf(events: readonly ProtocolEvent[]): string[] {
  return events.map((event) => event.type);
}

/** 取出 finish 事件的原因。 */
function finishOf(events: readonly ProtocolEvent[]): string | undefined {
  for (const event of events) if (event.type === 'finish') return event.reason;
  return undefined;
}

/** 取出全部 tool_call 语义事件（含 argsError）。 */
function toolEventsOf(events: readonly ProtocolEvent[]): { call: ToolCall; argsError?: string }[] {
  const result: { call: ToolCall; argsError?: string }[] = [];
  for (const event of events) {
    if (event.type !== 'tool_call') continue;
    const entry: { call: ToolCall; argsError?: string } = { call: event.call };
    if (event.argsError !== undefined) entry.argsError = event.argsError;
    result.push(entry);
  }
  return result;
}

/** 第二个工具的 parameters 故意缺 type，用于验证 normalizeSchema 兜底。 */
const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'shell',
    description: '执行 shell 命令',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    source: 'builtin',
  },
  {
    name: 'read_file',
    description: '读取文件内容',
    parameters: { properties: { path: { type: 'string' } }, required: ['path'] },
    source: 'builtin',
  },
];

/** 构造适配器上下文，可选项按需赋值以满足 exactOptionalPropertyTypes。 */
function ctx(
  patch: {
    wireApi?: WireApi;
    model?: string;
    systemPrompt?: string;
    tools?: readonly ToolDefinition[];
    params?: Record<string, unknown>;
    maxTokens?: number;
    stop?: readonly string[];
  } = {},
): AdapterContext {
  const value: AdapterContext = {
    wireApi: patch.wireApi ?? 'chat',
    model: patch.model ?? 'test-model',
    systemPrompt: patch.systemPrompt ?? '你是测试助手',
    tools: patch.tools ?? [],
    params: patch.params ?? { temperature: 0.3 },
  };
  if (patch.maxTokens !== undefined) value.maxTokens = patch.maxTokens;
  if (patch.stop !== undefined) value.stop = patch.stop;
  return value;
}

/** 公共历史：含 system 追加、工具调用、工具结果、后续追问，四个适配器共用同一份。 */
function baseHistory(): AgentMessage[] {
  return [
    { role: 'system', content: '追加的系统约束：输出中文。' },
    { role: 'user', content: '看看当前目录' },
    {
      role: 'assistant',
      content: '我先看目录。',
      reasoning: '需要列目录',
      toolCalls: [{ id: 'call_a1', name: 'shell', args: { command: 'ls -la' } }],
    },
    {
      role: 'tool',
      content: '',
      toolResult: { callId: 'call_a1', name: 'shell', content: 'a.txt\nb.txt', isError: false },
    },
    { role: 'assistant', content: '目录里有两个文件。' },
    { role: 'user', content: '读一下 a.txt' },
  ];
}

describe('StreamTagParser 跨 chunk 还原', () => {
  it('逐字符切断的 <tool_call> 仍能完整还原', () => {
    const payload = JSON.stringify({ name: 'shell', arguments: { command: 'ls -la' } });
    const parser = new StreamTagParser();
    const events = feedChars(parser, '开始' + '<tool_call>' + payload + '</tool_call>' + '结束');
    expect(closedTags(events)).toEqual([{ name: 'tool_call', content: payload }]);
    expect(plainText(events)).toBe('开始结束');
    expect(parser.openTag).toBeUndefined();
    expect(parser.pendingSize).toBe(0);
  });

  it('单个 chunk 内的多个 <tool_call> 依次输出', () => {
    const first = JSON.stringify({ name: 'shell', arguments: { command: 'pwd' } });
    const second = JSON.stringify({ name: 'read_file', arguments: { path: 'a.txt' } });
    const parser = new StreamTagParser();
    const events = [
      ...parser.push('<tool_call>' + first + '</tool_call>\n<tool_call>' + second + '</tool_call>'),
      ...parser.end(),
    ];
    expect(closedTags(events).map((tag) => tag.content)).toEqual([first, second]);
  });

  it('<think> 与 <tool_call> 混排时顺序保持', () => {
    const payload = JSON.stringify({ name: 'shell', arguments: {} });
    const parser = new StreamTagParser();
    const events = feedChars(parser, '<think>先想想</think>正文<tool_call>' + payload + '</tool_call>');
    expect(tagNames(events, 'open')).toEqual(['think', 'tool_call']);
    expect(closedTags(events)).toEqual([
      { name: 'think', content: '先想想' },
      { name: 'tool_call', content: payload },
    ]);
    expect(plainText(events)).toBe('正文');
  });

  it('标签体含转义引号与嵌套 JSON 时不误判', () => {
    const payload = JSON.stringify({
      name: 'write_file',
      arguments: { path: 'a.md', content: '标题 "引号" 与 <b>标记</b>', meta: { nested: [1, 2, 3] } },
    });
    const parser = new StreamTagParser();
    const events = feedChars(parser, '<tool_call>' + payload + '</tool_call>');
    expect(closedTags(events)).toEqual([{ name: 'tool_call', content: payload }]);
    expect(JSON.parse(at(closedTags(events), 0).content)).toEqual(JSON.parse(payload));
  });

  it('未闭合标签在流末尾输出 unclosed 并保留已收内容', () => {
    const payload = JSON.stringify({ name: 'list_dir', arguments: {} });
    const parser = new StreamTagParser();
    const events = feedChars(parser, '<tool_call>' + payload.slice(0, 12));
    expect(tagNames(events, 'unclosed')).toEqual(['tool_call']);
    expect(closedTags(events)).toEqual([]);
    const unclosed = events.filter((event) => event.kind === 'unclosed');
    expect(unclosed).toHaveLength(1);
  });

  it('孤立的 < 与非注册标签按普通文本输出', () => {
    const parser = new StreamTagParser();
    const events = feedChars(parser, '1 < 2 且 3 <tool 4');
    expect(plainText(events)).toBe('1 < 2 且 3 <tool 4');
    expect(closedTags(events)).toEqual([]);
  });

  it('流末尾残留的标签前缀作为文本吐出', () => {
    const parser = new StreamTagParser();
    const events = [...parser.push('尾部<too'), ...parser.end()];
    expect(plainText(events)).toBe('尾部<too');
  });

  it('suffixPrefixLength 计算闭合标签的重叠长度', () => {
    expect(suffixPrefixLength('abc</too', '</tool_call>')).toBe(5);
    expect(suffixPrefixLength('普通文本', '</tool_call>')).toBe(0);
  });
});

describe('WireProtocolParser 语义事件', () => {
  it('未闭合标签事件排在 finish 之前', () => {
    const truncated = JSON.stringify({ name: 'shell', arguments: { command: 'ls' } }).slice(0, 12);
    const parser = new WireProtocolParser({ tags: HERMES_TAGS });
    const events = runWire(parser, [
      { type: 'text_delta', text: '<tool_call>' + truncated },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(typesOf(events)).toEqual(['incomplete', 'finish']);
    expect(finishOf(events)).toBe('stop');
    expect(toolCallsOfProtocolEvents(events)).toHaveLength(0);
  });

  it('缺少 tool_call_end 时在流末尾收口并校正 finish_reason', () => {
    const parser = new WireProtocolParser();
    const events = runWire(parser, [
      { type: 'tool_call_start', index: 0, id: 'call_9', name: 'shell' },
      { type: 'tool_call_args_delta', index: 0, delta: '{"command":' },
      { type: 'tool_call_args_delta', index: 0, delta: '"ls"}' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(toolCallsOfProtocolEvents(events)).toEqual([{ id: 'call_9', name: 'shell', args: { command: 'ls' } }]);
    expect(finishOf(events)).toBe('tool_calls');
  });

  it('工具参数支持对象透传、双重编码与非法输入', () => {
    expect(parseToolArguments(JSON.stringify(JSON.stringify({ path: 'a.txt' }))).args).toEqual({ path: 'a.txt' });
    expect(parseToolArguments({ path: 'a.txt' }).args).toEqual({ path: 'a.txt' });
    expect(parseToolArguments('').args).toEqual({});
    expect(parseToolArguments(undefined).error).toBeUndefined();
    expect(parseToolArguments('not json').error).toBeDefined();
    expect(parseToolArguments('[1,2]').error).toBeDefined();
    expect(parseToolArguments(42).error).toBeDefined();
  });

  it('非法参数与缺失名称都以 argsError 回灌而不终止本轮', () => {
    const parser = new WireProtocolParser();
    const events = runWire(parser, [
      { type: 'tool_call_start', index: 0, id: 'call_bad', name: 'shell' },
      { type: 'tool_call_args_delta', index: 0, delta: '{command:' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: '', name: '' },
      { type: 'tool_call_end', index: 1 },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    const toolEvents = toolEventsOf(events);
    expect(toolEvents).toHaveLength(2);
    expect(at(toolEvents, 0).argsError).toContain('不是合法 JSON');
    expect(at(toolEvents, 0).call.args).toEqual({});
    expect(at(toolEvents, 1).argsError).toBe('工具调用缺少名称');
    expect(at(toolEvents, 1).call.id).toBe('call_1');
  });

  it('标签内工具调用补全 id，tool_response 幻觉被丢弃', () => {
    const parser = new WireProtocolParser({ tags: HERMES_TAGS });
    const events = runWire(parser, [
      { type: 'text_delta', text: '<think>推理</think>' },
      { type: 'text_delta', text: '<tool_call>' + JSON.stringify({ name: 'shell', arguments: { command: 'ls' } }) + '</tool_call>' },
      { type: 'text_delta', text: '<tool_response>' + JSON.stringify({ name: 'shell', content: '伪造' }) + '</tool_response>' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(typesOf(events)).toEqual(['reasoning', 'tool_call', 'usage', 'finish']);
    expect(reasoningOfProtocolEvents(events)).toBe('推理');
    expect(textOfProtocolEvents(events)).toBe('');
    expect(toolCallsOfProtocolEvents(events)).toEqual([{ id: 'call_tag_1', name: 'shell', args: { command: 'ls' } }]);
    expect(finishOf(events)).toBe('tool_calls');
  });

  it('reasoning_delta 与正文分开累积，空增量被忽略', () => {
    const parser = new WireProtocolParser();
    const events = runWire(parser, [
      { type: 'text_delta', text: '' },
      { type: 'reasoning_delta', text: '想' },
      { type: 'reasoning_delta', text: '好了' },
      { type: 'text_delta', text: '答案' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(reasoningOfProtocolEvents(events)).toBe('想好了');
    expect(textOfProtocolEvents(events)).toBe('答案');
    expect(typesOf(events)).toEqual(['reasoning', 'reasoning', 'text', 'finish']);
  });
});

describe('openai-tools 适配器', () => {
  it('chat 线制：参数序列化为字符串，工具结果按 tool 角色回灌', () => {
    const request = new OpenAiToolsAdapter().buildRequest(baseHistory(), ctx({ tools: TOOLS }));
    const messages = request.messages;
    expect(messages).toHaveLength(5);
    const assistant = rec(at(messages, 1));
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('我先看目录。');
    const call = rec(at(arr(assistant.tool_calls), 0));
    expect(call.id).toBe('call_a1');
    expect(call.type).toBe('function');
    expect(rec(call.function).name).toBe('shell');
    expect(rec(call.function).arguments).toBe(JSON.stringify({ command: 'ls -la' }));
    expect(rec(at(messages, 2))).toEqual({ role: 'tool', tool_call_id: 'call_a1', content: 'a.txt\nb.txt' });
    expect(request.system).toBe('你是测试助手\n\n追加的系统约束：输出中文。');
    expect(request.params).toEqual({ temperature: 0.3 });
    const schemas = arr(request.tools);
    expect(rec(rec(at(schemas, 0)).function).name).toBe('shell');
    expect(rec(rec(rec(at(schemas, 1)).function).parameters).type).toBe('object');
  });

  it('assistant 仅有工具调用时 content 置 null', () => {
    const request = new OpenAiToolsAdapter().buildRequest(
      [
        { role: 'user', content: '开始' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'shell', args: {} }] },
      ],
      ctx(),
    );
    expect(rec(at(request.messages, 1)).content).toBeNull();
    expect(rec(rec(at(arr(rec(at(request.messages, 1)).tool_calls), 0)).function).arguments).toBe('{}');
  });

  it('responses 线制：function_call 与 function_call_output 独立成条，工具声明扁平', () => {
    const request = new OpenAiToolsAdapter().buildRequest(
      baseHistory(),
      ctx({ wireApi: 'responses', tools: TOOLS, maxTokens: 1024, stop: ['<|im_end|>'] }),
    );
    const input = request.messages;
    expect(input.map((entry) => entryKind(entry))).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
      'assistant',
      'user',
    ]);
    const fnCall = rec(at(input, 2));
    expect(fnCall.call_id).toBe('call_a1');
    expect(fnCall.name).toBe('shell');
    expect(fnCall.arguments).toBe(JSON.stringify({ command: 'ls -la' }));
    expect(rec(at(input, 3)).output).toBe('a.txt\nb.txt');
    expect(rec(at(arr(rec(at(input, 0)).content), 0)).type).toBe('input_text');
    const schemas = arr(request.tools);
    expect(rec(at(schemas, 0)).type).toBe('function');
    expect(rec(at(schemas, 0)).name).toBe('shell');
    expect(request.maxTokens).toBe(1024);
    expect(request.stop).toEqual(['<|im_end|>']);
  });

  it('deepseek 请求体与 openai-tools 完全一致', () => {
    const history = baseHistory();
    const deepseek = new DeepSeekAdapter().buildRequest(history, ctx({ tools: TOOLS }));
    const openai = new OpenAiToolsAdapter().buildRequest(history, ctx({ tools: TOOLS }));
    expect(deepseek).toEqual(openai);
    expect(new DeepSeekAdapter().name).toBe('deepseek');
  });
});

describe('anthropic 适配器四处不对称（FR-LOOP-011A）', () => {
  it('input_schema 字段名、input 为对象、tool_result 走 user 角色、max_tokens 透传', () => {
    const request = new AnthropicAdapter().buildRequest(
      baseHistory(),
      ctx({ wireApi: 'anthropic-messages', tools: TOOLS, maxTokens: 4096 }),
    );
    const messages = request.messages;
    expect(messages.map((message) => rec(message).role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const assistantBlocks = arr(rec(at(messages, 1)).content);
    expect(rec(at(assistantBlocks, 0))).toEqual({ type: 'text', text: '我先看目录。' });
    const toolUse = rec(at(assistantBlocks, 1));
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.id).toBe('call_a1');
    expect(typeof toolUse.input).toBe('object');
    expect(toolUse.input).toEqual({ command: 'ls -la' });
    const resultBlock = rec(at(arr(rec(at(messages, 2)).content), 0));
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.tool_use_id).toBe('call_a1');
    expect(resultBlock.content).toBe('a.txt\nb.txt');
    expect(resultBlock.is_error).toBeUndefined();
    const schema = rec(at(arr(request.tools), 0));
    expect(schema.input_schema).toEqual(TOOLS[0]?.parameters);
    expect(schema.parameters).toBeUndefined();
    expect(rec(rec(at(arr(request.tools), 1)).input_schema).type).toBe('object');
    expect(request.maxTokens).toBe(4096);
    expect(request.system).toBe('你是测试助手\n\n追加的系统约束：输出中文。');
  });

  it('相邻同角色消息合并，首条为 assistant 时补引导 user', () => {
    const request = new AnthropicAdapter().buildRequest(
      [
        { role: 'assistant', content: '继续之前的结论。', toolCalls: [{ id: 'c1', name: 'shell', args: { command: 'ls' } }] },
        { role: 'tool', content: '', toolResult: { callId: 'c1', name: 'shell', content: 'ok', isError: false } },
        { role: 'tool', content: '', toolResult: { callId: 'c2', name: 'read_file', content: '读取失败', isError: true } },
      ],
      ctx({ wireApi: 'anthropic-messages' }),
    );
    const messages = request.messages;
    expect(messages.map((message) => rec(message).role)).toEqual(['user', 'assistant', 'user']);
    expect(rec(at(messages, 0)).content).toEqual([{ type: 'text', text: '（以下为历史对话，请据此继续）' }]);
    const merged = arr(rec(at(messages, 2)).content);
    expect(merged).toHaveLength(2);
    expect(rec(at(merged, 0)).tool_use_id).toBe('c1');
    expect(rec(at(merged, 1)).is_error).toBe(true);
  });

  it('工具结果被裁剪时附带完整输出落盘路径', () => {
    const text = toolResultText({
      callId: 'c1',
      name: 'shell',
      content: '前若干行',
      isError: false,
      overflowPath: '/tmp/hap/overflow-1.txt',
    });
    expect(text).toContain('前若干行');
    expect(text).toContain('/tmp/hap/overflow-1.txt');
  });
});

describe('hermes-native 适配器', () => {
  it('工具清单进 system 的 <tools>，请求体不带 tools 字段', () => {
    const request = new HermesNativeAdapter().buildRequest(baseHistory(), ctx({ tools: TOOLS }));
    expect(request.tools).toBeUndefined();
    const system = String(request.system);
    expect(system).toContain('你是测试助手');
    expect(system).toContain('追加的系统约束：输出中文。');
    expect(system).toContain('<tools>');
    expect(system).toContain('"name":"shell"');
    expect(system).toContain('<tool_call>');
    const messages = request.messages;
    expect(rec(at(messages, 1)).content).toBe('我先看目录。\n' + renderToolCallTag('shell', { command: 'ls -la' }));
    const toolMessage = rec(at(messages, 2));
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.content).toBe(renderToolResponseTag('shell', 'a.txt\nb.txt', false));
  });

  it('自家序列化的 <tool_call> 能被自家解析器原样还原（往返等价）', () => {
    const adapter = new HermesNativeAdapter();
    const serialized = String(rec(at(adapter.buildRequest(baseHistory(), ctx({ tools: TOOLS })).messages, 1)).content);
    const events = runWire(adapter.createParser(), [
      { type: 'text_delta', text: serialized },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(textOfProtocolEvents(events).trim()).toBe('我先看目录。');
    expect(toolCallsOfProtocolEvents(events)).toEqual([
      { id: 'call_tag_1', name: 'shell', args: { command: 'ls -la' } },
    ]);
    expect(finishOf(events)).toBe('tool_calls');
  });
});

describe('FR-LOOP-015 跨协议降级重译整段历史', () => {
  it('同一份历史翻译到三种线制后工具调用与结果都完整且格式各自正确', () => {
    const shared = baseHistory();
    const anthropic = new AnthropicAdapter().buildRequest(
      shared,
      ctx({ wireApi: 'anthropic-messages', tools: TOOLS, maxTokens: 2048 }),
    );
    const openai = new OpenAiToolsAdapter().buildRequest(shared, ctx({ tools: TOOLS }));
    const hermes = new HermesNativeAdapter().buildRequest(shared, ctx({ tools: TOOLS }));

    const toolUse = rec(at(arr(rec(at(anthropic.messages, 1)).content), 1));
    const openaiFunction = rec(rec(at(arr(rec(at(openai.messages, 1)).tool_calls), 0)).function);
    expect(toolUse.input).toEqual({ command: 'ls -la' });
    expect(typeof openaiFunction.arguments).toBe('string');
    expect(JSON.parse(String(openaiFunction.arguments))).toEqual(toolUse.input);
    expect(String(rec(at(hermes.messages, 1)).content)).toContain('<tool_call>');

    expect(rec(at(arr(rec(at(anthropic.messages, 2)).content), 0)).tool_use_id).toBe('call_a1');
    expect(rec(at(openai.messages, 2)).tool_call_id).toBe('call_a1');
    expect(String(rec(at(hermes.messages, 2)).content)).toContain('<tool_response>');

    expect(anthropic.tools).toBeDefined();
    expect(openai.tools).toBeDefined();
    expect(hermes.tools).toBeUndefined();
    expect(shared).toEqual(baseHistory());
  });
});

describe('协议探测继承链（FR-LOOP-012）', () => {
  it('五个层级逐级命中并记录来源', () => {
    expect(
      detectProtocol({
        agentProtocol: 'anthropic',
        modelProtocol: 'deepseek',
        providerDefault: 'openai-tools',
        model: 'hermes-4',
      }),
    ).toEqual({ protocol: 'anthropic', source: 'agent-explicit' });
    expect(detectProtocol({ modelProtocol: 'deepseek', providerDefault: 'openai-tools', model: 'hermes-4' })).toEqual({
      protocol: 'deepseek',
      source: 'model-explicit',
    });
    expect(detectProtocol({ providerDefault: 'openai-tools', model: 'Hermes-4-405B' })).toEqual({
      protocol: 'hermes-native',
      source: 'model-name-hermes',
    });
    expect(detectProtocol({ providerDefault: 'anthropic', model: 'claude-sonnet-4-5' })).toEqual({
      protocol: 'anthropic',
      source: 'provider-default',
    });
    expect(detectProtocol({ model: 'glm-4.6' })).toEqual({
      protocol: GLOBAL_DEFAULT_PROTOCOL,
      source: 'global-default',
    });
  });

  it('注册表覆盖四个协议且适配器单例可复用', () => {
    expect([...PROTOCOL_NAMES].sort()).toEqual(['anthropic', 'deepseek', 'hermes-native', 'openai-tools']);
    for (const name of PROTOCOL_NAMES) expect(protocolAdapter(name).name).toBe(name);
    expect(protocolAdapter('deepseek')).toBe(protocolAdapter('deepseek'));
    expect(protocolAdapter('deepseek')).toBeInstanceOf(DeepSeekAdapter);
    expect(protocolAdapter('deepseek')).toBeInstanceOf(OpenAiToolsAdapter);
  });
});

describe('端到端：脚本化模型输出驱动解析', () => {
  it('openai-tools 线制的分片工具调用完整重组', async () => {
    const adapter = protocolAdapter('openai-tools');
    const client = new MockProviderClient({
      turns: [toolCallTurn([{ id: 'call_x', name: 'shell', args: { command: 'ls' } }], { text: '先看看目录', chunkSize: 2 })],
    });
    const request = adapter.buildRequest(baseHistory(), ctx({ tools: TOOLS }));
    const events = await collectProtocolEvents(client.send(request), adapter.createParser());
    expect(textOfProtocolEvents(events)).toBe('先看看目录');
    expect(toolCallsOfProtocolEvents(events)).toEqual([{ id: 'call_x', name: 'shell', args: { command: 'ls' } }]);
    expect(finishOf(events)).toBe('tool_calls');
    expect(client.lastRequest?.model).toBe('test-model');
  });

  it('deepseek 线制把代理内联的 <think> 分离为推理段', async () => {
    const adapter = protocolAdapter('deepseek');
    const client = new MockProviderClient({ turns: [textTurn('<think>思考中</think>最终答案', { chunkSize: 4 })] });
    const events = await collectProtocolEvents(
      client.send(adapter.buildRequest(baseHistory(), ctx())),
      adapter.createParser(),
    );
    expect(reasoningOfProtocolEvents(events)).toBe('思考中');
    expect(textOfProtocolEvents(events)).toBe('最终答案');
    expect(finishOf(events)).toBe('stop');
  });

  it('hermes-native 线制端到端：推理、正文、标签调用与 finish 校正', async () => {
    const adapter = protocolAdapter('hermes-native');
    const payload = JSON.stringify({ name: 'read_file', arguments: { path: 'a.txt' } });
    const client = new MockProviderClient({
      turns: [textTurn('<think>先读文件</think>我来读取。<tool_call>' + payload + '</tool_call>', { chunkSize: 3 })],
    });
    const events = await collectProtocolEvents(
      client.send(adapter.buildRequest(baseHistory(), ctx({ tools: TOOLS }))),
      adapter.createParser(),
    );
    expect(reasoningOfProtocolEvents(events)).toBe('先读文件');
    expect(textOfProtocolEvents(events)).toBe('我来读取。');
    expect(toolCallsOfProtocolEvents(events)).toEqual([
      { id: 'call_tag_1', name: 'read_file', args: { path: 'a.txt' } },
    ]);
    expect(finishOf(events)).toBe('tool_calls');
  });

  it('流在标签中途断开时标记不完整且不执行其中调用', async () => {
    const adapter = protocolAdapter('hermes-native');
    const truncated = '<tool_call>' + JSON.stringify({ name: 'shell', arguments: { command: 'ls' } }).slice(0, 10);
    const client = new MockProviderClient({ turns: [textTurn('正文' + truncated, { chunkSize: 5 })] });
    const events = await collectProtocolEvents(
      client.send(adapter.buildRequest(baseHistory(), ctx({ tools: TOOLS }))),
      adapter.createParser(),
    );
    expect(typesOf(events)).toEqual(['text', 'incomplete', 'finish']);
    expect(textOfProtocolEvents(events)).toBe('正文');
    expect(toolCallsOfProtocolEvents(events)).toHaveLength(0);
  });
});

describe('附件内联（FR-CHAN-013）', () => {
  it('图片按线制分别编码，文本文档内联为正文，其余降级为路径说明', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-protocol-'));
    const imagePath = join(dir, 'shot.png');
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    writeFileSync(imagePath, pngBytes);
    const docPath = join(dir, 'note.md');
    writeFileSync(docPath, '# 备注\n第一行', 'utf8');
    const message: AgentMessage = {
      role: 'user',
      content: '看这张图和这份文档',
      attachments: [
        { kind: 'image', path: imagePath, fileName: 'shot.png' },
        { kind: 'document', path: docPath, fileName: 'note.md' },
        { kind: 'audio', path: join(dir, 'missing.ogg') },
      ],
    };

    const content = splitUserContent(message);
    expect(content.images).toHaveLength(1);
    expect(at(content.images, 0).mediaType).toBe('image/png');
    expect(at(content.images, 0).data).toBe(pngBytes.toString('base64'));
    expect(content.text).toContain('# 备注');
    expect(content.text).toContain('missing.ogg');

    const chatParts = arr(rec(at(new OpenAiToolsAdapter().buildRequest([message], ctx()).messages, 0)).content);
    expect(rec(at(chatParts, 0)).type).toBe('text');
    expect(String(rec(rec(at(chatParts, 1)).image_url).url)).toContain('data:image/png;base64,');

    const blocks = arr(
      rec(at(new AnthropicAdapter().buildRequest([message], ctx({ wireApi: 'anthropic-messages' })).messages, 0)).content,
    );
    expect(rec(at(blocks, 0)).type).toBe('image');
    expect(rec(rec(at(blocks, 0)).source).media_type).toBe('image/png');
    expect(rec(rec(at(blocks, 0)).source).type).toBe('base64');
    expect(rec(at(blocks, 1)).type).toBe('text');
  });
});

describe('ChatML 组装与 token 估算', () => {
  it('renderChatML 输出 ChatML 分隔符并覆盖推理与工具标签', () => {
    const rendered = renderChatML(baseHistory(), { system: '你是测试助手', addGenerationPrompt: true });
    expect(rendered.startsWith(IM_START + 'system')).toBe(true);
    expect(rendered).toContain(IM_END);
    expect(rendered).toContain('<think>需要列目录</think>');
    expect(rendered).toContain('<tool_call>');
    expect(rendered).toContain('<tool_response>');
    expect(rendered.endsWith(IM_START + 'assistant\n')).toBe(true);
  });

  it('composeHermesSystem 在无工具时不注入 <tools>', () => {
    expect(composeHermesSystem('你是测试助手', [])).toBe('你是测试助手');
    expect(composeHermesSystem('', TOOLS)).toContain('<tools>');
  });

  it('estimateTokens 中文按字符计、英文按四字符计', () => {
    expect(estimateTokens('中文四个字')).toBe(5);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    expect(estimateHistoryTokens(baseHistory(), '你是测试助手')).toBeGreaterThan(
      estimateHistoryTokens(baseHistory().slice(0, 2), '你是测试助手'),
    );
  });

  it('collectSystemPrompt 合并智能体提示词与历史 system 消息', () => {
    expect(
      collectSystemPrompt('  基础  ', [
        { role: 'system', content: '追加一' },
        { role: 'user', content: '正文' },
        { role: 'system', content: ' 追加二 ' },
      ]),
    ).toBe('基础\n\n追加一\n\n追加二');
    expect(collectSystemPrompt('', [])).toBe('');
  });

  it('normalizeSchema 缺 type 时补 object', () => {
    expect(normalizeSchema({ properties: {} }).type).toBe('object');
    expect(normalizeSchema({ type: 'string' })).toEqual({ type: 'string' });
  });
});
