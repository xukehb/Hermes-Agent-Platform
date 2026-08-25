/**
 * 会话存储测试：内存实现与 SQLite 实现必须表现一致，因此绝大多数用例用
 * describe.each 同时跑两套实现。SQLite 用临时目录，测试结束统一清理。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemorySessionStore,
  SessionStoreRegistry,
  SqliteSessionStore,
  usageDay,
  zeroUsage,
} from '../src/storage/index.js';
import type { SessionStore, TaskRow, UsageRow } from '../src/agent/index.js';
import type { AgentMessage, TokenUsage } from '../src/domain/index.js';

const roots: string[] = [];
const stores: SessionStore[] = [];

/** 申请一个独立临时目录。 */
function tempRoot(prefix = 'hap-store-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function usage(prompt: number, completion: number): TokenUsage {
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

function userMessage(content: string, createdAt?: string): AgentMessage {
  const message: AgentMessage = { role: 'user', content };
  if (createdAt !== undefined) message.createdAt = createdAt;
  return message;
}

function taskRow(patch: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'task-1',
    agentId: 'alpha',
    sessionKey: 'tg:1',
    status: 'running',
    startedAt: '2026-08-24T10:00:00.000Z',
    iterations: 0,
    usage: zeroUsage(),
    model: 'mockp/model-a',
    ...patch,
  };
}

function usageRow(patch: Partial<UsageRow> = {}): UsageRow {
  return {
    at: '2026-08-24T10:00:00.000Z',
    agentId: 'alpha',
    providerId: 'mockp',
    model: 'mockp/model-a',
    usage: usage(10, 5),
    ...patch,
  };
}

afterAll(() => {
  for (const store of stores) store.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const implementations: Array<[string, () => SessionStore]> = [
  ['MemorySessionStore', (): SessionStore => {
    const store = new MemorySessionStore();
    stores.push(store);
    return store;
  }],
  ['SqliteSessionStore', (): SessionStore => {
    const store = new SqliteSessionStore(join(tempRoot(), 'sessions.db'));
    stores.push(store);
    return store;
  }],
];

describe.each(implementations)('%s 会话历史', (_name, create) => {
  it('按写入顺序追加并读回', () => {
    const store = create();
    store.appendMessages('tg:1', 'alpha', [userMessage('第一句'), { role: 'assistant', content: '第一答' }]);
    store.appendMessages('tg:1', 'alpha', [userMessage('第二句')]);

    const history = store.history('tg:1');
    expect(history.map((message) => message.content)).toEqual(['第一句', '第一答', '第二句']);
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('limit 取最近 N 条且保持正序', () => {
    const store = create();
    store.appendMessages('tg:2', 'alpha', [
      userMessage('一'),
      userMessage('二'),
      userMessage('三'),
      userMessage('四'),
    ]);

    expect(store.history('tg:2', 2).map((message) => message.content)).toEqual(['三', '四']);
    expect(store.history('tg:2', 99).map((message) => message.content)).toEqual(['一', '二', '三', '四']);
  });

  it('replaceHistory 整体替换且不留残留', () => {
    const store = create();
    store.appendMessages('tg:3', 'alpha', [userMessage('旧一'), userMessage('旧二'), userMessage('旧三')]);
    store.replaceHistory('tg:3', 'alpha', [
      { role: 'system', content: '【早期对话摘要】压缩后的内容' },
      userMessage('新一'),
    ]);

    const history = store.history('tg:3');
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('system');
    expect(history[1]?.content).toBe('新一');
  });

  it('replaceHistory 可连续调用（无嵌套事务问题）', () => {
    const store = create();
    store.appendMessages('tg:4', 'alpha', [userMessage('原始')]);
    for (let round = 1; round <= 3; round += 1) {
      store.replaceHistory('tg:4', 'alpha', [userMessage('第 ' + String(round) + ' 次替换')]);
    }
    expect(store.history('tg:4').map((message) => message.content)).toEqual(['第 3 次替换']);
  });

  it('保留工具调用与工具结果结构', () => {
    const store = create();
    store.appendMessages('tg:5', 'alpha', [
      {
        role: 'assistant',
        content: '我先读文件。',
        toolCalls: [{ id: 'call_0', name: 'read_file', args: { path: 'a.md' } }],
      },
      {
        role: 'tool',
        content: '文件内容',
        toolResult: { callId: 'call_0', name: 'read_file', content: '文件内容', isError: false, durationMs: 3 },
      },
    ]);

    const history = store.history('tg:5');
    expect(history[0]?.toolCalls?.[0]?.args).toEqual({ path: 'a.md' });
    expect(history[1]?.toolResult?.callId).toBe('call_0');
    expect(history[1]?.toolResult?.isError).toBe(false);
    expect(history[1]?.toolResult?.durationMs).toBe(3);
  });

  it('clearSession 只清目标会话', () => {
    const store = create();
    store.appendMessages('tg:6', 'alpha', [userMessage('留在 6')]);
    store.appendMessages('tg:7', 'alpha', [userMessage('留在 7')]);
    store.clearSession('tg:6');

    expect(store.history('tg:6')).toEqual([]);
    expect(store.history('tg:7')).toHaveLength(1);
  });

  it('未知会话返回空历史', () => {
    const store = create();
    expect(store.history('tg:不存在')).toEqual([]);
  });
});

describe.each(implementations)('%s 任务记录', (_name, create) => {
  it('beginTask 后可按 id 与会话查询', () => {
    const store = create();
    store.beginTask(taskRow());

    expect(store.task('task-1')?.status).toBe('running');
    expect(store.tasksBySession('tg:1')).toHaveLength(1);
    expect(store.runningTasks().map((row) => row.taskId)).toEqual(['task-1']);
    expect(store.task('task-none')).toBeUndefined();
  });

  it('updateTask 合并补丁字段', () => {
    const store = create();
    store.beginTask(taskRow());
    store.updateTask('task-1', {
      status: 'done',
      finishedAt: '2026-08-24T10:00:05.000Z',
      iterations: 3,
      usage: usage(100, 40),
      model: 'mockf/model-b',
      tracePath: '/tmp/trace.jsonl',
    });

    const row = store.task('task-1');
    expect(row?.status).toBe('done');
    expect(row?.iterations).toBe(3);
    expect(row?.usage.totalTokens).toBe(140);
    expect(row?.model).toBe('mockf/model-b');
    expect(row?.tracePath).toBe('/tmp/trace.jsonl');
    expect(store.runningTasks()).toEqual([]);
  });

  it('updateTask 对未知 id 静默忽略', () => {
    const store = create();
    expect(() => store.updateTask('task-none', { status: 'done' })).not.toThrow();
  });

  it('tasksBySession 按状态过滤并倒序返回', () => {
    const store = create();
    store.beginTask(taskRow({ taskId: 'task-a', startedAt: '2026-08-24T10:00:00.000Z' }));
    store.beginTask(taskRow({ taskId: 'task-b', startedAt: '2026-08-24T11:00:00.000Z' }));
    store.updateTask('task-a', { status: 'done', finishedAt: '2026-08-24T10:00:09.000Z' });

    expect(store.tasksBySession('tg:1').map((row) => row.taskId)).toEqual(['task-b', 'task-a']);
    expect(store.tasksBySession('tg:1', 'done').map((row) => row.taskId)).toEqual(['task-a']);
    expect(store.tasksBySession('tg:1', 'running').map((row) => row.taskId)).toEqual(['task-b']);
  });

  it('记录错误信息', () => {
    const store = create();
    store.beginTask(taskRow({ taskId: 'task-err' }));
    store.updateTask('task-err', { status: 'failed', error: '降级链全部失败' });
    expect(store.task('task-err')?.error).toBe('降级链全部失败');
  });
});

describe.each(implementations)('%s 用量统计', (_name, create) => {
  it('usageSince 按智能体/提供商/模型聚合并按总量降序', () => {
    const store = create();
    store.recordUsage(usageRow());
    store.recordUsage(usageRow({ usage: usage(20, 10) }));
    store.recordUsage(usageRow({ agentId: 'beta', providerId: 'mockf', model: 'mockf/model-b', usage: usage(5, 1) }));

    const rows = store.usageSince('2026-08-24T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.agentId).toBe('alpha');
    expect(rows[0]?.totalTokens).toBe(45);
    expect(rows[0]?.calls).toBe(2);
    expect(rows[0]?.promptTokens).toBe(30);
    expect(rows[1]?.agentId).toBe('beta');
    expect(rows[1]?.totalTokens).toBe(6);
  });

  it('usageSince 过滤早于时间点的记录', () => {
    const store = create();
    store.recordUsage(usageRow({ at: '2026-08-20T10:00:00.000Z' }));
    store.recordUsage(usageRow({ at: '2026-08-24T10:00:00.000Z' }));

    expect(store.usageSince('2026-08-23T00:00:00.000Z')).toHaveLength(1);
    expect(store.usageSince('2026-08-25T00:00:00.000Z')).toEqual([]);
  });

  it('dailyTokens 只统计当天该智能体', () => {
    const store = create();
    store.recordUsage(usageRow({ at: '2026-08-24T01:00:00.000Z', usage: usage(10, 10) }));
    store.recordUsage(usageRow({ at: '2026-08-24T23:00:00.000Z', usage: usage(30, 10) }));
    store.recordUsage(usageRow({ at: '2026-08-23T23:00:00.000Z', usage: usage(90, 10) }));
    store.recordUsage(usageRow({ agentId: 'beta', at: '2026-08-24T02:00:00.000Z', usage: usage(70, 10) }));

    expect(store.dailyTokens('alpha', '2026-08-24')).toBe(60);
    expect(store.dailyTokens('alpha', '2026-08-23')).toBe(100);
    expect(store.dailyTokens('gamma', '2026-08-24')).toBe(0);
  });
});

describe.each(implementations)('%s 保留期清理', (_name, create) => {
  it('prune 删除超期消息并返回条数', () => {
    const store = create();
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const fresh = new Date().toISOString();
    store.appendMessages('tg:old', 'alpha', [userMessage('很久以前', old), userMessage('也很久', old)]);
    store.appendMessages('tg:new', 'alpha', [userMessage('刚刚', fresh)]);

    expect(store.prune(30)).toBe(2);
    expect(store.history('tg:old')).toEqual([]);
    expect(store.history('tg:new')).toHaveLength(1);
  });

  it('prune 传 0 或负数视为不清理', () => {
    const store = create();
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    store.appendMessages('tg:keep', 'alpha', [userMessage('远古消息', old)]);
    expect(store.prune(0)).toBe(0);
    expect(store.history('tg:keep')).toHaveLength(1);
  });
});

describe('usageDay', () => {
  it('截取 ISO 时间戳的日期部分', () => {
    expect(usageDay('2026-08-24T18:30:00.000Z')).toBe('2026-08-24');
  });
});

describe('zeroUsage', () => {
  it('返回全零用量且每次都是新对象', () => {
    const first = zeroUsage();
    const second = zeroUsage();
    expect(first).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    first.totalTokens = 5;
    expect(second.totalTokens).toBe(0);
  });
});

describe('SqliteSessionStore 落盘', () => {
  it('数据写入磁盘后可由新连接读回', () => {
    const dir = tempRoot('hap-sqlite-');
    const file = join(dir, 'agent.db');
    const first = new SqliteSessionStore(file);
    first.appendMessages('tg:persist', 'alpha', [userMessage('落盘验证')]);
    first.beginTask(taskRow({ taskId: 'task-persist' }));
    first.recordUsage(usageRow());
    first.close();

    expect(existsSync(file)).toBe(true);

    const second = new SqliteSessionStore(file);
    stores.push(second);
    expect(second.path).toBe(file);
    expect(second.history('tg:persist').map((message) => message.content)).toEqual(['落盘验证']);
    expect(second.task('task-persist')?.agentId).toBe('alpha');
    expect(second.usageSince('2026-08-24T00:00:00.000Z')[0]?.totalTokens).toBe(15);
  });
});

describe('SessionStoreRegistry', () => {
  it('按智能体分库并缓存连接', () => {
    const root = tempRoot('hap-registry-');
    const registry = new SessionStoreRegistry((agentId) => join(root, agentId));
    const alpha = registry.store('alpha');
    expect(registry.store('alpha')).toBe(alpha);
    registry.store('beta');
    expect(registry.openIds).toEqual(['alpha', 'beta']);
    expect(alpha.path.includes('alpha')).toBe(true);
    registry.close();
    expect(registry.openIds).toEqual([]);
  });

  it('跨库聚合用量', () => {
    const root = tempRoot('hap-registry-');
    const registry = new SessionStoreRegistry((agentId) => join(root, agentId));
    registry.store('alpha').recordUsage(usageRow({ usage: usage(10, 5) }));
    registry.store('beta').recordUsage(usageRow({ agentId: 'beta', usage: usage(40, 20) }));

    const rows = registry.usageSince('2026-08-24T00:00:00.000Z', ['alpha', 'beta']);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.agentId).toBe('beta');
    expect(rows[0]?.totalTokens).toBe(60);
    expect(rows[1]?.agentId).toBe('alpha');
    registry.close();
  });

  it('markInterrupted 把残留的 running 任务标记为中断', () => {
    const root = tempRoot('hap-registry-');
    const registry = new SessionStoreRegistry((agentId) => join(root, agentId));
    registry.store('alpha').beginTask(taskRow({ taskId: 'task-live' }));
    registry.store('alpha').beginTask(taskRow({ taskId: 'task-done' }));
    registry.store('alpha').updateTask('task-done', { status: 'done' });

    const interrupted = registry.markInterrupted(['alpha']);
    expect(interrupted.map((row) => row.taskId)).toEqual(['task-live']);
    expect(registry.store('alpha').task('task-live')?.status).not.toBe('running');
    expect(registry.store('alpha').runningTasks()).toEqual([]);
    expect(registry.markInterrupted(['alpha'])).toEqual([]);
    registry.close();
  });

  it('跨库执行保留期清理', () => {
    const root = tempRoot('hap-registry-');
    const registry = new SessionStoreRegistry((agentId) => join(root, agentId));
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    registry.store('alpha').appendMessages('tg:a', 'alpha', [userMessage('旧', old)]);
    registry.store('beta').appendMessages('tg:b', 'beta', [userMessage('旧', old), userMessage('旧2', old)]);

    expect(registry.prune(30, ['alpha', 'beta'])).toBe(3);
    registry.close();
  });
});
