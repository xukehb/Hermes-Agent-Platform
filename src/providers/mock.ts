/**
 * 脚本化的假提供商客户端。
 *
 * 存在理由：协议适配器、agent loop、通道层的行为测试都需要「可预期的模型输出」，
 * 而真实端点既慢又不确定。把假实现放在 src 而不是 tests 的原因是
 * hap 的 dry-run / 自检命令也会用到它（无需凭据即可验证整条链路是否通）。
 *
 * 用法：
 *   const client = new MockProviderClient();
 *   client.push(textTurn('你好'), toolCallTurn([{ name: 'shell', args: { command: 'ls' } }]));
 * 每次 send 消费一个 turn；脚本耗尽时抛错而不是静默返回空流，
 * 以免测试里「多跑了一轮」被悄悄吞掉。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { FatalError } from '../domain/index.js';
import type { FinishReason, ProviderCheckResult, ProviderClient, TokenUsage, WireApi, WireEvent, WireRequest } from '../domain/index.js';
import { sleep, throwIfAborted } from './retry.js';

/** 一轮脚本。events 与 error 互斥：先延迟，再抛错或吐事件。 */
export interface MockTurn {
  events?: WireEvent[];
  error?: unknown;
  delayMs?: number;
}

/** 构造参数。 */
export interface MockProviderClientOptions {
  providerId?: string;
  wireApi?: WireApi;
  turns?: MockTurn[];
  /** 脚本耗尽后是否重复最后一轮；默认 false（抛错） */
  repeatLast?: boolean;
  check?: ProviderCheckResult;
}

export class MockProviderClient implements ProviderClient {
  readonly providerId: string;
  readonly wireApi: WireApi;
  /** 按顺序记录收到的请求，供断言 messages / tools / params 的组装是否正确 */
  readonly requests: WireRequest[] = [];
  private readonly turns: MockTurn[];
  private readonly repeatLast: boolean;
  private readonly checkResult: ProviderCheckResult | undefined;
  private cursor = 0;

  constructor(options: MockProviderClientOptions = {}) {
    this.providerId = options.providerId ?? 'mock';
    this.wireApi = options.wireApi ?? 'chat';
    this.turns = [...(options.turns ?? [])];
    this.repeatLast = options.repeatLast ?? false;
    this.checkResult = options.check;
  }

  /** 追加脚本，返回自身以便链式调用。 */
  push(...turns: MockTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  /** 已消费的轮次数。 */
  get callCount(): number {
    return this.cursor;
  }

  /** 最近一次请求，断言时最常用。 */
  get lastRequest(): WireRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  /** 复位游标与请求记录，便于同一实例跨用例复用。 */
  reset(): void {
    this.cursor = 0;
    this.requests.length = 0;
  }

  async *send(request: WireRequest, signal?: AbortSignal): AsyncIterable<WireEvent> {
    throwIfAborted(signal, '模拟请求');
    this.requests.push(request);
    const turn = this.nextTurn();
    if (turn.delayMs !== undefined && turn.delayMs > 0) await sleep(turn.delayMs, signal);
    if (turn.error !== undefined) throw turn.error;
    for (const event of turn.events ?? []) {
      throwIfAborted(signal, '模拟流');
      yield event;
    }
  }

  check(signal?: AbortSignal): Promise<ProviderCheckResult> {
    throwIfAborted(signal, '模拟自检');
    return Promise.resolve(
      this.checkResult ?? { providerId: this.providerId, reachable: true, handshakeMs: 1, models: ['mock-model'] },
    );
  }

  private nextTurn(): MockTurn {
    const turn = this.turns[this.cursor];
    if (turn !== undefined) {
      this.cursor += 1;
      return turn;
    }
    const last = this.turns[this.turns.length - 1];
    if (this.repeatLast && last !== undefined) {
      this.cursor += 1;
      return last;
    }
    throw new FatalError('PROVIDER_UNREACHABLE', 'MockProviderClient 脚本已耗尽：第 ' + String(this.cursor + 1) + ' 次调用没有对应脚本', {
      context: { providerId: this.providerId, scripted: this.turns.length },
    });
  }
}

/** textTurn 的可选项。 */
export interface TextTurnOptions {
  reasoning?: string;
  usage?: TokenUsage;
  finish?: FinishReason;
  /** 大于 0 时把正文按该长度切片，模拟逐字流 */
  chunkSize?: number;
  delayMs?: number;
}

/** 纯文本回复。 */
export function textTurn(text: string, options: TextTurnOptions = {}): MockTurn {
  const events: WireEvent[] = [];
  if (options.reasoning !== undefined && options.reasoning !== '') {
    events.push({ type: 'reasoning_delta', text: options.reasoning });
  }
  for (const piece of splitText(text, options.chunkSize)) {
    events.push({ type: 'text_delta', text: piece });
  }
  if (options.usage !== undefined) events.push({ type: 'usage', usage: options.usage });
  events.push({ type: 'finish', reason: options.finish ?? 'stop' });
  return options.delayMs === undefined ? { events } : { events, delayMs: options.delayMs };
}

/** toolCallTurn 的单个调用描述。 */
export interface MockToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** toolCallTurn 的可选项。 */
export interface ToolCallTurnOptions {
  /** 工具调用前的伴随正文（Anthropic 常见「先解释再调用」） */
  text?: string;
  reasoning?: string;
  usage?: TokenUsage;
  /** 参数 JSON 的切片长度，用于验证分片重组 */
  chunkSize?: number;
  delayMs?: number;
}

/** 工具调用回复。事件序列与真实端点归一化后的形态一致。 */
export function toolCallTurn(calls: readonly MockToolCall[], options: ToolCallTurnOptions = {}): MockTurn {
  const events: WireEvent[] = [];
  if (options.reasoning !== undefined && options.reasoning !== '') {
    events.push({ type: 'reasoning_delta', text: options.reasoning });
  }
  if (options.text !== undefined && options.text !== '') {
    events.push({ type: 'text_delta', text: options.text });
  }
  calls.forEach((call, index) => {
    events.push({ type: 'tool_call_start', index, id: call.id ?? 'call_' + String(index), name: call.name });
    for (const piece of splitText(JSON.stringify(call.args), options.chunkSize)) {
      events.push({ type: 'tool_call_args_delta', index, delta: piece });
    }
    events.push({ type: 'tool_call_end', index });
  });
  if (options.usage !== undefined) events.push({ type: 'usage', usage: options.usage });
  events.push({ type: 'finish', reason: 'tool_calls' });
  return options.delayMs === undefined ? { events } : { events, delayMs: options.delayMs };
}

/** 抛错的一轮，用于验证降级链与重试。 */
export function errorTurn(error: unknown, delayMs?: number): MockTurn {
  return delayMs === undefined ? { error } : { error, delayMs };
}

/** 按长度切片；chunkSize 缺省或非正数时整段返回。空串返回空数组。 */
function splitText(text: string, chunkSize?: number): string[] {
  if (text === '') return [];
  if (chunkSize === undefined || chunkSize <= 0) return [text];
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    pieces.push(text.slice(start, start + chunkSize));
  }
  return pieces;
}
