/**
 * anthropic 适配器（FR-LOOP-011 / FR-LOOP-011A）。
 *
 * 四处不对称在此集中处理：
 * 1. 工具参数 Schema 字段名是 input_schema，而非 function.parameters；
 * 2. tool_use.input 已是对象，翻译进内部抽象时不再解析，反向翻译至 OpenAI
 *    线制时才序列化为字符串（见 adapters/openai-tools.ts）；
 * 3. 工具结果封装为 tool_result 内容块并以 user 角色回灌，tool_use_id 必须
 *    与请求侧 tool_use.id 严格对应；
 * 4. max_tokens 必填，缺省由 provider 客户端按厂商能力表兜底。
 *
 * 另外 Anthropic 要求消息角色交替且首条为 user，因此同角色相邻消息会被合并，
 * 首条为 assistant 时补一条引导用的 user 消息，避免整轮请求被端点直接拒绝。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage, ToolDefinition, WireRequest } from '../../domain/index.js';
import { collectSystemPrompt, normalizeSchema, splitUserContent, toolResultText } from '../message-parts.js';
import type { AdapterContext, ProtocolAdapter, ProtocolParser } from '../types.js';
import { WireProtocolParser } from '../wire-parser.js';

/** 首条消息为 assistant 时补位的引导语。 */
const LEADING_USER_FILLER = '（以下为历史对话，请据此继续）';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: unknown[];
}

/** 工具声明：input_schema（FR-LOOP-011A 第 1 点）。 */
export function anthropicToolSchemas(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: normalizeSchema(tool.parameters),
  }));
}

/** 相邻同角色消息合并，保证 user/assistant 交替。 */
function append(messages: AnthropicMessage[], role: 'user' | 'assistant', blocks: readonly unknown[]): void {
  if (blocks.length === 0) return;
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  if (last !== undefined && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: [...blocks] });
}

export function buildAnthropicMessages(history: readonly AgentMessage[]): unknown[] {
  const messages: AnthropicMessage[] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result = message.toolResult;
      if (result === undefined) continue;
      const block: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: result.callId,
        content: toolResultText(result),
      };
      if (result.isError) block.is_error = true;
      // 第 3 点：以 user 角色回灌
      append(messages, 'user', [block]);
      continue;
    }
    if (message.role === 'user') {
      const content = splitUserContent(message);
      const blocks: unknown[] = [];
      for (const image of content.images) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
      }
      if (content.text !== '') blocks.push({ type: 'text', text: content.text });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      append(messages, 'user', blocks);
      continue;
    }
    const blocks: unknown[] = [];
    if (message.content !== '') blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      // 第 2 点：input 直接给对象，不做二次序列化
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    }
    append(messages, 'assistant', blocks);
  }
  const first = messages.length > 0 ? messages[0] : undefined;
  if (first !== undefined && first.role === 'assistant') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: LEADING_USER_FILLER }] });
  }
  return messages;
}

export class AnthropicAdapter implements ProtocolAdapter {
  readonly name = 'anthropic' as const;

  buildRequest(history: readonly AgentMessage[], ctx: AdapterContext): WireRequest {
    const request: WireRequest = {
      model: ctx.model,
      messages: buildAnthropicMessages(history),
      params: { ...ctx.params },
    };
    const system = collectSystemPrompt(ctx.systemPrompt, history);
    if (system !== '') request.system = system;
    if (ctx.tools.length > 0) request.tools = anthropicToolSchemas(ctx.tools);
    if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
    if (ctx.stop !== undefined && ctx.stop.length > 0) request.stop = [...ctx.stop];
    return request;
  }

  createParser(): ProtocolParser {
    // thinking_delta 已由 provider 客户端归一为 reasoning_delta，无需标签分流
    return new WireProtocolParser();
  }
}
