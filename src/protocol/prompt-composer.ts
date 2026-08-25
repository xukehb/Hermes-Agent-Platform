/**
 * 提示词组装（FR-LOOP-001 / FR-LOOP-002 / FR-LOOP-004）。
 *
 * ChatML 说明：Hermes 系列的官方格式是 <|im_start|>role ... <|im_end|>。
 * 走 /v1/chat/completions 时该模板由服务端套用，客户端若再手工拼一遍会造成
 * 双重模板、模型输出错乱，因此适配器发送结构化 messages（服务端渲染出的
 * 分隔符与 renderChatML 完全一致），而 renderChatML 用于 token 估算、
 * trace 快照与压缩前后的体积对比，保证「按 ChatML 组装」这件事有唯一权威实现。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage, ToolDefinition } from '../domain/index.js';

/** ChatML 分隔符。 */
export const IM_START = '<|im_start|>';
export const IM_END = '<|im_end|>';

/** Hermes 工具调用约定说明，随 <tools> 一起注入 system 消息。 */
const HERMES_INSTRUCTIONS = [
  '你可以调用上面 <tools></tools> 中声明的函数来完成任务。',
  '调用时，请为每次调用输出一个独立的 JSON 对象，并用 <tool_call></tool_call> 包裹：',
  '<tool_call>{"name": "函数名", "arguments": {"参数名": "参数值"}}</tool_call>',
  '需要多次调用时，按执行顺序连续输出多个 <tool_call> 块。',
  '工具结果会以 <tool_response></tool_response> 形式回传，请据此继续推理。',
  '内部推理请放在 <think></think> 中，最终答复放在标签之外。',
].join('\n');

/** 把工具清单渲染为 <tools> JSON Schema 数组（FR-LOOP-002）。 */
export function renderToolsBlock(tools: readonly ToolDefinition[]): string {
  const schemas = tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return '<tools>\n' + JSON.stringify(schemas) + '\n</tools>';
}

/** 组装 Hermes 线制的 system 消息：基础提示词 + 工具清单 + 调用约定。 */
export function composeHermesSystem(systemPrompt: string, tools: readonly ToolDefinition[]): string {
  const parts: string[] = [];
  const base = systemPrompt.trim();
  if (base !== '') parts.push(base);
  if (tools.length > 0) {
    parts.push(renderToolsBlock(tools));
    parts.push(HERMES_INSTRUCTIONS);
  }
  return parts.join('\n\n');
}

/** 把一次工具调用渲染为 <tool_call> 标签（FR-LOOP-003 的反向序列化）。 */
export function renderToolCallTag(name: string, args: Record<string, unknown>): string {
  return '<tool_call>' + JSON.stringify({ name, arguments: args }) + '</tool_call>';
}

/** 把一次工具结果渲染为 <tool_response> 标签（FR-LOOP-004）。 */
export function renderToolResponseTag(name: string, content: string, isError: boolean): string {
  const payload: Record<string, unknown> = { name, content };
  if (isError) payload.is_error = true;
  return '<tool_response>' + JSON.stringify(payload) + '</tool_response>';
}

/** 单条消息渲染为 ChatML 段落。assistant 的工具调用与 tool 结果都编码为标签文本。 */
export function renderChatMLMessage(message: AgentMessage): string {
  const body: string[] = [];
  if (message.role === 'tool') {
    const result = message.toolResult;
    if (result !== undefined) body.push(renderToolResponseTag(result.name, result.content, result.isError));
    else if (message.content !== '') body.push(message.content);
  } else {
    if (message.reasoning !== undefined && message.reasoning !== '') {
      body.push('<think>' + message.reasoning + '</think>');
    }
    if (message.content !== '') body.push(message.content);
    for (const call of message.toolCalls ?? []) body.push(renderToolCallTag(call.name, call.args));
  }
  return IM_START + message.role + '\n' + body.join('\n') + IM_END;
}

/** 整段历史渲染为 ChatML 提示词（FR-LOOP-001）。 */
export function renderChatML(
  history: readonly AgentMessage[],
  options: { system?: string; addGenerationPrompt?: boolean } = {},
): string {
  const segments: string[] = [];
  const system = options.system;
  if (system !== undefined && system.trim() !== '') {
    segments.push(IM_START + 'system\n' + system + IM_END);
  }
  for (const message of history) segments.push(renderChatMLMessage(message));
  if (options.addGenerationPrompt === true) segments.push(IM_START + 'assistant\n');
  return segments.join('\n');
}

/**
 * token 粗估：CJK 与全角标点按 1 token/字符，其余按 4 字符/token。
 * 用于压缩阈值判断（FR-LOOP-013），不追求与厂商分词器一致，
 * 只要求同一文本的估算稳定且单调。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20000 && code <= 0x3ffff);
    if (isCjk) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 估算整段历史的 token 数（含 ChatML 分隔符开销）。 */
export function estimateHistoryTokens(history: readonly AgentMessage[], system?: string): number {
  const options = system === undefined ? {} : { system };
  return estimateTokens(renderChatML(history, options));
}
