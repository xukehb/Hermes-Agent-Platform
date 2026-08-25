/**
 * openai-tools 适配器（FR-LOOP-011）。
 *
 * 覆盖 OpenAI、Google Gemini 兼容端点、智谱 GLM、OpenRouter 及任意 OpenAI
 * 兼容实现。同一协议在两种线制下请求体不同：chat 用 messages + tool_calls，
 * responses 用 input 数组 + function_call / function_call_output 条目，
 * 因此 buildRequest 依 ctx.wireApi 分流（AC-013 要求同厂商两种线制并存）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage, ProtocolName, ToolDefinition, WireRequest } from '../../domain/index.js';
import {
  collectSystemPrompt,
  normalizeSchema,
  splitUserContent,
  toolResultText,
} from '../message-parts.js';
import type { AdapterContext, ProtocolAdapter, ProtocolParser } from '../types.js';
import { WireProtocolParser } from '../wire-parser.js';

/** chat 线制的工具声明：tools[].function.parameters */
export function chatToolSchemas(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeSchema(tool.parameters),
    },
  }));
}

/** responses 线制的工具声明是扁平结构。 */
export function responsesToolSchemas(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: normalizeSchema(tool.parameters),
  }));
}

/** chat 线制的用户内容：纯文本直接给字符串，含图片时给多模态数组。 */
function chatUserContent(message: AgentMessage): unknown {
  const content = splitUserContent(message);
  if (content.images.length === 0) return content.text;
  const parts: unknown[] = [];
  if (content.text !== '') parts.push({ type: 'text', text: content.text });
  for (const image of content.images) {
    parts.push({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } });
  }
  return parts;
}

/** responses 线制的用户内容一律用 input_* 分块。 */
function responsesUserContent(message: AgentMessage): unknown {
  const content = splitUserContent(message);
  const parts: unknown[] = [];
  if (content.text !== '') parts.push({ type: 'input_text', text: content.text });
  for (const image of content.images) {
    parts.push({ type: 'input_image', image_url: 'data:' + image.mediaType + ';base64,' + image.data });
  }
  if (parts.length === 0) parts.push({ type: 'input_text', text: '' });
  return parts;
}

export function buildChatMessages(history: readonly AgentMessage[]): unknown[] {
  const messages: unknown[] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result = message.toolResult;
      if (result === undefined) continue;
      messages.push({ role: 'tool', tool_call_id: result.callId, content: toolResultText(result) });
      continue;
    }
    if (message.role === 'user') {
      messages.push({ role: 'user', content: chatUserContent(message) });
      continue;
    }
    const calls = message.toolCalls ?? [];
    // 带 tool_calls 时 content 必须是 null 或非空字符串，空串会被部分端点拒绝
    const entry: Record<string, unknown> = {
      role: 'assistant',
      content: message.content !== '' ? message.content : null,
    };
    if (calls.length > 0) {
      entry.tool_calls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        // 反向翻译为 OpenAI 线制时须序列化为字符串（FR-LOOP-011A 第 2 点）
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
    }
    messages.push(entry);
  }
  return messages;
}

export function buildResponsesInput(history: readonly AgentMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result = message.toolResult;
      if (result === undefined) continue;
      input.push({ type: 'function_call_output', call_id: result.callId, output: toolResultText(result) });
      continue;
    }
    if (message.role === 'user') {
      input.push({ role: 'user', content: responsesUserContent(message) });
      continue;
    }
    if (message.content !== '') input.push({ role: 'assistant', content: message.content });
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      });
    }
  }
  return input;
}

export interface OpenAiToolsAdapterOptions {
  /** 子类协议名（deepseek 复用同一套请求构造） */
  name?: ProtocolName;
  /** 交给标签状态机的标签集合，用于部分代理把推理内联为 <think> 的情况 */
  tags?: readonly string[];
}

export class OpenAiToolsAdapter implements ProtocolAdapter {
  readonly name: ProtocolName;
  private readonly tags: readonly string[];

  constructor(options: OpenAiToolsAdapterOptions = {}) {
    this.name = options.name ?? 'openai-tools';
    this.tags = options.tags ?? [];
  }

  buildRequest(history: readonly AgentMessage[], ctx: AdapterContext): WireRequest {
    const responses = ctx.wireApi === 'responses';
    const request: WireRequest = {
      model: ctx.model,
      messages: responses ? buildResponsesInput(history) : buildChatMessages(history),
      params: { ...ctx.params },
    };
    const system = collectSystemPrompt(ctx.systemPrompt, history);
    if (system !== '') request.system = system;
    if (ctx.tools.length > 0) {
      request.tools = responses ? responsesToolSchemas(ctx.tools) : chatToolSchemas(ctx.tools);
    }
    if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
    if (ctx.stop !== undefined && ctx.stop.length > 0) request.stop = [...ctx.stop];
    return request;
  }

  createParser(): ProtocolParser {
    return this.tags.length > 0 ? new WireProtocolParser({ tags: this.tags }) : new WireProtocolParser();
  }
}
