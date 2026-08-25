/**
 * 消息拆解与 Schema 归一（四个适配器共用）。
 *
 * 内部历史（AgentMessage[]）是唯一事实源，任何协议都从它重新序列化，
 * 这正是 FR-LOOP-015「跨协议降级须重译整段历史」得以成立的前提。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage, JsonSchema, ToolResult } from '../domain/index.js';

import {
  attachmentLabel,
  describeAttachment,
  encodeImageBase64,
  readDocumentText,
} from './attachments.js';

/** 图片附件的原始编码结果。 */
export interface InlineImage {
  data: string;
  mediaType: string;
}

/** 一条用户消息拆分后的可发送内容。 */
export interface UserContent {
  text: string;
  images: InlineImage[];
}

/**
 * 合并系统提示词：智能体的 system_prompt 打头，历史中的 system 消息按序追加。
 * 各线制的 system 位置不同（chat 是首条消息、responses 是 instructions、
 * anthropic 是顶层 system 字段），因此统一收敛成一段文本交由 provider 客户端摆放。
 */
export function collectSystemPrompt(base: string, history: readonly AgentMessage[]): string {
  const parts: string[] = [];
  const trimmed = base.trim();
  if (trimmed !== '') parts.push(trimmed);
  for (const message of history) {
    if (message.role !== 'system') continue;
    const text = message.content.trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n\n');
}

/** 拆出用户消息的正文与可内联图片；不可内联的附件降级为一行路径说明。 */
export function splitUserContent(message: AgentMessage): UserContent {
  const lines: string[] = [];
  if (message.content !== '') lines.push(message.content);
  const images: InlineImage[] = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.kind === 'image') {
      const encoded = encodeImageBase64(attachment);
      if (encoded !== undefined) {
        images.push(encoded);
        continue;
      }
      lines.push(describeAttachment(attachment));
      continue;
    }
    const document = readDocumentText(attachment);
    if (document !== undefined) {
      lines.push('附件 ' + attachmentLabel(attachment) + ' 内容：\n' + document);
      continue;
    }
    lines.push(describeAttachment(attachment));
  }
  return { text: lines.join('\n\n'), images };
}

/** 工具结果的面向模型文本；被裁剪时附带完整输出落盘路径（FR-TOOL-007）。 */
export function toolResultText(result: ToolResult): string {
  if (result.overflowPath === undefined) return result.content;
  return result.content + '\n（输出过长已裁剪，完整内容见 ' + result.overflowPath + '）';
}

/** 参数 Schema 归一：缺 type 时补 object，避免厂商侧校验直接 400。 */
export function normalizeSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema.type === 'string') return schema;
  return { type: 'object', ...schema };
}

/** 一条 assistant 消息是否只有工具调用而没有正文。 */
export function hasToolCalls(message: AgentMessage): boolean {
  return (message.toolCalls ?? []).length > 0;
}
