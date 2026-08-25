/**
 * 会话串行队列（FR-CHAN-013）。
 *
 * 同一会话必须串行执行：并发跑两条指令会让历史交错、上下文错乱。
 * 不同会话之间放开并行，真正的并发闸门在 provider 层（RateGate）。
 * 队列满载时丢最旧而不是拒绝最新，理由是手机端用户最关心刚发出的那条。
 *
 * 日期：2026-08-24  执行者：Codex
 */

/** 入队结果。dropped 表示为腾位置丢弃了一条最旧的待处理项。 */
export interface EnqueueResult {
  accepted: true;
  droppedKey?: string;
}

export interface SessionQueueOptions<T> {
  /** 全局待处理容量（不含正在执行的项） */
  capacity: number;
  handler: (payload: T) => Promise<void>;
  /** 背压丢弃回调，用于告知用户「指令被丢弃」 */
  onDrop?: (payload: T) => void;
  /** handler 抛错时的兜底回调；不提供则静默吞掉，避免拖垮整条队列 */
  onError?: (payload: T, error: unknown) => void;
}

interface Slot<T> {
  key: string;
  payload: T;
  seq: number;
}

/**
 * 按 key 分组的串行队列。
 *
 * 内部对每个 key 维护一条待处理链表，并用 running 集合保证同一 key 只有一个在跑。
 */
export class SessionQueue<T> {
  private readonly capacity: number;
  private readonly handler: (payload: T) => Promise<void>;
  private readonly onDrop: ((payload: T) => void) | undefined;
  private readonly onError: ((payload: T, error: unknown) => void) | undefined;
  private readonly waiting = new Map<string, Slot<T>[]>();
  private readonly running = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private seq = 0;

  constructor(options: SessionQueueOptions<T>) {
    this.capacity = Math.max(1, options.capacity);
    this.handler = options.handler;
    this.onDrop = options.onDrop;
    this.onError = options.onError;
  }

  /** 当前待处理项总数（不含在跑项）。 */
  size(): number {
    let total = 0;
    for (const slots of this.waiting.values()) {
      total += slots.length;
    }
    return total;
  }

  /** 指定 key 的待处理项数。 */
  pending(key: string): number {
    return this.waiting.get(key)?.length ?? 0;
  }

  /** 指定 key 是否正在执行。 */
  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /**
   * 入队并触发调度。
   * 返回值里的 droppedKey 指出被背压丢弃的会话，便于上层告知用户。
   */
  enqueue(key: string, payload: T): EnqueueResult {
    const result: EnqueueResult = { accepted: true };
    if (this.size() >= this.capacity) {
      const dropped = this.dropOldest();
      if (dropped !== undefined) {
        result.droppedKey = dropped.key;
        this.onDrop?.(dropped.payload);
      }
    }
    this.seq += 1;
    const slots = this.waiting.get(key);
    const slot: Slot<T> = { key, payload, seq: this.seq };
    if (slots === undefined) {
      this.waiting.set(key, [slot]);
    } else {
      slots.push(slot);
    }
    this.pump(key);
    return result;
  }

  /** 等待全部在跑与待处理项结束，测试与优雅停机使用。 */
  async drain(): Promise<void> {
    while (this.inflight.size > 0 || this.size() > 0) {
      const current = [...this.inflight];
      if (current.length === 0) {
        for (const key of [...this.waiting.keys()]) {
          this.pump(key);
        }
        if (this.inflight.size === 0) {
          return;
        }
        continue;
      }
      await Promise.allSettled(current);
    }
  }

  /** 丢弃全局最旧的待处理项。 */
  private dropOldest(): Slot<T> | undefined {
    let victimKey: string | undefined;
    let victimSeq = Number.POSITIVE_INFINITY;
    for (const [key, slots] of this.waiting) {
      const head = slots[0];
      if (head !== undefined && head.seq < victimSeq) {
        victimSeq = head.seq;
        victimKey = key;
      }
    }
    if (victimKey === undefined) {
      return undefined;
    }
    const slots = this.waiting.get(victimKey);
    const victim = slots?.shift();
    if (slots !== undefined && slots.length === 0) {
      this.waiting.delete(victimKey);
    }
    return victim;
  }

  /** 若该 key 空闲则取出队首执行。 */
  private pump(key: string): void {
    if (this.running.has(key)) {
      return;
    }
    const slots = this.waiting.get(key);
    const slot = slots?.shift();
    if (slot === undefined) {
      this.waiting.delete(key);
      return;
    }
    if (slots !== undefined && slots.length === 0) {
      this.waiting.delete(key);
    }
    this.running.add(key);
    const task = this.execute(slot);
    this.inflight.add(task);
    void task.finally(() => {
      this.inflight.delete(task);
      this.running.delete(key);
      this.pump(key);
    });
  }

  private async execute(slot: Slot<T>): Promise<void> {
    try {
      await this.handler(slot.payload);
    } catch (error) {
      this.onError?.(slot.payload, error);
    }
  }
}
