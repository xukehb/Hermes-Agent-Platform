/**
 * SQLite 会话与任务存储（FR-AGT-002、FR-TASK-004/007/008）。
 *
 * 用 better-sqlite3 的同步 API：会话读写都在请求路径上，一次几十微秒的同步查询
 * 比引入异步驱动的调度开销更划算，也让 SessionStore 接口保持同步、无需在
 * 循环里到处 await 存储。
 *
 * 每个智能体一个库文件（agent_dir/sessions.db，FR-AGT-002 的隔离要求），
 * 由 SessionStoreRegistry 按 agentId 分发；跨智能体的用量汇总走 usage 表的
 * 逐库累加（agent 数量是配置级的个位数，扫全部库的成本可忽略）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentMessage, ToolCall, ToolResult, TokenUsage } from '../domain/index.js';
import { emptyUsage } from '../domain/index.js';
import type {
  SessionStore,
  TaskRow,
  TaskStatus,
  UsageAggregate,
  UsageRow,
} from '../agent/types.js';

/** 建表语句。WAL 模式让读写不互相阻塞（通道与 CLI 可能同时访问同一个库）。 */
const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  `CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    tool_calls TEXT,
    tool_result TEXT,
    attachments TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_key, id)',
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    iterations INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    title TEXT,
    error TEXT,
    trace_path TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks (session_key, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)',
  `CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    day TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_usage_at ON usage (at)',
  'CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (agent_id, day)',
];

/** 数据库行的原始形态。better-sqlite3 返回 unknown，用这些类型收窄。 */
interface MessageRecord {
  role: string;
  content: string;
  reasoning: string | null;
  tool_calls: string | null;
  tool_result: string | null;
  attachments: string | null;
  created_at: string;
}

interface TaskRecord {
  task_id: string;
  agent_id: string;
  session_key: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  iterations: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  model: string;
  title: string | null;
  error: string | null;
  trace_path: string | null;
}

interface UsageRecord {
  agent_id: string;
  provider_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
}

/** JSON 列的安全解析：坏数据不应让整个会话读取失败。 */
function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function toMessage(record: MessageRecord): AgentMessage {
  const message: AgentMessage = {
    role: record.role as AgentMessage['role'],
    content: record.content,
    createdAt: record.created_at,
  };
  if (record.reasoning !== null && record.reasoning !== '') message.reasoning = record.reasoning;
  const calls = parseJson<ToolCall[]>(record.tool_calls);
  if (calls !== undefined && calls.length > 0) message.toolCalls = calls;
  const result = parseJson<ToolResult>(record.tool_result);
  if (result !== undefined) message.toolResult = result;
  const attachments = parseJson<NonNullable<AgentMessage['attachments']>>(record.attachments);
  if (attachments !== undefined && attachments.length > 0) message.attachments = attachments;
  return message;
}

function toTaskRow(record: TaskRecord): TaskRow {
  const row: TaskRow = {
    taskId: record.task_id,
    agentId: record.agent_id,
    sessionKey: record.session_key,
    status: record.status as TaskStatus,
    startedAt: record.started_at,
    iterations: record.iterations,
    usage: {
      promptTokens: record.prompt_tokens,
      completionTokens: record.completion_tokens,
      totalTokens: record.total_tokens,
    },
    model: record.model,
  };
  if (record.finished_at !== null) row.finishedAt = record.finished_at;
  if (record.title !== null) row.title = record.title;
  if (record.error !== null) row.error = record.error;
  if (record.trace_path !== null) row.tracePath = record.trace_path;
  return row;
}

/** 取 ISO 时间戳的日期部分，用于日预算统计。 */
export function usageDay(at: string): string {
  return at.slice(0, 10);
}

export class SqliteSessionStore implements SessionStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    for (const statement of SCHEMA) this.db.exec(statement);
  }

  history(sessionKey: string, limit?: number): AgentMessage[] {
    // 按 id 倒序取最近 limit 条再翻回正序：正序 LIMIT 会取到最早的消息
    const sql = limit === undefined
      ? 'SELECT role, content, reasoning, tool_calls, tool_result, attachments, created_at FROM messages WHERE session_key = ? ORDER BY id'
      : 'SELECT role, content, reasoning, tool_calls, tool_result, attachments, created_at FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?';
    const params: unknown[] = limit === undefined ? [sessionKey] : [sessionKey, limit];
    const rows = this.db.prepare(sql).all(...params) as MessageRecord[];
    const ordered = limit === undefined ? rows : rows.reverse();
    return ordered.map(toMessage);
  }

  appendMessages(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void {
    if (messages.length === 0) return;
    const run = this.db.transaction((items: readonly AgentMessage[]) => {
      this.insertRows(sessionKey, agentId, items);
    });
    run(messages);
  }

  replaceHistory(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void {
    const wipe = this.db.prepare('DELETE FROM messages WHERE session_key = ?');
    const run = this.db.transaction((items: readonly AgentMessage[]) => {
      wipe.run(sessionKey);
      if (items.length > 0) this.insertRows(sessionKey, agentId, items);
    });
    run(messages);
  }

  /**
   * 不带事务的批量插入。
   *
   * better-sqlite3 的 transaction 不支持嵌套，appendMessages 与 replaceHistory
   * 必须各自包一层事务、共用这段无事务的插入逻辑，否则 replaceHistory 会在
   * 运行时抛 "cannot start a transaction within a transaction"。
   */
  private insertRows(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO sessions (session_key, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at, agent_id = excluded.agent_id`,
    ).run(sessionKey, agentId, now, now);
    const insert = this.db.prepare(
      `INSERT INTO messages (session_key, agent_id, role, content, reasoning, tool_calls, tool_result, attachments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of messages) {
      insert.run(
        sessionKey,
        agentId,
        message.role,
        message.content,
        message.reasoning ?? null,
        message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
        message.toolResult === undefined ? null : JSON.stringify(message.toolResult),
        message.attachments === undefined ? null : JSON.stringify(message.attachments),
        message.createdAt ?? now,
      );
    }
  }

  clearSession(sessionKey: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_key = ?').run(sessionKey);
      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(sessionKey);
    });
    run();
  }

  beginTask(row: TaskRow): void {
    this.db.prepare(
      `INSERT INTO tasks (task_id, agent_id, session_key, status, started_at, finished_at, iterations,
        prompt_tokens, completion_tokens, total_tokens, model, title, error, trace_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET status = excluded.status`,
    ).run(
      row.taskId,
      row.agentId,
      row.sessionKey,
      row.status,
      row.startedAt,
      row.finishedAt ?? null,
      row.iterations,
      row.usage.promptTokens,
      row.usage.completionTokens,
      row.usage.totalTokens,
      row.model,
      row.title ?? null,
      row.error ?? null,
      row.tracePath ?? null,
    );
  }

  updateTask(taskId: string, patch: Partial<TaskRow>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(column + ' = ?');
      values.push(value);
    };
    if (patch.status !== undefined) put('status', patch.status);
    if (patch.finishedAt !== undefined) put('finished_at', patch.finishedAt);
    if (patch.iterations !== undefined) put('iterations', patch.iterations);
    if (patch.usage !== undefined) {
      put('prompt_tokens', patch.usage.promptTokens);
      put('completion_tokens', patch.usage.completionTokens);
      put('total_tokens', patch.usage.totalTokens);
    }
    if (patch.model !== undefined) put('model', patch.model);
    if (patch.title !== undefined) put('title', patch.title);
    if (patch.error !== undefined) put('error', patch.error);
    if (patch.tracePath !== undefined) put('trace_path', patch.tracePath);
    if (sets.length === 0) return;
    values.push(taskId);
    this.db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE task_id = ?').run(...values);
  }

  task(taskId: string): TaskRow | undefined {
    const record = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRecord | undefined;
    return record === undefined ? undefined : toTaskRow(record);
  }

  tasksBySession(sessionKey: string, status?: TaskStatus): TaskRow[] {
    const sql = status === undefined
      ? 'SELECT * FROM tasks WHERE session_key = ? ORDER BY started_at DESC'
      : 'SELECT * FROM tasks WHERE session_key = ? AND status = ? ORDER BY started_at DESC';
    const params: unknown[] = status === undefined ? [sessionKey] : [sessionKey, status];
    const rows = this.db.prepare(sql).all(...params) as TaskRecord[];
    return rows.map(toTaskRow);
  }

  runningTasks(): TaskRow[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at").all() as TaskRecord[];
    return rows.map(toTaskRow);
  }

  recordUsage(row: UsageRow): void {
    this.db.prepare(
      `INSERT INTO usage (at, day, agent_id, provider_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.at,
      usageDay(row.at),
      row.agentId,
      row.providerId,
      row.model,
      row.usage.promptTokens,
      row.usage.completionTokens,
      row.usage.totalTokens,
    );
  }

  usageSince(since: string): UsageAggregate[] {
    const rows = this.db.prepare(
      `SELECT agent_id, provider_id, model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(total_tokens) AS total_tokens,
         COUNT(*) AS calls
       FROM usage WHERE at >= ?
       GROUP BY agent_id, provider_id, model
       ORDER BY total_tokens DESC`,
    ).all(since) as UsageRecord[];
    return rows.map((record) => ({
      agentId: record.agent_id,
      providerId: record.provider_id,
      model: record.model,
      promptTokens: record.prompt_tokens,
      completionTokens: record.completion_tokens,
      totalTokens: record.total_tokens,
      calls: record.calls,
    }));
  }

  dailyTokens(agentId: string, day: string): number {
    const record = this.db.prepare(
      'SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage WHERE agent_id = ? AND day = ?',
    ).get(agentId, day) as { total: number } | undefined;
    return record?.total ?? 0;
  }

  prune(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const run = this.db.transaction(() => {
      const messages = this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff);
      this.db.prepare("DELETE FROM tasks WHERE started_at < ? AND status != 'running'").run(cutoff);
      this.db.prepare('DELETE FROM usage WHERE at < ?').run(cutoff);
      return messages.changes;
    });
    return run();
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 按智能体分发存储实例（FR-AGT-002）。
 *
 * 同一进程内同一 agentId 复用一个连接：better-sqlite3 的连接是有状态的，
 * 每次任务新开连接会在 WAL 下产生大量文件句柄。
 */
export class SessionStoreRegistry {
  private readonly stores = new Map<string, SqliteSessionStore>();
  private readonly resolveDir: (agentId: string) => string;

  constructor(resolveDir: (agentId: string) => string) {
    this.resolveDir = resolveDir;
  }

  /** 取（或创建）某智能体的会话库。 */
  store(agentId: string): SqliteSessionStore {
    const cached = this.stores.get(agentId);
    if (cached !== undefined) return cached;
    const created = new SqliteSessionStore(join(this.resolveDir(agentId), 'sessions.db'));
    this.stores.set(agentId, created);
    return created;
  }

  /** 已打开的智能体 id。 */
  get openIds(): string[] {
    return [...this.stores.keys()];
  }

  /** 跨全部指定智能体汇总用量（FR-TASK-007）。 */
  usageSince(since: string, agentIds: readonly string[]): UsageAggregate[] {
    const merged = new Map<string, UsageAggregate>();
    for (const agentId of agentIds) {
      for (const row of this.store(agentId).usageSince(since)) {
        const key = row.agentId + '\u0000' + row.providerId + '\u0000' + row.model;
        const existing = merged.get(key);
        if (existing === undefined) {
          merged.set(key, { ...row });
          continue;
        }
        existing.promptTokens += row.promptTokens;
        existing.completionTokens += row.completionTokens;
        existing.totalTokens += row.totalTokens;
        existing.calls += row.calls;
      }
    }
    return [...merged.values()].sort((left, right) => right.totalTokens - left.totalTokens);
  }

  /** 启动期把残留的 running 任务标记为中断（FR-TASK-008）。 */
  markInterrupted(agentIds: readonly string[]): TaskRow[] {
    const interrupted: TaskRow[] = [];
    const at = new Date().toISOString();
    for (const agentId of agentIds) {
      const store = this.store(agentId);
      for (const task of store.runningTasks()) {
        store.updateTask(task.taskId, {
          status: 'interrupted',
          finishedAt: at,
          error: '平台进程异常退出，任务被中断',
        });
        interrupted.push({ ...task, status: 'interrupted', finishedAt: at });
      }
    }
    return interrupted;
  }

  /** 清理过期数据，返回删除的消息条数。 */
  prune(retentionDays: number, agentIds: readonly string[]): number {
    let removed = 0;
    for (const agentId of agentIds) removed += this.store(agentId).prune(retentionDays);
    return removed;
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}

/** 内存存储，供测试与 --no-persist 模式使用。行为与 SQLite 版一致。 */
export class MemorySessionStore implements SessionStore {
  private readonly messages = new Map<string, AgentMessage[]>();
  private readonly tasks = new Map<string, TaskRow>();
  private readonly usageRows: UsageRow[] = [];

  history(sessionKey: string, limit?: number): AgentMessage[] {
    const all = this.messages.get(sessionKey) ?? [];
    return limit === undefined ? [...all] : all.slice(Math.max(all.length - limit, 0));
  }

  appendMessages(sessionKey: string, _agentId: string, messages: readonly AgentMessage[]): void {
    const all = this.messages.get(sessionKey) ?? [];
    all.push(...messages.map((message) => ({ ...message })));
    this.messages.set(sessionKey, all);
  }

  replaceHistory(sessionKey: string, _agentId: string, messages: readonly AgentMessage[]): void {
    this.messages.set(sessionKey, messages.map((message) => ({ ...message })));
  }

  clearSession(sessionKey: string): void {
    this.messages.delete(sessionKey);
  }

  beginTask(row: TaskRow): void {
    this.tasks.set(row.taskId, { ...row, usage: { ...row.usage } });
  }

  updateTask(taskId: string, patch: Partial<TaskRow>): void {
    const existing = this.tasks.get(taskId);
    if (existing === undefined) return;
    this.tasks.set(taskId, { ...existing, ...patch });
  }

  task(taskId: string): TaskRow | undefined {
    const found = this.tasks.get(taskId);
    return found === undefined ? undefined : { ...found };
  }

  tasksBySession(sessionKey: string, status?: TaskStatus): TaskRow[] {
    return [...this.tasks.values()]
      .filter((task) => task.sessionKey === sessionKey && (status === undefined || task.status === status))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((task) => ({ ...task }));
  }

  runningTasks(): TaskRow[] {
    return [...this.tasks.values()].filter((task) => task.status === 'running').map((task) => ({ ...task }));
  }

  recordUsage(row: UsageRow): void {
    this.usageRows.push({ ...row, usage: { ...row.usage } });
  }

  usageSince(since: string): UsageAggregate[] {
    const merged = new Map<string, UsageAggregate>();
    for (const row of this.usageRows) {
      if (row.at < since) continue;
      const key = row.agentId + '\u0000' + row.providerId + '\u0000' + row.model;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, {
          agentId: row.agentId,
          providerId: row.providerId,
          model: row.model,
          promptTokens: row.usage.promptTokens,
          completionTokens: row.usage.completionTokens,
          totalTokens: row.usage.totalTokens,
          calls: 1,
        });
        continue;
      }
      existing.promptTokens += row.usage.promptTokens;
      existing.completionTokens += row.usage.completionTokens;
      existing.totalTokens += row.usage.totalTokens;
      existing.calls += 1;
    }
    return [...merged.values()].sort((left, right) => right.totalTokens - left.totalTokens);
  }

  dailyTokens(agentId: string, day: string): number {
    let total = 0;
    for (const row of this.usageRows) {
      if (row.agentId === agentId && usageDay(row.at) === day) total += row.usage.totalTokens;
    }
    return total;
  }

  prune(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    let removed = 0;
    for (const [key, list] of this.messages) {
      const kept = list.filter((message) => (message.createdAt ?? cutoff) >= cutoff);
      removed += list.length - kept.length;
      if (kept.length === 0) this.messages.delete(key);
      else this.messages.set(key, kept);
    }
    return removed;
  }

  close(): void {
    this.messages.clear();
    this.tasks.clear();
    this.usageRows.length = 0;
  }
}

/** 空用量，供调用点省略字段时使用。 */
export function zeroUsage(): TokenUsage {
  return emptyUsage();
}
