/**
 * 未知结构读取助手。
 *
 * 各厂商的流式 chunk 字段在小版本间会漂移（DeepSeek 的 reasoning_content、
 * OpenRouter 的 reasoning、部分代理把 tool_calls 放在 message 而非 delta），
 * 若直接用 SDK 的强类型会在换端点时编译不过或运行时崩。
 * 因此客户端内部把 chunk 视为 Record<string, unknown>，通过本文件的
 * 窄化函数按需读取，缺字段一律降级为 undefined 而不抛错。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { TokenUsage } from '../domain/index.js';
import type { ToolCallChunk } from './stream.js';

/** 窄化为普通对象。数组与 null 不算对象。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 窄化为非空字符串。空串按「未提供」处理，简化调用点判断。 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 窄化为有限数字。字符串数字也接受，部分端点把 token 数按字符串下发。 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 取第一个存在的字符串，用于同义字段兜底（reasoning_content / reasoning）。 */
export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * 读取 content 字段的纯文本。
 *
 * 三种已观测形态：字符串、内容块数组（{type:'text',text}）、
 * 以及 null（工具调用轮次）。数组形态里非 text 块（如 image_url）被忽略。
 */
export function readContentText(value: unknown): string {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  if (!Array.isArray(value)) return '';
  let text = '';
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const type = asString(record.type);
    if (type === undefined || type === 'text' || type === 'output_text') {
      text += asString(record.text) ?? '';
    }
  }
  return text;
}

/**
 * 读取 OpenAI 线制的 tool_calls 分片。
 *
 * index 缺失时用数组下标兜底（Ollama 的 OpenAI 兼容层不发 index）；
 * arguments 为对象时序列化为字符串，统一走「JSON 字符串分片」通路，
 * 由适配器在末端一次性解析（FR-LOOP-011A 第 2 点只对 Anthropic 例外）。
 */
export function readToolCallChunks(value: unknown): ToolCallChunk[] {
  if (!Array.isArray(value)) return [];
  const chunks: ToolCallChunk[] = [];
  for (let position = 0; position < value.length; position += 1) {
    const record = asRecord(value[position]);
    if (record === undefined) continue;
    const fn = asRecord(record.function);
    const rawArgs = fn?.arguments ?? record.arguments;
    const argsDelta = typeof rawArgs === 'string' ? rawArgs : rawArgs === undefined || rawArgs === null ? undefined : JSON.stringify(rawArgs);
    const chunk: ToolCallChunk = { index: asNumber(record.index) ?? position };
    const id = firstString(record.id, record.tool_call_id);
    if (id !== undefined) chunk.id = id;
    const name = firstString(fn?.name, record.name);
    if (name !== undefined) chunk.name = name;
    if (argsDelta !== undefined && argsDelta !== '') chunk.argsDelta = argsDelta;
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * 读取 chat 线制 usage。
 *
 * 兼容三套命名：OpenAI 的 prompt/completion_tokens、
 * responses 风格的 input/output_tokens、以及部分代理的 promptTokens 驼峰。
 * total 缺失时由两侧相加，避免统计出现 0（FR-TASK-007 依赖该值累计）。
 */
export function readChatUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const prompt = asNumber(record.prompt_tokens) ?? asNumber(record.input_tokens) ?? asNumber(record.promptTokens);
  const completion = asNumber(record.completion_tokens) ?? asNumber(record.output_tokens) ?? asNumber(record.completionTokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const details = asRecord(record.completion_tokens_details) ?? asRecord(record.output_tokens_details);
  const reasoning = asNumber(details?.reasoning_tokens);
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: asNumber(record.total_tokens) ?? promptTokens + completionTokens,
  };
  if (reasoning !== undefined && reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}
