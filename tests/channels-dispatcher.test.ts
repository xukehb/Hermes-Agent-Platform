/**
 * 通道调度器测试：命令分派、流式回写、终态文案、串行队列。
 *
 * 用桩 ChannelHost 与桩 OutboundTarget（分别覆盖支持/不支持 edit 两种平台），
 * 因此完全不触网、不依赖真实编排层。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ChannelDispatcher,
  HELP_TEXT,
  OutboundSender,
  describeError,
  renderStatus,
  renderTrace,
  renderUsage,
  type ChannelHost,
  type InboundMessage,
  type OutboundTarget,
} from '../src/channels/index.js';
import type {
  RunTaskRequest,
  SessionStatus,
  TaskEvent,
  TaskOutcome,
  TaskRow,
  TraceSummary,
  UsageAggregate,
} from '../src/agent/index.js';
import { RecoverableError, emptyUsage, type TokenUsage } from '../src/domain/index.js';

const root = mkdtempSync(join(tmpdir(), 'hap-dispatch-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 出站记录桩：可切换是否支持 edit。 */
class FakeTarget implements OutboundTarget {
  readonly channel = 'telegram' as const;
  readonly targetId = 'chat:1';
  readonly sent: string[] = [];
  readonly edits: Array<{ id: string; text: string }> = [];
  edit?: (messageId: string, text: string) => Promise<boolean>;

  constructor(editable: boolean) {
    if (editable) {
      this.edit = async (messageId, text) => {
        this.edits.push({ id: messageId, text });
        return true;
      };
    }
  }

  async send(text: string): Promise<string | undefined> {
    this.sent.push(text);
    return 'm' + String(this.sent.length);
  }

  /** 最后一条出站文本，测试断言用。 */
  get last(): string {
    return this.sent[this.sent.length - 1] ?? '';
  }
}

function usage(total: number): TokenUsage {
  return { promptTokens: total, completionTokens: 0, totalTokens: total };
}

function taskRow(patch: Partial<TaskRow> = {}): TaskRow {
  const row: TaskRow = {
    taskId: 'task-aaaaaaaa-1',
    agentId: 'coder',
    sessionKey: 'chat:1',
    status: 'done',
    startedAt: '2026-08-24T00:00:00.000Z',
    iterations: 1,
    usage: usage(120),
    model: 'deepseek/deepseek-chat',
  };
  return { ...row, ...patch };
}

function statusOf(patch: Partial<SessionStatus> = {}): SessionStatus {
  const base: SessionStatus = {
    sessionKey: 'chat:1',
    agentId: 'coder',
    model: 'deepseek/deepseek-chat',
    chain: ['deepseek/deepseek-chat'],
    running: [],
    recent: [],
    todayTokens: 0,
    dailyTokenBudget: 0,
  };
  return { ...base, ...patch };
}

function outcomeOf(patch: Partial<TaskOutcome> = {}): TaskOutcome {
  const base: TaskOutcome = {
    taskId: 'task-abcdefgh-9',
    agentId: 'coder',
    sessionKey: 'chat:1',
    status: 'done',
    tracePath: join(root, 'trace.jsonl'),
    text: '任务完成',
    reasoning: '',
    messages: [],
    usage: usage(300),
    iterations: 1,
    model: 'deepseek/deepseek-chat',
    protocol: 'deepseek',
    finishReason: 'stop',
    stopReason: 'stop',
    retranslations: 0,
  };
  return { ...base, ...patch };
}

/** 宿主桩：记录调用，行为可逐例覆写。 */
class FakeHost implements ChannelHost {
  outcome: TaskOutcome = outcomeOf();
  failure: unknown;
  events: TaskEvent[] = [];
  aborted: string[] = [];
  statusValue: SessionStatus = statusOf();
  traceValue: TraceSummary | undefined;
  agents: string[] = ['coder', 'researcher'];
  usageRows: UsageAggregate[] = [];
  readonly requests: RunTaskRequest[] = [];
  readonly cleared: string[] = [];
  readonly usageQueries: string[] = [];
  runDelayMs = 0;

  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
    this.requests.push(request);
    for (const event of this.events) {
      request.onEvent?.(event);
    }
    if (this.runDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.runDelayMs));
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.outcome;
  }

  abortSession(): string[] {
    return this.aborted;
  }

  status(): SessionStatus {
    return this.statusValue;
  }

  trace(): TraceSummary | undefined {
    return this.traceValue;
  }

  agentIds(): string[] {
    return this.agents;
  }

  clearSession(sessionKey: string): void {
    this.cleared.push(sessionKey);
  }

  usageSince(since: string): UsageAggregate[] {
    this.usageQueries.push(since);
    return this.usageRows;
  }
}

function inbound(text: string, target: OutboundTarget, patch: Partial<InboundMessage> = {}): InboundMessage {
  const base: InboundMessage = {
    channel: 'telegram',
    sessionKey: 'chat:1',
    text,
    receivedAt: '2026-08-24T00:00:00.000Z',
    target,
  };
  return { ...base, ...patch };
}

describe('ChannelDispatcher 命令分派', () => {
  let host: FakeHost;
  let target: FakeTarget;
  let dispatcher: ChannelDispatcher;

  beforeEach(() => {
    host = new FakeHost();
    target = new FakeTarget(false);
    dispatcher = new ChannelDispatcher({
      host,
      sender: new OutboundSender(join(root, 'spool')),
      messageCharLimit: 0,
      editIntervalMs: 0,
      asyncThresholdMs: 0,
      queueCapacity: 8,
    });
  });

  it('空文本且无附件回帮助文案', async () => {
    await dispatcher.handle(inbound('   ', target));
    expect(target.last).toBe(HELP_TEXT);
  });

  it('/help 回帮助文案', async () => {
    await dispatcher.handle(inbound('/help', target));
    expect(target.last).toBe(HELP_TEXT);
  });

  it('未知指令附带帮助文案', async () => {
    await dispatcher.handle(inbound('/nosuch', target));
    expect(target.last.startsWith('未知指令 /nosuch。')).toBe(true);
    expect(target.last.includes('/agents 列出全部智能体')).toBe(true);
  });

  it('/stop 无任务与有任务两种文案', async () => {
    await dispatcher.handle(inbound('/stop', target));
    expect(target.last).toBe('当前会话没有正在执行的任务。');
    host.aborted = ['t1', 't2'];
    await dispatcher.handle(inbound('/cancel', target));
    expect(target.last).toBe('已中止 2 个任务：t1、t2');
  });

  it('/new 清空会话并回执', async () => {
    await dispatcher.handle(inbound('/new', target, { sessionKey: 'chat:7' }));
    expect(host.cleared).toEqual(['chat:7']);
    expect(target.last).toBe('已清空当前会话历史，下一条消息将开启新上下文。');
  });

  it('/status 渲染会话状态', async () => {
    host.statusValue = statusOf({
      chain: ['a/x', 'b/y'],
      todayTokens: 42,
      dailyTokenBudget: 1000,
      running: [taskRow({ taskId: 'run-1234abcd', status: 'running' })],
      recent: [taskRow({ taskId: 'old-1234abcd', title: '写单测' })],
    });
    await dispatcher.handle(inbound('/status', target));
    const text = target.last;
    expect(text.includes('会话 chat:1')).toBe(true);
    expect(text.includes('降级链 a/x → b/y')).toBe(true);
    expect(text.includes('今日用量 42 / 1000 tokens')).toBe(true);
    expect(text.includes('正在执行：')).toBe(true);
    expect(text.includes('写单测')).toBe(true);
  });

  it('/agents 空与非空', async () => {
    await dispatcher.handle(inbound('/agents', target));
    expect(target.last.includes('coder')).toBe(true);
    host.agents = [];
    await dispatcher.handle(inbound('/agents', target));
    expect(target.last).toBe('尚未配置任何智能体。');
    host.agents = ['coder', 'researcher'];
  });

  it('/agent 带 id 与不带 id 都回状态视图', async () => {
    await dispatcher.handle(inbound('/agent researcher', target));
    expect(target.last.includes('researcher')).toBe(true);
    await dispatcher.handle(inbound('/agent', target));
    expect(target.last.includes('会话') || target.last.includes('智能体')).toBe(true);
  });

  it('/trace 无记录、未知 id、正常三种分支', async () => {
    await dispatcher.handle(inbound('/trace', target));
    expect(target.last).toBe('当前会话还没有任务记录。');

    await dispatcher.handle(inbound('/trace nosuch-id', target));
    expect(target.last).toBe('找不到任务 nosuch-id。');

    host.traceValue = {
      taskId: 'task-1',
      status: 'done',
      filePath: join(root, 'task-1.jsonl'),
      counts: { text: 2 },
      route: 'explicit(@coder)',
      protocol: 'deepseek',
      models: ['a/x', 'b/y'],
      tools: [{ name: 'read_file', durationMs: 12, isError: false }],
      switches: [{ from: 'a/x', to: 'b/y', reason: '限流' }],
      usage: usage(88),
      iterations: 3,
      error: undefined,
    };
    await dispatcher.handle(inbound('/trace task-1', target));
    const text = target.last;
    expect(text.includes('任务 task-1')).toBe(true);
    expect(text.includes('模型 a/x → b/y')).toBe(true);
    expect(text.includes('迭代 3 轮 · 88 tokens')).toBe(true);
    expect(text.includes('· ✓ read_file 12ms')).toBe(true);
  });

  it('/trace 不带参数时取会话最近任务', async () => {
    host.statusValue = statusOf({ recent: [taskRow({ taskId: 'recent-1' })] });
    host.traceValue = undefined;
    await dispatcher.handle(inbound('/trace', target));
    expect(target.last).toBe('找不到任务 recent-1。');
  });

  it('/usage 按天数换算起始时间并渲染', async () => {
    await dispatcher.handle(inbound('/usage 3', target));
    expect(target.last).toBe('最近 3 天没有用量记录。');
    const since = Date.parse(host.usageQueries[0] ?? '');
    const expected = Date.now() - 3 * 86_400_000;
    expect(Math.abs(since - expected) < 5000).toBe(true);

    host.usageRows = [
      {
        agentId: 'coder',
        providerId: 'deepseek',
        model: 'deepseek-chat',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        calls: 2,
      },
    ];
    await dispatcher.handle(inbound('/usage', target));
    expect(target.last.includes('最近 7 天用量：')).toBe(true);
    expect(target.last.includes('· coder · deepseek/deepseek-chat · 15 tokens · 2 次')).toBe(true);
    expect(target.last.includes('合计 15 tokens')).toBe(true);
  });
});

describe('ChannelDispatcher 任务执行', () => {
  function build(host: FakeHost, editable: boolean, patch: Partial<{ editIntervalMs: number; asyncThresholdMs: number; messageCharLimit: number }> = {}) {
    const target = new FakeTarget(editable);
    const dispatcher = new ChannelDispatcher({
      host,
      sender: new OutboundSender(join(root, 'spool')),
      messageCharLimit: patch.messageCharLimit ?? 0,
      editIntervalMs: patch.editIntervalMs ?? 0,
      asyncThresholdMs: patch.asyncThresholdMs ?? 0,
      queueCapacity: 8,
    });
    return { target, dispatcher };
  }

  it('支持 edit 的通道先发占位再编辑终态', async () => {
    const host = new FakeHost();
    host.events = [
      { type: 'iteration', index: 1 },
      { type: 'tool_start', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'tool_end', result: { callId: 'c1', name: 'read_file', content: 'ok', isError: false, durationMs: 12 } },
      { type: 'text', text: '已读取文件' },
    ];
    host.outcome = outcomeOf({ text: '已读取文件' });
    const { target, dispatcher } = build(host, true);
    await dispatcher.handle(inbound('看看 a.ts', target));

    expect(target.sent).toHaveLength(1);
    expect(target.sent[0]?.startsWith('⚙ hap 正在处理')).toBe(true);
    expect(target.edits.length >= 1).toBe(true);
    const final = target.edits[target.edits.length - 1]?.text ?? '';
    expect(final.includes('已读取文件')).toBe(true);
    expect(final.includes('· deepseek/deepseek-chat · 300 tokens · task-abc')).toBe(true);
  });

  it('不支持 edit 的通道只在终态发一条', async () => {
    const host = new FakeHost();
    host.events = [{ type: 'iteration', index: 1 }, { type: 'text', text: '好了' }];
    host.outcome = outcomeOf({ text: '好了' });
    const { target, dispatcher } = build(host, false);
    await dispatcher.handle(inbound('干活', target));
    expect(target.sent).toHaveLength(1);
    expect(target.last.includes('好了')).toBe(true);
  });

  it('智能体前缀进入 header 与请求参数', async () => {
    const host = new FakeHost();
    const { target, dispatcher } = build(host, true);
    await dispatcher.handle(inbound('干活', target, { agentId: 'researcher', defaultAgent: 'coder' }));
    expect(target.sent[0]).toBe('⚙ researcher 正在处理…');
    expect(host.requests[0]?.agentId).toBe('researcher');
    expect(host.requests[0]?.channelDefaultAgent).toBe('coder');
    expect(host.requests[0]?.sessionKey).toBe('chat:1');
  });

  it('runTask 抛错时回失败文案', async () => {
    const host = new FakeHost();
    host.failure = new RecoverableError('PROVIDER_RATE_LIMIT', 'rate limited', { userMessage: '上游限流，请稍后再试' });
    const { target, dispatcher } = build(host, false);
    await dispatcher.handle(inbound('干活', target));
    expect(target.last.includes('✗ 任务失败：上游限流，请稍后再试')).toBe(true);
    expect(target.last.includes('（本次没有产生正文输出）')).toBe(true);
  });

  it('中止与轮数上限有各自终态提示', async () => {
    const abortedHost = new FakeHost();
    abortedHost.outcome = outcomeOf({ status: 'aborted', text: '' });
    const a = build(abortedHost, false);
    await a.dispatcher.handle(inbound('干活', a.target));
    expect(a.target.last.includes('⏹ 任务已中止。')).toBe(true);

    const cappedHost = new FakeHost();
    cappedHost.outcome = outcomeOf({ stopReason: 'max_iterations', iterations: 24, text: '部分结果' });
    const b = build(cappedHost, false);
    await b.dispatcher.handle(inbound('干活', b.target));
    expect(b.target.last.includes('⚠ 已达工具调用轮数上限（24 轮）')).toBe(true);

    const exhaustedHost = new FakeHost();
    exhaustedHost.outcome = outcomeOf({ stopReason: 'fallback_exhausted', text: '半成品' });
    const c = build(exhaustedHost, false);
    await c.dispatcher.handle(inbound('干活', c.target));
    expect(c.target.last.includes('⚠ 所有备用模型均不可用')).toBe(true);
  });

  it('failed 状态用 outcome.error 文案', async () => {
    const host = new FakeHost();
    host.outcome = outcomeOf({ status: 'failed', error: '模型不可达', text: '' });
    const { target, dispatcher } = build(host, false);
    await dispatcher.handle(inbound('干活', target));
    expect(target.last.includes('✗ 任务失败：模型不可达')).toBe(true);
  });

  it('模型降级事件出现在终态视图', async () => {
    const host = new FakeHost();
    host.events = [
      { type: 'model_switch', from: 'a/x', to: 'b/y', reason: '限流' },
      { type: 'text', text: '兜底完成' },
    ];
    host.outcome = outcomeOf({ text: '兜底完成' });
    const { target, dispatcher } = build(host, false);
    await dispatcher.handle(inbound('干活', target));
    expect(target.last.includes('↻ a/x → b/y（限流）')).toBe(true);
  });

  it('终态超长时首片编辑其余补发', async () => {
    const host = new FakeHost();
    const long = 'A'.repeat(120) + '\n' + 'B'.repeat(120);
    host.outcome = outcomeOf({ text: long, usage: emptyUsage() });
    host.events = [{ type: 'text', text: long }];
    const { target, dispatcher } = build(host, true, { messageCharLimit: 130 });
    await dispatcher.handle(inbound('干活', target));
    expect(target.edits.length >= 1).toBe(true);
    expect(target.sent.length >= 2).toBe(true);
    expect((target.edits[target.edits.length - 1]?.text ?? '').length <= 130).toBe(true);
  });

  it('submit + drain 保证同会话串行', async () => {
    const host = new FakeHost();
    host.runDelayMs = 20;
    const { target, dispatcher } = build(host, false);
    dispatcher.submit(inbound('第一件事', target));
    dispatcher.submit(inbound('第二件事', target));
    await dispatcher.drain();
    expect(host.requests.map((r) => r.input)).toEqual(['第一件事', '第二件事']);
    expect(target.sent).toHaveLength(2);
  });
});

describe('通道视图辅助函数', () => {
  it('describeError 优先 userMessage', () => {
    expect(describeError(new RecoverableError('TOOL_FAILED', 'raw', { userMessage: '友好提示' }))).toBe('友好提示');
    expect(describeError(new Error('普通错误'))).toBe('普通错误');
    expect(describeError('字符串错误')).toBe('字符串错误');
  });

  it('renderStatus 无预算时显示不限', () => {
    const text = renderStatus(statusOf({ todayTokens: 5 }));
    expect(text.includes('今日用量 5 / 不限 tokens')).toBe(true);
    expect(text.includes('降级链')).toBe(false);
  });

  it('renderTrace 折叠超过 12 条工具并提示文件路径', () => {
    const tools = Array.from({ length: 15 }, (_, i) => ({ name: 'tool' + String(i), durationMs: 1, isError: false }));
    const text = renderTrace({
      taskId: 't',
      status: 'failed',
      filePath: 'C:/tmp/t.jsonl',
      counts: {},
      route: undefined,
      protocol: undefined,
      models: [],
      tools,
      switches: [],
      usage: emptyUsage(),
      iterations: 0,
      error: '炸了',
    });
    expect(text.includes('模型 未记录')).toBe(true);
    expect(text.includes('… 其余 3 条见 C:/tmp/t.jsonl')).toBe(true);
    expect(text.includes('错误 炸了')).toBe(true);
    expect(text.includes('路由')).toBe(false);
  });

  it('renderUsage 空集合与合计', () => {
    expect(renderUsage([], 14)).toBe('最近 14 天没有用量记录。');
  });
});
