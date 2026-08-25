/**
 * 增量标签状态机（FR-LOOP-006 / FR-LOOP-007 / FR-LOOP-008）。
 *
 * 这是本项目唯一批准的自研组件：Hermes 系列把工具调用与推理段编码为
 * <tool_call> / <think> 等纯文本标签，而流式分块可以在任意字节切断标签，
 * 现有 SSE/JSON 解析库都不覆盖「跨 chunk 还原文本标签」这一场景。
 *
 * 行为约定：
 * - 文本模式下遇到 '<' 时，若剩余内容可能是已注册标签的前缀，则暂缓输出，
 *   等待后续 chunk；确定不可能匹配时才把 '<' 当作普通文本吐出。
 * - 标签内不再识别嵌套标签，首个闭合标签生效；标签体可安全包含
 *   转义引号与嵌套 JSON（因为只做定界符匹配，不做 JSON 语法分析）。
 * - 流结束仍未闭合时输出 unclosed 事件，调用方须据此判定本轮不完整。
 *
 * 日期：2026-08-24  执行者：Codex
 */

/** 状态机输出事件。delta 用于把标签体实时透传给 UI（如推理段打字机效果）。 */
export type TagEvent =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string }
  | { kind: 'delta'; name: string; text: string }
  | { kind: 'close'; name: string; content: string }
  | { kind: 'unclosed'; name: string; content: string };

/** Hermes 线制默认识别的标签集合。 */
export const HERMES_TAGS: readonly string[] = ['tool_call', 'tool_response', 'scratch_pad', 'thinking', 'think'];

/** 归类为推理段的标签（FR-LOOP-005）。 */
export const REASONING_TAGS: ReadonlySet<string> = new Set(['think', 'thinking', 'scratch_pad']);

/** 计算 text 的后缀与 needle 前缀的最长重叠长度，用于判断是否要暂缓输出。 */
export function suffixPrefixLength(text: string, needle: string): number {
  const max = Math.min(text.length, needle.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (text.endsWith(needle.slice(0, size))) return size;
  }
  return 0;
}

export class StreamTagParser {
  /** 长标签名优先匹配，避免 <tool> 抢先吃掉 <tool_call> */
  private readonly names: readonly string[];
  private buffer = '';
  private current: { name: string; content: string } | undefined;

  constructor(names: readonly string[] = HERMES_TAGS) {
    this.names = [...names].sort((a, b) => b.length - a.length);
  }

  /** 当前是否停留在某个标签内部。 */
  get openTag(): string | undefined {
    return this.current?.name;
  }

  /** 尚未判定归属、暂缓输出的字节数，仅用于诊断。 */
  get pendingSize(): number {
    return this.buffer.length;
  }

  push(chunk: string): TagEvent[] {
    if (chunk === '') return [];
    this.buffer += chunk;
    return this.drain();
  }

  end(): TagEvent[] {
    const events = this.drain();
    const current = this.current;
    const rest = this.buffer;
    this.buffer = '';
    if (current !== undefined) {
      // 暂缓的尾巴此时确定不是闭合标签，一并计入标签体后判为未闭合
      if (rest !== '') {
        current.content += rest;
        events.push({ kind: 'delta', name: current.name, text: rest });
      }
      events.push({ kind: 'unclosed', name: current.name, content: current.content });
      this.current = undefined;
      return events;
    }
    if (rest !== '') events.push({ kind: 'text', text: rest });
    return events;
  }

  private drain(): TagEvent[] {
    const events: TagEvent[] = [];
    for (;;) {
      const current = this.current;
      if (current === undefined) {
        if (!this.scanText(events)) return events;
        continue;
      }
      if (!this.scanTag(current, events)) return events;
    }
  }

  /** 文本模式扫描；返回 true 表示状态已变化需要继续循环。 */
  private scanText(events: TagEvent[]): boolean {
    const index = this.buffer.indexOf('<');
    if (index < 0) {
      if (this.buffer !== '') {
        events.push({ kind: 'text', text: this.buffer });
        this.buffer = '';
      }
      return false;
    }
    if (index > 0) {
      events.push({ kind: 'text', text: this.buffer.slice(0, index) });
      this.buffer = this.buffer.slice(index);
    }
    const name = this.matchOpenTag();
    if (name !== undefined) {
      this.buffer = this.buffer.slice(name.length + 2);
      this.current = { name, content: '' };
      events.push({ kind: 'open', name });
      return true;
    }
    if (this.mayBeOpenTagPrefix()) return false;
    events.push({ kind: 'text', text: '<' });
    this.buffer = this.buffer.slice(1);
    return true;
  }

  /** 标签内扫描；返回 true 表示已闭合需要继续循环。 */
  private scanTag(current: { name: string; content: string }, events: TagEvent[]): boolean {
    const closing = '</' + current.name + '>';
    const index = this.buffer.indexOf(closing);
    if (index >= 0) {
      const body = this.buffer.slice(0, index);
      if (body !== '') {
        current.content += body;
        events.push({ kind: 'delta', name: current.name, text: body });
      }
      events.push({ kind: 'close', name: current.name, content: current.content });
      this.buffer = this.buffer.slice(index + closing.length);
      this.current = undefined;
      return true;
    }
    const hold = suffixPrefixLength(this.buffer, closing);
    const safe = this.buffer.length - hold;
    if (safe > 0) {
      const body = this.buffer.slice(0, safe);
      current.content += body;
      events.push({ kind: 'delta', name: current.name, text: body });
      this.buffer = this.buffer.slice(safe);
    }
    return false;
  }

  private matchOpenTag(): string | undefined {
    for (const name of this.names) {
      if (this.buffer.startsWith('<' + name + '>')) return name;
    }
    return undefined;
  }

  private mayBeOpenTagPrefix(): boolean {
    for (const name of this.names) {
      const token = '<' + name + '>';
      if (token.length > this.buffer.length && token.startsWith(this.buffer)) return true;
    }
    return false;
  }
}
