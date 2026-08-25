/**
 * 流式事件的通用加工件：空闲看护、工具调用分片累积、事件收集。
 *
 * 抽出独立文件的原因：chat / responses / anthropic-messages 三条线制
 * 都需要同样的「无数据超时」与「工具调用分片重组」逻辑，
 * 差异只在 chunk 字段名，因此把与厂商无关的部分集中在此（AGENTS.md 第 8 节）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { RecoverableError } from '../domain/index.js';
import type { WireEvent } from '../domain/index.js';

/** 空闲看护的上下文，进入错误 context 供 trace 定位。 */
export interface IdleGuardContext {
  providerId: string;
  model: string;
}

/**
 * 为异步流加一层「相邻两个事件间隔上限」看护（FR-PROV-007）。
 *
 * 实现要点：用 Promise.race 竞速 iterator.next() 与定时器；
 * 超时抛 PROVIDER_STREAM_IDLE 后，finally 里调用 iterator.return()
 * 让 SDK 侧连接被真正关闭，避免半开连接堆积。
 *
 * idleMs <= 0 表示不看护，直接透传（本地 Ollama 长思考场景可关闭）。
 */
export async function* withIdleTimeout<T>(source: AsyncIterable<T>, idleMs: number, context: IdleGuardContext): AsyncGenerator<T> {
  if (idleMs <= 0) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = iterator.next();
      // 挂一个空捕获，避免 race 走超时分支后 next later-reject 造成未处理拒绝告警
      next.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RecoverableError('PROVIDER_STREAM_IDLE', '流式响应空闲超过 ' + String(idleMs) + 'ms（' + context.providerId + '/' + context.model + '）', {
              userMessage: '模型响应中断，正在重试。',
              context: { providerId: context.providerId, model: context.model, idleMs },
            }),
          );
        }, idleMs);
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([next, idle]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    // 刻意不 await：源一旦停摆（正是空闲看护要处理的情形），return() 要等生成器体
    // 从 await 恢复才会 settle，await 它会让 PROVIDER_STREAM_IDLE 永远传不出去。
    // 因此只做「尽力关闭」，把错误立刻交给上层重试。
    if (iterator.return !== undefined) {
      void iterator.return(undefined).catch(() => undefined);
    }
  }
}

/** 单个工具调用槽位的累积状态。 */
interface ToolCallSlot {
  id: string | undefined;
  name: string | undefined;
  /** name 尚未到达时先缓存的参数分片 */
  pending: string[];
  started: boolean;
  ended: boolean;
}

/** ingest 的输入分片。三个字段都可缺省，对应各端点不同的分片粒度。 */
export interface ToolCallChunk {
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  argsDelta?: string | undefined;
}

/**
 * 工具调用分片累积器：把「先到 index、后到 name、参数逐字符到达」的
 * OpenAI 线制分片，重排为 start → args_delta* → end 的稳定事件序列。
 *
 * 为什么不能直接透传：部分端点首个 chunk 只带 index 与 id，
 * name 出现在第二个 chunk；若立即发 start 则 name 为空，
 * 适配器无法定位工具。故 start 延迟到 name 已知的那一刻，
 * 期间的参数分片先缓存再补发。
 *
 * name 采用「首次写入生效」：已观测到的端点或只在首片给 name，
 * 或每片重复完整 name，二者在首次写入语义下都正确。
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, ToolCallSlot>();

  /** 累积一个分片，返回本次可对外发布的事件。 */
  ingest(chunk: ToolCallChunk): WireEvent[] {
    const events: WireEvent[] = [];
    const slot = this.slots.get(chunk.index) ?? { id: undefined, name: undefined, pending: [], started: false, ended: false };
    if (!this.slots.has(chunk.index)) this.slots.set(chunk.index, slot);

    if (chunk.id !== undefined && chunk.id !== '' && slot.id === undefined) slot.id = chunk.id;
    if (chunk.name !== undefined && chunk.name !== '' && slot.name === undefined) slot.name = chunk.name;

    if (!slot.started && slot.name !== undefined) {
      slot.started = true;
      events.push({ type: 'tool_call_start', index: chunk.index, id: slot.id ?? fallbackCallId(chunk.index), name: slot.name });
      for (const buffered of slot.pending) {
        events.push({ type: 'tool_call_args_delta', index: chunk.index, delta: buffered });
      }
      slot.pending.length = 0;
    }

    if (chunk.argsDelta !== undefined && chunk.argsDelta !== '') {
      if (slot.started) events.push({ type: 'tool_call_args_delta', index: chunk.index, delta: chunk.argsDelta });
      else slot.pending.push(chunk.argsDelta);
    }
    return events;
  }

  /** 显式结束某个槽位（Anthropic 的 content_block_stop 有明确边界）。 */
  end(index: number): WireEvent[] {
    const slot = this.slots.get(index);
    if (slot === undefined || slot.ended) return [];
    const events = this.forceStart(index, slot);
    slot.ended = true;
    events.push({ type: 'tool_call_end', index });
    return events;
  }

  /** 收束全部未结束槽位（chat 线制只有 finish_reason 作为边界）。 */
  flush(): WireEvent[] {
    const events: WireEvent[] = [];
    for (const [index, slot] of this.slots) {
      if (slot.ended) continue;
      events.push(...this.forceStart(index, slot));
      slot.ended = true;
      events.push({ type: 'tool_call_end', index });
    }
    return events;
  }

  /** 是否累积到过工具调用，供客户端校正 finish_reason。 */
  get hasCalls(): boolean {
    return this.slots.size > 0;
  }

  /**
   * 补发缺失的 start。name 始终缺失时以空名发出，
   * 由适配器抛 TOOL_NOT_FOUND 并回灌模型，而不是在此静默丢弃调用。
   */
  private forceStart(index: number, slot: ToolCallSlot): WireEvent[] {
    if (slot.started) return [];
    const events: WireEvent[] = [];
    slot.started = true;
    events.push({ type: 'tool_call_start', index, id: slot.id ?? fallbackCallId(index), name: slot.name ?? '' });
    for (const buffered of slot.pending) {
      events.push({ type: 'tool_call_args_delta', index, delta: buffered });
    }
    slot.pending.length = 0;
    return events;
  }
}

/** 端点未给 id 时的兜底标识。保证同一轮内唯一即可。 */
export function fallbackCallId(index: number): string {
  return 'call_' + String(index);
}

/** 收集全部事件，测试与 CLI 单次调用场景复用。 */
export async function collectWireEvents(source: AsyncIterable<WireEvent>): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

/** 拼接事件序列中的正文文本，便于断言与调试输出。 */
export function textOfWireEvents(events: readonly WireEvent[]): string {
  return events
    .filter((event): event is Extract<WireEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
}
