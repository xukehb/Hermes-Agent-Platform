/**
 * 协议层公共类型（FR-LOOP-011 / FR-LOOP-011A / FR-LOOP-012）。
 *
 * 设计要点：
 * - 内部只存在一份「工具调用抽象」（domain 的 ToolCall / ToolResult），
 *   四个适配器负责把它双向翻译为各厂商线制，因此降级换协议时只需换适配器
 *   重新序列化整段历史即可（FR-LOOP-015），无需保留上一协议的原始请求体。
 * - 解析器输出的是语义事件（ProtocolEvent），而不是厂商事件，智能体循环
 *   因此完全不感知厂商差异。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type {
  AgentMessage,
  FinishReason,
  ProtocolName,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  WireApi,
  WireEvent,
  WireRequest,
} from '../domain/index.js';

/**
 * 协议解析器向智能体循环上报的语义事件。
 *
 * - text / reasoning：面向用户的正文与推理段（FR-LOOP-005 区分存储）
 * - tool_call：一次完整的工具调用；argsError 非空表示参数不是合法 JSON，
 *   由循环按 FR-LOOP-009 回灌校验错误而不是终止任务
 * - incomplete：流结束时仍有未闭合协议标签（FR-LOOP-007），本轮须标记不完整并重试
 */
export type ProtocolEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall; argsError?: string }
  | { type: 'incomplete'; tag: string; raw: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

/** 构造一次请求所需的上下文。 */
export interface AdapterContext {
  /** 目标端点线制。同一协议在 chat 与 responses 下的请求体结构不同 */
  wireApi: WireApi;
  /** provider 侧的模型标识（不含 provider 前缀） */
  model: string;
  /** 已组装好的系统提示词正文（不含 tools 注入，由适配器自行追加） */
  systemPrompt: string;
  /** 本轮可用工具（含 MCP 工具）*/
  tools: readonly ToolDefinition[];
  /** 采样参数，模型级与智能体级合并后的结果 */
  params: Record<string, unknown>;
  /** 输出上限；Anthropic 必填，缺省由适配器兜底（FR-LOOP-011A 第 4 点） */
  maxTokens?: number;
  stop?: readonly string[];
}

/** 增量解析器。push 逐个消费线制事件，end 在流结束时收尾。 */
export interface ProtocolParser {
  push(event: WireEvent): ProtocolEvent[];
  end(): ProtocolEvent[];
}

/** 协议适配器：内部抽象与厂商线制之间的唯一翻译点。 */
export interface ProtocolAdapter {
  readonly name: ProtocolName;
  buildRequest(history: readonly AgentMessage[], ctx: AdapterContext): WireRequest;
  createParser(): ProtocolParser;
}

/** 收集一次完整流的语义事件，便于测试与非流式场景复用。 */
export async function collectProtocolEvents(
  source: AsyncIterable<WireEvent>,
  parser: ProtocolParser,
): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  for await (const wire of source) events.push(...parser.push(wire));
  events.push(...parser.end());
  return events;
}

/** 从语义事件中提取面向用户的正文。 */
export function textOfProtocolEvents(events: readonly ProtocolEvent[]): string {
  return events
    .filter((event): event is { type: 'text'; text: string } => event.type === 'text')
    .map((event) => event.text)
    .join('');
}

/** 从语义事件中提取推理段。 */
export function reasoningOfProtocolEvents(events: readonly ProtocolEvent[]): string {
  return events
    .filter((event): event is { type: 'reasoning'; text: string } => event.type === 'reasoning')
    .map((event) => event.text)
    .join('');
}

/** 从语义事件中提取工具调用。 */
export function toolCallsOfProtocolEvents(events: readonly ProtocolEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) if (event.type === 'tool_call') calls.push(event.call);
  return calls;
}
