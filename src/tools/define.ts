/**
 * 工具定义器：用 zod schema 同时产出「模型可读的 JSON Schema」与「本地参数校验」。
 *
 * 之所以不自研 JSON Schema 校验器，而是让 zod 同时承担两件事：
 * schema 是唯一事实源，z.toJSONSchema 负责对外，safeParse 负责对内，二者永不漂移。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { z } from 'zod';
import type { JsonSchema, ToolDefinition } from '../domain/index.js';
import type { ToolContext, ToolModule, ToolOutput, ToolValidation } from './types.js';

/** z.number().int() 会渲染出 ±2^53 的边界，对提示词毫无信息量，渲染前剔除。 */
const SAFE_INT_BOUND = 9007199254740991;

/** 把 zod schema 编译为工具声明用的 JSON Schema。 */
export function toolJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return cleanJsonSchema(raw) as JsonSchema;
}

/** 递归清理噪声键：$schema 与安全整数边界。 */
function cleanJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => cleanJsonSchema(item));
  if (typeof node !== 'object' || node === null) return node;
  const source = node as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema') continue;
    if ((key === 'minimum' || key === 'maximum') && typeof value === 'number' && Math.abs(value) === SAFE_INT_BOUND) continue;
    output[key] = cleanJsonSchema(value);
  }
  return output;
}

/** 用 zod schema 校验工具入参，失败时给出「路径: 原因」列表供回灌。 */
export function validateWithSchema(schema: z.ZodType, args: Record<string, unknown>): ToolValidation {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  const issues = parsed.error.issues.map((issue) => {
    const where = issue.path.map((segment) => String(segment)).join('.');
    return where.length > 0 ? where + ': ' + issue.message : issue.message;
  });
  return { ok: false, issues };
}

/** 工具定义入口。source 缺省为 builtin。 */
export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  source?: string;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput;
}): ToolModule & { run: (args: z.output<S>, ctx: ToolContext) => Promise<ToolOutput> } {
  const definition: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    parameters: toolJsonSchema(spec.schema),
    source: spec.source ?? 'builtin',
  };
  const runFn = async (args: Record<string, unknown>, ctx: ToolContext) => spec.run(args as z.output<S>, ctx);
  return {
    definition,
    validate: (args) => validateWithSchema(spec.schema, args),
    handler: runFn,
    run: runFn as (args: z.output<S>, ctx: ToolContext) => Promise<ToolOutput>,
  };
}
