/**
 * HTTP 通道测试：直接调用 hono 的 fetch 处理器，不真实监听端口。
 *
 * 覆盖健康检查、智能体列表、会话状态、轨迹查询、用量、中止、
 * 同步执行、SSE 流式执行与命令语义端点的成功与失败分支。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { HttpChannel, HELP_TEXT, type ChannelHost } from '../src/channels/index.js';
import { BUILTIN_CHANNELS, BUILTIN_LIMITS, type ResolvedChannels, type ResolvedLimits, type ResolvedPaths } from '../src/config/index.js';
import type {
  RunTaskRequest,
  SessionStatus,
  TaskEvent,
  TaskOutcome,
  TraceSummary,
  UsageAggregate,
} from '../src/agent/index.js';
import { FatalError } from '../src/domain/index.js';

const root = mkdtempSync(join(tmpdir(), 'hap-http-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const paths: ResolvedPaths = {
  dataDir: root,
  traceDir: join(root, 'traces'),
  overflowDir: join(root, 'overflow'),
  spoolDir: join(root, 'spool'),
};

const limits: ResolvedLimits = {
  maxIterations: BUILTIN_LIMITS.maxIterations,
  maxSubagentDepth: BUILTIN_LIMITS.maxSubagentDepth,
  toolTimeoutMs: BUILTIN_LIMITS.toolTimeoutMs,
  toolOutputMaxBytes: BUILTIN_LIMITS.toolOutputMaxBytes,
  compactThreshold: BUILTIN_LIMITS.compactThreshold,
  dailyTokenBudget: BUILTIN_LIMITS.dailyTokenBudget,
  sessionRetentionDays: BUILTIN_LIMITS.sessionRetentionDays,
  ingressQueueSize: BUILTIN_LIMITS.ingressQueueSize,
  providerConcurrency: {},
  providerRpm: {},
  agentConcurrency: {},
  agentRpm: {},
  defaultProviderConcurrency: BUILTIN_LIMITS.defaultProviderConcurrency,
  defaultAgentConcurrency: BUILTIN_LIMITS.defaultAgentConcurrency,
};

function channelsOf(defaultAgent?: string): ResolvedChannels {
  return {
    editIntervalMs: BUILTIN_CHANNELS.editIntervalMs,
    asyncThresholdMs: BUILTIN_CHANNELS.asyncThresholdMs,
    telegram: {
      enabled: false,
      tokenEnv: BUILTIN_CHANNELS.telegram.tokenEnv,
      mode: 'polling',
      defaultAgent: undefined,
      mentionPatterns: [...BUILTIN_CHANNELS.telegram.mentionPatterns],
      messageCharLimit: BUILTIN_CHANNELS.telegram.messageCharLimit,
      webhook: undefined,
    },
    whatsapp: {
      enabled: false,
      authDir: join(root, 'wa-auth'),
      defaultAgent: undefined,
      mentionPatterns: [],
      messageCharLimit: 4096,
      reconnectInitialMs: 1000,
      reconnectMaxMs: 30000,
      qrLog: false,
    },
    wechat: BUILTIN_CHANNELS.wechat,
    http: { enabled: true, bind: '127.0.0.1:8799', defaultAgent },
    cli: { enabled: true, defaultAgent: undefined },
  };
}

function outcomeOf(patch: Partial<TaskOutcome> = {}): TaskOutcome {
  const base: TaskOutcome = {
    taskId: 'task-http-1',
    agentId: 'coder',
    sessionKey: 'http:default',
    status: 'done',
    tracePath: join(root, 'traces', 'task-http-1.jsonl'),
    text: '完成了',
    reasoning: '思考过程',
    messages: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    iterations: 2,
    model: 'deepseek/deepseek-chat',
    protocol: 'deepseek',
    finishReason: 'stop',
    stopReason: 'stop',
    retranslations: 0,
  };
  return { ...base, ...patch };
}

/** 宿主桩：记录调用，行为逐例覆写。 */
class FakeHost implements ChannelHost {
  outcome: TaskOutcome = outcomeOf();
  failure: unknown;
  events: TaskEvent[] = [];
  statusValue: SessionStatus = {
    sessionKey: 'http:default',
    agentId: 'coder',
    model: 'deepseek/deepseek-chat',
    chain: ['deepseek/deepseek-chat'],
    running: [],
    recent: [],
    todayTokens: 7,
    dailyTokenBudget: 100,
  };
  traceValue: TraceSummary | undefined;
  usageRows: UsageAggregate[] = [];
  aborted: string[] = [];
  readonly requests: RunTaskRequest[] = [];
  readonly statusKeys: Array<{ key: string; def?: string }> = [];
  readonly abortKeys: string[] = [];
  readonly usageQueries: string[] = [];
  readonly cleared: string[] = [];

  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
    this.requests.push(request);
    for (const event of this.events) {
      request.onEvent?.(event);
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.outcome;
  }

  abortSession(sessionKey: string): string[] {
    this.abortKeys.push(sessionKey);
    return this.aborted;
  }

  status(sessionKey: string, channelDefaultAgent?: string): SessionStatus {
    const row: { key: string; def?: string } = { key: sessionKey };
    if (channelDefaultAgent !== undefined) {
      row.def = channelDefaultAgent;
    }
    this.statusKeys.push(row);
    return this.statusValue;
  }

  trace(): TraceSummary | undefined {
    return this.traceValue;
  }

  agentIds(): string[] {
    return ['coder', 'writer'];
  }

  clearSession(sessionKey: string): void {
    this.cleared.push(sessionKey);
  }

  usageSince(since: string): UsageAggregate[] {
    this.usageQueries.push(since);
    return this.usageRows;
  }
}

function get(channel: HttpChannel, path: string): Promise<Response> {
  return Promise.resolve(channel.fetch(new Request('http://local' + path)));
}

function post(channel: HttpChannel, path: string, body?: unknown, raw?: string): Promise<Response> {
  const init: RequestInit = { method: 'POST' };
  if (raw !== undefined) {
    init.body = raw;
    init.headers = { 'content-type': 'application/json' };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return Promise.resolve(channel.fetch(new Request('http://local' + path, init)));
}

describe('HttpChannel 只读端点', () => {
  let host: FakeHost;
  let channel: HttpChannel;

  beforeEach(() => {
    host = new FakeHost();
    channel = new HttpChannel({ host, channels: channelsOf('coder'), limits, paths });
  });

  it('GET /health 返回智能体列表', async () => {
    const res = await get(channel, '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, agents: ['coder', 'writer'] });
  });

  it('GET /agents 返回智能体列表', async () => {
    const res = await get(channel, '/agents');
    expect(await res.json()).toEqual({ agents: ['coder', 'writer'] });
  });

  it('GET /status/:session 带上通道默认智能体', async () => {
    const res = await get(channel, '/status/chat%3A9');
    const payload = (await res.json()) as { status: SessionStatus; text: string };
    expect(payload.status.agentId).toBe('coder');
    expect(payload.text.includes('今日用量 7 / 100 tokens')).toBe(true);
    expect(host.statusKeys[0]).toEqual({ key: 'chat:9', def: 'coder' });
  });

  it('GET /trace/:taskId 未找到返回 404', async () => {
    const res = await get(channel, '/trace/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '找不到该任务' });
  });

  it('GET /trace/:taskId 命中返回摘要与文本', async () => {
    host.traceValue = {
      taskId: 'task-http-1',
      status: 'done',
      filePath: join(root, 'traces', 'task-http-1.jsonl'),
      counts: { text: 1 },
      route: 'global-default',
      protocol: 'deepseek',
      models: ['deepseek/deepseek-chat'],
      tools: [],
      switches: [],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      iterations: 1,
      error: undefined,
    };
    const res = await get(channel, '/trace/task-http-1');
    const payload = (await res.json()) as { trace: TraceSummary; text: string };
    expect(payload.trace.taskId).toBe('task-http-1');
    expect(payload.text.includes('路由 global-default')).toBe(true);
  });

  it('GET /usage 支持 days 参数并对非法值回退 7 天', async () => {
    const res = await get(channel, '/usage?days=3');
    const payload = (await res.json()) as { days: number; rows: UsageAggregate[] };
    expect(payload.days).toBe(3);
    expect(payload.rows).toEqual([]);

    const bad = await get(channel, '/usage?days=abc');
    expect(((await bad.json()) as { days: number }).days).toBe(7);
    expect(host.usageQueries).toHaveLength(2);
  });

  it('POST /stop/:session 返回被中止的任务', async () => {
    host.aborted = ['t1'];
    const res = await post(channel, '/stop/http%3Aabc');
    expect(await res.json()).toEqual({ aborted: ['t1'] });
    expect(host.abortKeys).toEqual(['http:abc']);
  });

  it('Bearer Token 保护所有端点且拒绝超大请求体', async () => {
    const secured = new HttpChannel({
      host,
      channels: channelsOf(),
      limits,
      paths,
      authToken: 'http-secret',
      maxBodyBytes: 16,
    });
    const missing = await secured.fetch(new Request('http://local/health'));
    expect(missing.status).toBe(401);
    const ok = await secured.fetch(new Request('http://local/health', {
      headers: { Authorization: 'Bearer http-secret' },
    }));
    expect(ok.status).toBe(200);
    const oversized = await secured.fetch(new Request('http://local/run', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer http-secret',
        'Content-Type': 'application/json',
        'Content-Length': '1000',
      },
      body: JSON.stringify({ input: 'too large' }),
    }));
    expect(oversized.status).toBe(413);
    expect(host.requests).toHaveLength(0);
  });

  it('公网监听没有 Token 时在 start 前失败', async () => {
    const publicChannel = new HttpChannel({
      host,
      channels: { ...channelsOf(), http: { ...channelsOf().http, bind: '0.0.0.0:8799' } },
      limits,
      paths,
    });
    await expect(publicChannel.start()).rejects.toThrow(/authToken/);
  });
});

describe('HttpChannel 执行端点', () => {
  let host: FakeHost;
  let channel: HttpChannel;

  beforeEach(() => {
    host = new FakeHost();
    channel = new HttpChannel({ host, channels: channelsOf(), limits, paths });
  });

  it('POST /run 返回完整结果字段', async () => {
    const res = await post(channel, '/run', {
      input: '写单测',
      agent: 'coder',
      model: 'mockp/model-a',
      session: 'http:s1',
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.taskId).toBe('task-http-1');
    expect(payload.text).toBe('完成了');
    expect(payload.model).toBe('deepseek/deepseek-chat');
    expect(payload.iterations).toBe(2);
    expect(payload.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(host.requests[0]?.agentId).toBe('coder');
    expect(host.requests[0]?.model).toBe('mockp/model-a');
    expect(host.requests[0]?.sessionKey).toBe('http:s1');
    expect(host.requests[0]?.channelDefaultAgent).toBeUndefined();
  });

  it('POST /run 缺省会话为 http:default', async () => {
    await post(channel, '/run', { input: '干活' });
    expect(host.requests[0]?.sessionKey).toBe('http:default');
  });

  it('POST /run 非 JSON 与空 input 返回 400', async () => {
    const notJson = await post(channel, '/run', undefined, '不是 JSON');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: '请求体必须是 JSON' });

    const empty = await post(channel, '/run', { input: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'input 不能为空' });
  });

  it('POST /run 执行抛错返回 500 且带用户文案', async () => {
    host.failure = new FatalError('FALLBACK_EXHAUSTED', 'all down', { userMessage: '所有模型都挂了' });
    const res = await post(channel, '/run', { input: '干活' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '所有模型都挂了' });
  });

  it('POST /stream 推送事件流并以 done 收尾', async () => {
    host.events = [
      { type: 'iteration', index: 1 },
      { type: 'text', text: '进度' },
    ];
    const res = await post(channel, '/stream', { input: '干活' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.includes('text/event-stream')).toBe(true);
    const body = await res.text();
    expect(body.includes('event: iteration')).toBe(true);
    expect(body.includes('event: text')).toBe(true);
    expect(body.includes('event: done')).toBe(true);
    expect(body.includes('task-http-1')).toBe(true);
  });

  it('POST /stream 失败时以 error 事件收尾', async () => {
    host.failure = new FatalError('PROVIDER_UNREACHABLE', 'boom', { userMessage: '上游不可达' });
    const res = await post(channel, '/stream', { input: '干活' });
    const body = await res.text();
    expect(body.includes('event: error')).toBe(true);
    expect(body.includes('上游不可达')).toBe(true);
  });

  it('POST /stream 校验请求体', async () => {
    const notJson = await post(channel, '/stream', undefined, '{');
    expect(notJson.status).toBe(400);
    const empty = await post(channel, '/stream', { input: '' });
    expect(empty.status).toBe(400);
  });
});

describe('HttpChannel /message 命令语义', () => {
  let host: FakeHost;
  let channel: HttpChannel;

  beforeEach(() => {
    host = new FakeHost();
    channel = new HttpChannel({ host, channels: channelsOf('writer'), limits, paths });
  });

  it('普通文本走任务执行并回终态文本', async () => {
    host.events = [{ type: 'text', text: '完成了' }];
    const res = await post(channel, '/message', { input: '干活', session: 'http:m1' });
    const payload = (await res.json()) as { session: string; replies: string[]; text: string };
    expect(payload.session).toBe('http:m1');
    expect(payload.replies).toHaveLength(1);
    expect(payload.text.includes('完成了')).toBe(true);
    expect(host.requests[0]?.channelDefaultAgent).toBe('writer');
  });

  it('斜杠命令走命令分派', async () => {
    const res = await post(channel, '/message', { input: '/agents' });
    const payload = (await res.json()) as { session: string; text: string };
    expect(payload.session).toBe('http:default');
    expect(payload.text).toBe('已配置智能体：\n· coder\n· writer');
    expect(host.requests).toHaveLength(0);
  });

  it('/new 清空会话历史', async () => {
    await post(channel, '/message', { input: '/new', session: 'http:m2' });
    expect(host.cleared).toEqual(['http:m2']);
  });

  it('空文本回帮助文案', async () => {
    const res = await post(channel, '/message', { input: '' });
    const payload = (await res.json()) as { text: string };
    expect(payload.text).toBe(HELP_TEXT);
  });

  it('agent 字段作为显式路由传入', async () => {
    await post(channel, '/message', { input: '干活', agent: 'coder' });
    expect(host.requests[0]?.agentId).toBe('coder');
  });

  it('非 JSON 请求体返回 400', async () => {
    const res = await post(channel, '/message', undefined, 'nope');
    expect(res.status).toBe(400);
  });
});
