// TypeScript 7（原生移植版编译器）可用性验证（执行者：Codex，日期：2026-08-24）
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** 智能体配置 schema：同时提供编译期类型与运行期校验 */
const AgentConfig = z.object({
  model: z.string(),
  tools: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().default(24),
});

/** 由 schema 推导出的类型，无需手写 interface */
type AgentConfig = z.infer<typeof AgentConfig>;

export function openSessionStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, agent TEXT NOT NULL)');
  return db;
}

export function parseAgent(raw: unknown): AgentConfig {
  return AgentConfig.parse(raw);
}
