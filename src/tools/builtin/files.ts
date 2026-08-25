/**
 * 文件类内置工具：read_file / write_file / list_dir（FR-TOOL-001/004）。
 *
 * 路径一律经 resolveInWorkspace 展开；失败时抛 RecoverableError，
 * 由 ToolExecutor 转成 isError 结果回灌模型（FR-LOOP-009）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RecoverableError, describeError } from '../../domain/index.js';
import { defineTool } from '../define.js';
import { displayPath, ensureParentDir, resolveInWorkspace } from '../workspace.js';

/** 目录遍历默认跳过的重型目录，避免 list_dir 输出被依赖树淹没。 */
const HEAVY_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next', 'target']);

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fsFailure(action: string, target: string, error: unknown): RecoverableError {
  return new RecoverableError('TOOL_FAILED', action + ' 失败：' + target + ' —— ' + describeError(error), {
    context: { target },
  });
}

export const readFileTool = defineTool({
  name: 'read_file',
  description: '读取文本文件内容。可用 start_line 与 line_count 只取片段，适合大文件定位。',
  schema: z.object({
    path: z.string().min(1).describe('文件路径，相对路径以智能体工作目录为基准'),
    start_line: z.number().int().positive().optional().describe('起始行号，从 1 开始'),
    line_count: z.number().int().positive().optional().describe('读取行数，缺省 400'),
  }),
  run: async (args, ctx) => {
    const target = resolveInWorkspace(ctx.agent.workspace, args.path);
    let raw: string;
    try {
      raw = await readFile(target, 'utf8');
    } catch (error) {
      throw fsFailure('读取文件', displayPath(ctx.agent.workspace, target), error);
    }
    if (args.start_line === undefined && args.line_count === undefined) {
      return { content: raw === '' ? '（文件为空）' : raw };
    }
    const lines = raw.split('\n');
    const start = args.start_line ?? 1;
    const count = args.line_count ?? 400;
    const slice = lines.slice(start - 1, start - 1 + count);
    if (slice.length === 0) {
      return { content: displayPath(ctx.agent.workspace, target) + ' 共 ' + lines.length + ' 行，第 ' + start + ' 行起无内容。' };
    }
    const header = displayPath(ctx.agent.workspace, target) + ' 第 ' + start + '-' + (start + slice.length - 1) + ' 行（共 ' + lines.length + ' 行）';
    return { content: header + '\n' + slice.join('\n') };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
  description: '写入文本文件，默认整体覆盖并自动创建父目录；append 为 true 时追加。',
  schema: z.object({
    path: z.string().min(1).describe('文件路径，相对路径以智能体工作目录为基准'),
    content: z.string().describe('要写入的完整文本'),
    append: z.boolean().optional().describe('true 表示追加而非覆盖'),
  }),
  run: async (args, ctx) => {
    const target = resolveInWorkspace(ctx.agent.workspace, args.path);
    try {
      await ensureParentDir(target);
      if (args.append === true) {
        await appendFile(target, args.content, 'utf8');
      } else {
        await writeFile(target, args.content, 'utf8');
      }
    } catch (error) {
      throw fsFailure('写入文件', displayPath(ctx.agent.workspace, target), error);
    }
    const bytes = Buffer.byteLength(args.content, 'utf8');
    const mode = args.append === true ? '追加' : '覆盖';
    return { content: '已' + mode + '写入 ' + displayPath(ctx.agent.workspace, target) + '（' + sizeLabel(bytes) + '）' };
  },
});

interface WalkState {
  lines: string[];
  remaining: number;
  skipped: string[];
}

/** 深度优先遍历目录，目录优先、同类按名称排序，命中容量上限即停。 */
async function walkDir(dir: string, depth: number, maxDepth: number, includeHidden: boolean, state: WalkState): Promise<void> {
  if (state.remaining <= 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    state.lines.push('  '.repeat(depth) + '（无法读取：' + describeError(error) + '）');
    return;
  }
  const sorted = entries.slice().sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    if (state.remaining <= 0) return;
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && HEAVY_DIRS.has(entry.name)) {
      if (!state.skipped.includes(entry.name)) state.skipped.push(entry.name);
      continue;
    }
    const indent = '  '.repeat(depth);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      state.lines.push(indent + entry.name + '/');
      state.remaining -= 1;
      if (depth + 1 < maxDepth) await walkDir(full, depth + 1, maxDepth, includeHidden, state);
    } else {
      let label = entry.name;
      try {
        const info = await stat(full);
        label = entry.name + '  ' + sizeLabel(info.size);
      } catch {
        label = entry.name;
      }
      state.lines.push(indent + label);
      state.remaining -= 1;
    }
  }
}

export const listDirTool = defineTool({
  name: 'list_dir',
  description: '列出目录树。默认深度 2，自动跳过 node_modules、.git 等重型目录。',
  schema: z.object({
    path: z.string().optional().describe('目录路径，缺省为智能体工作目录'),
    depth: z.number().int().positive().max(8).optional().describe('递归深度，缺省 2'),
    include_hidden: z.boolean().optional().describe('true 表示包含点开头的隐藏项'),
    max_entries: z.number().int().positive().max(2000).optional().describe('最多列出的条目数，缺省 400'),
  }),
  run: async (args, ctx) => {
    const target = resolveInWorkspace(ctx.agent.workspace, args.path);
    const maxEntries = args.max_entries ?? 400;
    const state: WalkState = { lines: [], remaining: maxEntries, skipped: [] };
    await walkDir(target, 0, args.depth ?? 2, args.include_hidden === true, state);
    const notes: string[] = [];
    if (state.remaining <= 0) notes.push('已达 ' + maxEntries + ' 条上限，输出被截断');
    if (state.skipped.length > 0) notes.push('已跳过 ' + state.skipped.join('、'));
    const header = displayPath(ctx.agent.workspace, target) + (notes.length > 0 ? '（' + notes.join('；') + '）' : '');
    const body = state.lines.length > 0 ? state.lines.join('\n') : '（空目录）';
    return { content: header + '\n' + body };
  },
});
