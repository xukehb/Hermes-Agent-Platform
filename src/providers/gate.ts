/**
 * 提供商 / 智能体并发与限速闸门（FR-ROUTE-006）。
 *
 * 为什么自己实现而不引第三方限流库：这里需要的是「持有到流结束」的
 * 许可语义（acquire 返回 release，流式响应期间一直占用名额），
 * 常见限流库以 run(fn) 包裹同步返回值为主，包一层反而更绕。
 * 逻辑只有队列与滑动窗口两件事，实现体量与适配层相当。
 *
 * 时钟可注入，测试用假时钟即可确定性地断言排队与限速行为。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ProviderCheckResult, WireEvent, WireRequest } from '../domain/index.js';
import type { ProviderClient } from '../domain/index.js';
import type { ResolvedLimits } from '../config/resolved.js';
import { sleep, throwIfAborted } from './retry.js';

/** 滑动窗口长度：RPM 语义固定为 60 秒。 */
const WINDOW_MS = 60_000;

/** 可注入时钟。sleep 需支持取消，否则任务取消后闸门仍在等待。 */
export interface GateClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** 真实时钟。 */
export const systemGateClock: GateClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, signal),
};

/** 单个闸门的配置。0 表示不限制。 */
export interface GateSettings {
  concurrency: number;
  rpm: number;
}

/** 释放许可的回调，重复调用无副作用。 */
export type GateRelease = () => void;

/**
 * 并发 + 滑动窗口限速闸门。
 *
 * acquire 的顺序刻意是「先占并发名额，再等限速窗口」：
 * 反过来会让抢到窗口配额的请求卡在并发队列上，浪费配额。
 */
export class RateGate {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly stamps: number[] = [];

  constructor(
    readonly key: string,
    private settings: GateSettings,
    private readonly clock: GateClock = systemGateClock,
  ) {}

  /** 当前占用名额数。 */
  get active(): number {
    return this.activeCount;
  }

  /** 当前排队等待数。 */
  get queued(): number {
    return this.waiters.length;
  }

  /** 当前滑动窗口内的请求数（已剔除过期戳）。 */
  get windowUsage(): number {
    this.prune(this.clock.now());
    return this.stamps.length;
  }

  /** 热更新闸门配置（config 热重载时调用），随即唤醒排队者重新判定。 */
  update(settings: GateSettings): void {
    this.settings = settings;
    this.pump();
  }

  /** 申请许可。返回的 release 必须在 finally 中调用。 */
  async acquire(signal?: AbortSignal): Promise<GateRelease> {
    throwIfAborted(signal, '闸门排队');
    while (this.settings.concurrency > 0 && this.activeCount >= this.settings.concurrency) {
      await this.waitForSlot(signal);
    }
    this.activeCount += 1;
    try {
      await this.waitForWindow(signal);
    } catch (error) {
      this.activeCount -= 1;
      this.pump();
      throw error;
    }
    this.stamps.push(this.clock.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount -= 1;
      this.pump();
    };
  }

  /** 以许可包裹一次性任务。 */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  /** 唤醒队首等待者。每次只唤一个，保证并发上限不被击穿。 */
  private pump(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter();
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter = (): void => {
        if (settled) return;
        settled = true;
        detach();
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        detach();
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        try {
          throwIfAborted(signal, '闸门排队');
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const detach = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async waitForWindow(signal?: AbortSignal): Promise<void> {
    if (this.settings.rpm <= 0) return;
    for (;;) {
      const now = this.clock.now();
      this.prune(now);
      if (this.stamps.length < this.settings.rpm) return;
      const oldest = this.stamps[0];
      if (oldest === undefined) return;
      await this.clock.sleep(Math.max(1, oldest + WINDOW_MS - now), signal);
      throwIfAborted(signal, '限速等待');
    }
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    for (;;) {
      const oldest = this.stamps[0];
      if (oldest === undefined || oldest > cutoff) return;
      this.stamps.shift();
    }
  }
}

/** 闸门注册表配置。concurrency / rpm 为按键覆盖表，缺省走 defaultConcurrency。 */
export interface GateRegistryOptions {
  concurrency?: Record<string, number>;
  rpm?: Record<string, number>;
  defaultConcurrency?: number;
  clock?: GateClock;
}

/** 按键（provider id 或 agent id）惰性创建闸门。 */
export class GateRegistry {
  private readonly gates = new Map<string, RateGate>();

  constructor(private readonly options: GateRegistryOptions = {}) {}

  /** 该键生效的闸门配置。 */
  settingsFor(key: string): GateSettings {
    return {
      concurrency: this.options.concurrency?.[key] ?? this.options.defaultConcurrency ?? 0,
      rpm: this.options.rpm?.[key] ?? 0,
    };
  }

  /** 取得闸门实例，同键复用。 */
  gate(key: string): RateGate {
    const existing = this.gates.get(key);
    if (existing !== undefined) return existing;
    const created = new RateGate(key, this.settingsFor(key), this.options.clock ?? systemGateClock);
    this.gates.set(key, created);
    return created;
  }

  /** 已创建过闸门的键列表，供 hap usage 展示排队情况。 */
  keys(): string[] {
    return [...this.gates.keys()];
  }

  /** 配置热重载：按新配置刷新既有闸门。 */
  refresh(options: GateRegistryOptions): void {
    Object.assign(this.options, options);
    for (const [key, gate] of this.gates) gate.update(this.settingsFor(key));
  }
}

/** 由 limits 构造提供商维度闸门注册表。 */
export function providerGateRegistry(limits: ResolvedLimits, clock?: GateClock): GateRegistry {
  const options: GateRegistryOptions = {
    concurrency: limits.providerConcurrency,
    rpm: limits.providerRpm,
    defaultConcurrency: limits.defaultProviderConcurrency,
  };
  if (clock !== undefined) options.clock = clock;
  return new GateRegistry(options);
}

/** 由 limits 构造智能体维度闸门注册表。 */
export function agentGateRegistry(limits: ResolvedLimits, clock?: GateClock): GateRegistry {
  const options: GateRegistryOptions = {
    concurrency: limits.agentConcurrency,
    rpm: limits.agentRpm,
    defaultConcurrency: limits.defaultAgentConcurrency,
  };
  if (clock !== undefined) options.clock = clock;
  return new GateRegistry(options);
}

/**
 * 给 ProviderClient 套一层闸门。
 *
 * 许可在整条流的生命周期内持有（生成器 finally 释放），
 * 因此并发上限约束的是「同时在途的流」，而非「每秒发起数」。
 */
export class GatedProviderClient implements ProviderClient {
  constructor(
    private readonly inner: ProviderClient,
    private readonly gate: RateGate,
  ) {}

  get providerId(): string {
    return this.inner.providerId;
  }

  get wireApi(): ProviderClient['wireApi'] {
    return this.inner.wireApi;
  }

  async *send(request: WireRequest, signal?: AbortSignal): AsyncIterable<WireEvent> {
    const release = await this.gate.acquire(signal);
    try {
      yield* this.inner.send(request, signal);
    } finally {
      release();
    }
  }

  check(signal?: AbortSignal): Promise<ProviderCheckResult> {
    return this.gate.run(() => this.inner.check(signal), signal);
  }
}
