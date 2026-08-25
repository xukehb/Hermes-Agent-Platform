/**
 * 线制事件 -> 语义事件的通用解析器（FR-LOOP-003/005/006/007/008/009）。
 *
 * 四个协议适配器共用这一份解析器，差异只体现在两个构造参数上：
 * 是否需要把正文再交给标签状态机分流（hermes-native 需要、deepseek 兼容
 * 部分代理把推理内联为 <think>）、以及注册哪些标签。
 *
 * finish 事件一律延迟到 end() 输出，保证「未闭合标签」这类只有在流末尾
 * 才能判定的事件排在 finish 之前，调用方可以按顺序线性处理。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { FinishReason, ToolCall, WireEvent } from '../domain/index.js';
import { fallbackCallId } from '../providers/stream.js';

import { REASONING_TAGS, StreamTagParser, type TagEvent } from './stream-tag-parser.js';
import type { ProtocolEvent, ProtocolParser } from './types.js';

/** 报错时展示的原文预览长度，避免把整段 JSON 塞进错误消息。 */
const PREVIEW_LIMIT = 160;

function preview(text: string): string {
  return text.length <= PREVIEW_LIMIT ? text : text.slice(0, PREVIEW_LIMIT) + '…';
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 把线制侧的参数统一归一为「已解析对象」。
 *
 * - OpenAI 线制给的是 JSON 字符串，这里解析一次
 * - Anthropic 线制的 input 本身是对象（FR-LOOP-011A 第 2 点），直接透传不再解析
 * - 双重编码（字符串里又是一段 JSON）再解一层，容错部分代理的实现
 */
export function parseToolArguments(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw === undefined || raw === null) return { args: {} };
  const direct = asPlainRecord(raw);
  if (direct !== undefined) return { args: direct };
  if (typeof raw !== 'string') {
    return { args: {}, error: '工具参数类型非法（期望对象或 JSON 字符串）：' + preview(String(raw)) };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return { args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { args: {}, error: '工具参数不是合法 JSON（' + reason + '）：' + preview(trimmed) };
  }
  const record = asPlainRecord(parsed);
  if (record !== undefined) return { args: record };
  if (typeof parsed === 'string') return parseToolArguments(parsed);
  return { args: {}, error: '工具参数解析后不是对象：' + preview(trimmed) };
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export interface WireProtocolParserOptions {
  /** 需要交给标签状态机分流的标签；为空表示正文原样透传 */
  tags?: readonly string[];
}

export class WireProtocolParser implements ProtocolParser {
  private readonly pending = new Map<number, PendingCall>();
  private readonly order: number[] = [];
  private readonly tagParser: StreamTagParser | undefined;
  private finishReason: FinishReason | undefined;
  private hasCalls = false;
  private tagCallSeq = 0;
  private ended = false;

  constructor(options: WireProtocolParserOptions = {}) {
    const tags = options.tags;
    this.tagParser = tags !== undefined && tags.length > 0 ? new StreamTagParser(tags) : undefined;
  }

  push(event: WireEvent): ProtocolEvent[] {
    switch (event.type) {
      case 'text_delta': {
        if (event.text === '') return [];
        const tagParser = this.tagParser;
        if (tagParser === undefined) return [{ type: 'text', text: event.text }];
        return this.translateTags(tagParser.push(event.text));
      }
      case 'reasoning_delta':
        return event.text === '' ? [] : [{ type: 'reasoning', text: event.text }];
      case 'tool_call_start': {
        const entry = this.slot(event.index);
        if (event.id !== '') entry.id = event.id;
        if (event.name !== '') entry.name = event.name;
        return [];
      }
      case 'tool_call_args_delta': {
        this.slot(event.index).args += event.delta;
        return [];
      }
      case 'tool_call_end':
        return this.finalize(event.index);
      case 'usage':
        return [{ type: 'usage', usage: event.usage }];
      case 'finish':
        this.finishReason = event.reason;
        return [];
      default:
        return [];
    }
  }

  end(): ProtocolEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const events: ProtocolEvent[] = [];
    const tagParser = this.tagParser;
    if (tagParser !== undefined) events.push(...this.translateTags(tagParser.end()));
    // 少数端点不发 tool_call_end，流末尾统一收口，保证调用不丢
    for (const index of [...this.order]) events.push(...this.finalize(index));
    events.push({ type: 'finish', reason: this.resolveFinish() });
    return events;
  }

  private resolveFinish(): FinishReason {
    const reason = this.finishReason ?? 'stop';
    // 标签协议下服务端只会给 stop，工具调用需由解析结果纠正（FR-LOOP-008）
    if (this.hasCalls && reason === 'stop') return 'tool_calls';
    return reason;
  }

  private slot(index: number): PendingCall {
    const existing = this.pending.get(index);
    if (existing !== undefined) return existing;
    const created: PendingCall = { id: '', name: '', args: '' };
    this.pending.set(index, created);
    this.order.push(index);
    return created;
  }

  private finalize(index: number): ProtocolEvent[] {
    const entry = this.pending.get(index);
    if (entry === undefined) return [];
    this.pending.delete(index);
    const position = this.order.indexOf(index);
    if (position >= 0) this.order.splice(position, 1);
    this.hasCalls = true;
    const call: ToolCall = {
      id: entry.id !== '' ? entry.id : fallbackCallId(index),
      name: entry.name,
      args: {},
    };
    const parsed = parseToolArguments(entry.args);
    call.args = parsed.args;
    if (entry.name === '') {
      return [{ type: 'tool_call', call, argsError: parsed.error ?? '工具调用缺少名称' }];
    }
    return parsed.error === undefined
      ? [{ type: 'tool_call', call }]
      : [{ type: 'tool_call', call, argsError: parsed.error }];
  }

  private translateTags(tagEvents: readonly TagEvent[]): ProtocolEvent[] {
    const events: ProtocolEvent[] = [];
    for (const event of tagEvents) {
      switch (event.kind) {
        case 'text':
          if (event.text !== '') events.push({ type: 'text', text: event.text });
          break;
        case 'open':
          break;
        case 'delta':
          // 推理段实时透传，工具调用体则等闭合后整体解析
          if (REASONING_TAGS.has(event.name)) events.push({ type: 'reasoning', text: event.text });
          break;
        case 'close':
          if (event.name === 'tool_call') events.push(this.toolCallFromTag(event.content));
          // tool_response 是模型幻觉出的结果，直接丢弃；推理段已在 delta 阶段输出
          break;
        case 'unclosed':
          // FR-LOOP-007：不执行其中的工具调用，交由上层标记不完整并重试
          events.push({ type: 'incomplete', tag: event.name, raw: event.content });
          break;
        default:
          break;
      }
    }
    return events;
  }

  private toolCallFromTag(content: string): ProtocolEvent {
    this.hasCalls = true;
    this.tagCallSeq += 1;
    const generatedId = 'call_tag_' + this.tagCallSeq;
    const trimmed = content.trim();
    let record: Record<string, unknown> | undefined;
    try {
      record = asPlainRecord(JSON.parse(trimmed));
    } catch {
      record = undefined;
    }
    if (record === undefined) {
      return {
        type: 'tool_call',
        call: { id: generatedId, name: '', args: {} },
        argsError: '<tool_call> 内容不是合法 JSON 对象：' + preview(trimmed),
      };
    }
    const name = typeof record.name === 'string' ? record.name : '';
    const rawId = record.id;
    const id = typeof rawId === 'string' && rawId !== '' ? rawId : generatedId;
    const parsed = parseToolArguments(record.arguments ?? record.parameters ?? record.args);
    const call: ToolCall = { id, name, args: parsed.args };
    const error = name === '' ? (parsed.error ?? '<tool_call> 缺少 name 字段') : parsed.error;
    return error === undefined ? { type: 'tool_call', call } : { type: 'tool_call', call, argsError: error };
  }
}
