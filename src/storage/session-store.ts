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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { usageTelemetryEventSchema, type UsageQuery, type UsageQueryResult, type UsageTelemetryEvent } from '../telemetry/index.js';

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

interface ColumnRecord {
  name: string;
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

function usageWhere(query: UsageQuery): { where: string; values: unknown[] } {
  const clauses = ['at >= ?'];
  const values: unknown[] = [query.since];
  if (query.until !== undefined) {
    clauses.push('at <= ?');
    values.push(query.until);
  }
  if (query.serverId !== undefined) {
    clauses.push('server_id = ?');
    values.push(query.serverId);
  }
  if (query.taskId !== undefined) {
    clauses.push('task_id = ?');
    values.push(query.taskId);
  }
  if (query.sessionKey !== undefined) {
    clauses.push('session_key = ?');
    values.push(query.sessionKey);
  }
  if (query.agentId !== undefined) {
    clauses.push('agent_id = ?');
    values.push(query.agentId);
  }
  return { where: 'WHERE ' + clauses.join(' AND '), values };
}

function aggregateUsageRows(rows: UsageRow[], field: 'agentId' | 'serverId'): Array<{ id: string; totalTokens: number; calls: number }> {
  const merged = new Map<string, { id: string; totalTokens: number; calls: number }>();
  for (const row of rows) {
    const id = field === 'serverId' ? row.serverId ?? 'unknown' : row.agentId;
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, { id, totalTokens: row.usage.totalTokens, calls: 1 });
    } else {
      existing.totalTokens += row.usage.totalTokens;
      existing.calls += 1;
    }
  }
  return [...merged.values()].sort((left, right) => right.totalTokens - left.totalTokens);
}

export class SqliteSessionStore implements SessionStore {
  readonly path: string;
  private readonly db?: Database.Database;
  private readonly fallback?: MemorySessionStore;

  constructor(path: string) {
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
      for (const statement of SCHEMA) this.db.exec(statement);
      this.migrateUsageColumns();
    } catch {
      this.fallback = new MemorySessionStore(path);
    }
  }

  private migrateUsageColumns(): void {
    const rows = this.db!.prepare('PRAGMA table_info(usage)').all() as ColumnRecord[];
    const columns = new Set(rows.map((row) => row.name));
    const add = (name: string, sql: string): void => {
      if (!columns.has(name)) this.db!.exec(sql);
    };
    add('event_id', 'ALTER TABLE usage ADD COLUMN event_id TEXT');
    add('task_id', 'ALTER TABLE usage ADD COLUMN task_id TEXT');
    add('session_key', 'ALTER TABLE usage ADD COLUMN session_key TEXT');
    add('server_id', "ALTER TABLE usage ADD COLUMN server_id TEXT NOT NULL DEFAULT 'unknown'");
    add('bot_account_id', 'ALTER TABLE usage ADD COLUMN bot_account_id TEXT');
    add('source', "ALTER TABLE usage ADD COLUMN source TEXT NOT NULL DEFAULT 'reconciliation'");
    add('parent_task_id', 'ALTER TABLE usage ADD COLUMN parent_task_id TEXT');
    this.db!.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event ON usage(event_id) WHERE event_id IS NOT NULL');
    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_usage_server_at ON usage(server_id, at)');
    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_usage_session_at ON usage(session_key, at)');
    this.db!.exec('CREATE INDEX IF NOT EXISTS idx_usage_task ON usage(task_id)');
  }

  history(sessionKey: string, limit?: number): AgentMessage[] {
    if (this.fallback) return this.fallback.history(sessionKey, limit);
    // 按 id 倒序取最近 limit 条再翻回正序：正序 LIMIT 会取到最早的消息
    const sql = limit === undefined
      ? 'SELECT role, content, reasoning, tool_calls, tool_result, attachments, created_at FROM messages WHERE session_key = ? ORDER BY id'
      : 'SELECT role, content, reasoning, tool_calls, tool_result, attachments, created_at FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?';
    const params: unknown[] = limit === undefined ? [sessionKey] : [sessionKey, limit];
    const rows = this.db!.prepare(sql).all(...params) as MessageRecord[];
    const ordered = limit === undefined ? rows : rows.reverse();
    return ordered.map(toMessage);
  }

  appendMessages(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void {
    if (this.fallback) return this.fallback.appendMessages(sessionKey, agentId, messages);
    if (messages.length === 0) return;
    const run = this.db!.transaction((items: readonly AgentMessage[]) => {
      this.insertRows(sessionKey, agentId, items);
    });
    run(messages);
  }

  replaceHistory(sessionKey: string, agentId: string, messages: readonly AgentMessage[]): void {
    if (this.fallback) return this.fallback.replaceHistory(sessionKey, agentId, messages);
    const wipe = this.db!.prepare('DELETE FROM messages WHERE session_key = ?');
    const run = this.db!.transaction((items: readonly AgentMessage[]) => {
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
    this.db!.prepare(
      `INSERT INTO sessions (session_key, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at, agent_id = excluded.agent_id`,
    ).run(sessionKey, agentId, now, now);
    const insert = this.db!.prepare(
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
    if (this.fallback) return this.fallback.clearSession(sessionKey);
    const run = this.db!.transaction(() => {
      this.db!.prepare('DELETE FROM messages WHERE session_key = ?').run(sessionKey);
      this.db!.prepare('DELETE FROM sessions WHERE session_key = ?').run(sessionKey);
    });
    run();
  }

  beginTask(row: TaskRow): void {
    if (this.fallback) return this.fallback.beginTask(row);
    this.db!.prepare(
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
    if (this.fallback) return this.fallback.updateTask(taskId, patch);
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
    this.db!.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE task_id = ?').run(...values);
  }

  task(taskId: string): TaskRow | undefined {
    if (this.fallback) return this.fallback.task(taskId);
    const record = this.db!.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRecord | undefined;
    return record === undefined ? undefined : toTaskRow(record);
  }

  tasksBySession(sessionKey: string, status?: TaskStatus): TaskRow[] {
    if (this.fallback) return this.fallback.tasksBySession(sessionKey, status);
    const sql = status === undefined
      ? 'SELECT * FROM tasks WHERE session_key = ? ORDER BY started_at DESC'
      : 'SELECT * FROM tasks WHERE session_key = ? AND status = ? ORDER BY started_at DESC';
    const params: unknown[] = status === undefined ? [sessionKey] : [sessionKey, status];
    const rows = this.db!.prepare(sql).all(...params) as TaskRecord[];
    return rows.map(toTaskRow);
  }

  runningTasks(): TaskRow[] {
    if (this.fallback) return this.fallback.runningTasks();
    const rows = this.db!.prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at").all() as TaskRecord[];
    return rows.map(toTaskRow);
  }

  recordUsage(row: UsageRow): void {
    if (this.fallback) return this.fallback.recordUsage(row);
    this.db!.prepare(
      `INSERT INTO usage (at, day, agent_id, provider_id, model, prompt_tokens, completion_tokens, total_tokens, server_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'reconciliation')`,
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

  recordUsageEvent(event: UsageTelemetryEvent): boolean {
    if (this.fallback) return this.fallback.recordUsageEvent(event);
    const value = usageTelemetryEventSchema.parse(event);
    const info = this.db!.prepare(
      `INSERT OR IGNORE INTO usage
        (event_id, at, day, agent_id, provider_id, model, prompt_tokens, completion_tokens, total_tokens,
         task_id, session_key, server_id, bot_account_id, source, parent_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.eventId,
      value.at,
      usageDay(value.at),
      value.agentId,
      value.providerId,
      value.model,
      value.promptTokens,
      value.completionTokens,
      value.totalTokens,
      value.taskId,
      value.sessionKey,
      value.serverId,
      value.botAccountId ?? null,
      value.source,
      value.parentTaskId ?? null,
    );
    return info.changes > 0;
  }

  queryUsage(query: UsageQuery): UsageQueryResult {
    if (this.fallback) return this.fallback.queryUsage(query);
    const { where, values } = usageWhere(query);
    const totals = this.db!.prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COUNT(*) AS calls
       FROM usage ${where}`,
    ).get(...values) as UsageQueryResult['totals'];
    const byAgent = this.db!.prepare(
      `SELECT agent_id AS agentId, COALESCE(SUM(total_tokens), 0) AS totalTokens, COUNT(*) AS calls
       FROM usage ${where} GROUP BY agent_id ORDER BY totalTokens DESC`,
    ).all(...values) as UsageQueryResult['byAgent'];
    const byServer = this.db!.prepare(
      `SELECT server_id AS serverId, COALESCE(SUM(total_tokens), 0) AS totalTokens, COUNT(*) AS calls
       FROM usage ${where} GROUP BY server_id ORDER BY totalTokens DESC`,
    ).all(...values) as UsageQueryResult['byServer'];
    return { totals, byAgent, byServer };
  }

  usageSince(since: string): UsageAggregate[] {
    if (this.fallback) return this.fallback.usageSince(since);
    const rows = this.db!.prepare(
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
    if (this.fallback) return this.fallback.dailyTokens(agentId, day);
    const record = this.db!.prepare(
      'SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage WHERE agent_id = ? AND day = ?',
    ).get(agentId, day) as { total: number } | undefined;
    return record?.total ?? 0;
  }

  prune(retentionDays: number): number {
    if (this.fallback) return this.fallback.prune(retentionDays);
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const run = this.db!.transaction(() => {
      const messages = this.db!.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
      this.db!.prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff);
      this.db!.prepare("DELETE FROM tasks WHERE started_at < ? AND status != 'running'").run(cutoff);
      this.db!.prepare('DELETE FROM usage WHERE at < ?').run(cutoff);
      return messages.changes;
    });
    return run();
  }

  close(): void {
    if (this.fallback) return this.fallback.close();
    this.db?.close();
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

/** 内存与文件回退存储，供测试与 --no-persist 模式或 ABI 回退使用。行为与 SQLite 版一致。 */
export class MemorySessionStore implements SessionStore {
  private readonly filePath: string | undefined;
  private readonly messages = new Map<string, AgentMessage[]>();
  private readonly tasks = new Map<string, TaskRow>();
  private readonly usageRows: UsageRow[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        if (!existsSync(filePath)) {
          writeFileSync(filePath, JSON.stringify({ messages: {}, tasks: {}, usageRows: [] }), 'utf8');
        } else {
          const raw = readFileSync(filePath, 'utf8');
          if (raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed.messages) {
              for (const [k, v] of Object.entries(parsed.messages)) {
                this.messages.set(k, v as AgentMessage[]);
              }
            }
            if (parsed.tasks) {
              for (const [k, v] of Object.entries(parsed.tasks)) {
                this.tasks.set(k, v as TaskRow);
              }
            }
            if (parsed.usageRows && Array.isArray(parsed.usageRows)) {
              this.usageRows.push(...(parsed.usageRows as UsageRow[]));
            }
          }
        }
      } catch {
        // 忽略文件错误，保持内存操作
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data = {
        messages: Object.fromEntries(this.messages),
        tasks: Object.fromEntries(this.tasks),
        usageRows: this.usageRows,
      };
      writeFileSync(this.filePath, JSON.stringify(data), 'utf8');
    } catch {
      // 忽略落盘异常
    }
  }

  history(sessionKey: string, limit?: number): AgentMessage[] {
    const all = this.messages.get(sessionKey) ?? [];
    return limit === undefined ? [...all] : all.slice(Math.max(all.length - limit, 0));
  }

  appendMessages(sessionKey: string, _agentId: string, messages: readonly AgentMessage[]): void {
    const all = this.messages.get(sessionKey) ?? [];
    all.push(...messages.map((message) => ({ ...message })));
    this.messages.set(sessionKey, all);
    this.save();
  }

  replaceHistory(sessionKey: string, _agentId: string, messages: readonly AgentMessage[]): void {
    this.messages.set(sessionKey, messages.map((message) => ({ ...message })));
    this.save();
  }

  clearSession(sessionKey: string): void {
    this.messages.delete(sessionKey);
    this.save();
  }

  beginTask(row: TaskRow): void {
    this.tasks.set(row.taskId, { ...row, usage: { ...row.usage } });
    this.save();
  }

  updateTask(taskId: string, patch: Partial<TaskRow>): void {
    const existing = this.tasks.get(taskId);
    if (existing === undefined) return;
    this.tasks.set(taskId, { ...existing, ...patch });
    this.save();
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
    this.save();
  }

  recordUsageEvent(event: UsageTelemetryEvent): boolean {
    if (this.usageRows.some((row) => row.eventId === event.eventId)) return false;
    const row: UsageRow = {
      at: event.at,
      agentId: event.agentId,
      providerId: event.providerId,
      model: event.model,
      usage: {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
      },
      eventId: event.eventId,
      taskId: event.taskId,
      sessionKey: event.sessionKey,
      serverId: event.serverId,
      source: event.source,
    };
    if (event.botAccountId !== undefined) row.botAccountId = event.botAccountId;
    if (event.parentTaskId !== undefined) row.parentTaskId = event.parentTaskId;
    this.usageRows.push(row);
    this.save();
    return true;
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

  queryUsage(query: UsageQuery): UsageQueryResult {
    const rows = this.usageRows.filter((row) => {
      if (row.at < query.since) return false;
      if (query.until !== undefined && row.at > query.until) return false;
      if (query.serverId !== undefined && row.serverId !== query.serverId) return false;
      if (query.taskId !== undefined && row.taskId !== query.taskId) return false;
      if (query.sessionKey !== undefined && row.sessionKey !== query.sessionKey) return false;
      if (query.agentId !== undefined && row.agentId !== query.agentId) return false;
      return true;
    });
    const totals = rows.reduce((acc, row) => {
      acc.promptTokens += row.usage.promptTokens;
      acc.completionTokens += row.usage.completionTokens;
      acc.totalTokens += row.usage.totalTokens;
      acc.calls += 1;
      return acc;
    }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 });
    return {
      totals,
      byAgent: aggregateUsageRows(rows, 'agentId').map((row) => ({ agentId: row.id, totalTokens: row.totalTokens, calls: row.calls })),
      byServer: aggregateUsageRows(rows, 'serverId').map((row) => ({ serverId: row.id, totalTokens: row.totalTokens, calls: row.calls })),
    };
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
    this.save();
    return removed;
  }

  close(): void {
    this.save();
    this.messages.clear();
    this.tasks.clear();
    this.usageRows.length = 0;
  }
}

/** 空用量，供调用点省略字段时使用。 */
export function zeroUsage(): TokenUsage {
  return emptyUsage();
}
