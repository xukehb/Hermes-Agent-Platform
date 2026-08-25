/**
 * hermes-native 适配器（FR-LOOP-001~008 / FR-LOOP-011）。
 *
 * 工具清单注入 system 消息的 <tools> 块（而非请求体 tools 字段），
 * 助手侧调用以 <tool_call> 标签表示，结果以 tool 角色的 <tool_response> 回灌。
 * 出站消息保持 role/content 结构，由服务端的 ChatML 模板渲染分隔符，
 * 与 prompt-composer.renderChatML 的产物一致（不在客户端二次套模板）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage, WireRequest } from '../../domain/index.js';
import { collectSystemPrompt, splitUserContent, toolResultText } from '../message-parts.js';
import {
  composeHermesSystem,
  renderToolCallTag,
  renderToolResponseTag,
} from '../prompt-composer.js';
import { HERMES_TAGS } from '../stream-tag-parser.js';
import type { AdapterContext, ProtocolAdapter, ProtocolParser } from '../types.js';
import { WireProtocolParser } from '../wire-parser.js';

/** 用户内容：Ollama 等本地端点沿用 OpenAI 多模态分块格式。 */
function userContent(message: AgentMessage): unknown {
  const content = splitUserContent(message);
  if (content.images.length === 0) return content.text;
  const parts: unknown[] = [];
  if (content.text !== '') parts.push({ type: 'text', text: content.text });
  for (const image of content.images) {
    parts.push({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } });
  }
  return parts;
}

export function buildHermesMessages(history: readonly AgentMessage[]): unknown[] {
  const messages: unknown[] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result = message.toolResult;
      if (result === undefined) continue;
      messages.push({
        role: 'tool',
        content: renderToolResponseTag(result.name, toolResultText(result), result.isError),
      });
      continue;
    }
    if (message.role === 'user') {
      messages.push({ role: 'user', content: userContent(message) });
      continue;
    }
    // 助手历史只回灌正文与工具调用标签；推理段不回灌，避免二次引导模型复述思考
    const segments: string[] = [];
    if (message.content !== '') segments.push(message.content);
    for (const call of message.toolCalls ?? []) segments.push(renderToolCallTag(call.name, call.args));
    messages.push({ role: 'assistant', content: segments.join('\n') });
  }
  return messages;
}

export class HermesNativeAdapter implements ProtocolAdapter {
  readonly name = 'hermes-native' as const;

  buildRequest(history: readonly AgentMessage[], ctx: AdapterContext): WireRequest {
    const request: WireRequest = {
      model: ctx.model,
      messages: buildHermesMessages(history),
      params: { ...ctx.params },
    };
    const system = composeHermesSystem(collectSystemPrompt(ctx.systemPrompt, history), ctx.tools);
    if (system !== '') request.system = system;
    // 工具声明在 system 的 <tools> 内，请求体不再带 tools 字段（FR-LOOP-002）
    if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
    if (ctx.stop !== undefined && ctx.stop.length > 0) request.stop = [...ctx.stop];
    return request;
  }

  createParser(): ProtocolParser {
    return new WireProtocolParser({ tags: HERMES_TAGS });
  }
}
