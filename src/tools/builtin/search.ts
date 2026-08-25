/**
 * search 工具：工作目录内的内容检索（FR-TOOL-001/004）。
 *
 * 优先复用 ripgrep（生态标准，速度与忽略规则都无需自研）；
 * 仅在 rg 不可用时退化为 Node 遍历，保证功能不因环境缺失而缺项。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { RecoverableError, describeError } from '../../domain/index.js';
import { defineTool } from '../define.js';
import { displayPath, resolveInWorkspace } from '../workspace.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next', 'target', 'coverage']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface SearchArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  literal?: boolean;
  max_results?: number;
}

/** 扁平化 glob 匹配：把 ** 视同 *，逐段推进，避免为此再引入正则转义。 */
function matchesGlob(pattern: string, name: string): boolean {
  const parts = pattern.split('*').filter((part, index, all) => !(part === '' && index > 0 && index < all.length - 1));
  if (parts.length === 1) return pattern === name;
  const first = parts[0] ?? '';
  if (!name.startsWith(first)) return false;
  let index = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i] ?? '';
    if (part === '') continue;
    const found = name.indexOf(part, index);
    if (found < 0) return false;
    index = found + part.length;
  }
  const last = parts[parts.length - 1] ?? '';
  if (last === '') return true;
  return name.endsWith(last) && name.length - last.length >= index;
}

function buildRgArgs(args: SearchArgs): string[] {
  const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '400', '--sort', 'path'];
  if (args.ignore_case === true) rgArgs.push('--ignore-case');
  if (args.literal === true) rgArgs.push('--fixed-strings');
  if (args.glob !== undefined && args.glob !== '') rgArgs.push('--glob', args.glob);
  rgArgs.push('--', args.pattern, '.');
  return rgArgs;
}

interface RgOutcome {
  ok: boolean;
  lines: string[];
  message: string;
}

async function runRipgrep(args: SearchArgs, cwd: string, signal: AbortSignal): Promise<RgOutcome | undefined> {
  let result: { exitCode?: number | undefined; all?: unknown; stderr?: unknown };
  try {
    result = (await execa('rg', buildRgArgs(args), {
      cwd,
      all: true,
      reject: false,
      cancelSignal: signal,
      encoding: 'utf8',
    })) as unknown as { exitCode?: number | undefined; all?: unknown; stderr?: unknown };
  } catch {
    return undefined;
  }
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
  if (exitCode === 127 || exitCode === -1) return undefined;
  const raw = typeof result.all === 'string' ? result.all : '';
  if (exitCode === 0) {
    return { ok: true, lines: raw.split('\n').filter((line) => line.trim() !== ''), message: '' };
  }
  if (exitCode === 1) return { ok: true, lines: [], message: '' };
  const stderr = typeof result.stderr === 'string' ? result.stderr : raw;
  return { ok: false, lines: [], message: stderr.trim() };
}

async function walkFiles(dir: string, root: string, glob: string | undefined, out: string[], budget: { files: number }): Promise<void> {
  if (budget.files <= 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.files <= 0) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(path.join(dir, entry.name), root, glob, out, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    if (glob !== undefined && glob !== '') {
      const subject = glob.includes('/') ? path.relative(root, full).split(path.sep).join('/') : entry.name;
      if (!matchesGlob(glob, subject)) continue;
    }
    out.push(full);
    budget.files -= 1;
  }
}

async function searchWithNode(args: SearchArgs, root: string, maxResults: number): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(root, root, args.glob, files, { files: 5000 });
  const ignoreCase = args.ignore_case === true;
  const needle = ignoreCase ? args.pattern.toLowerCase() : args.pattern;
  let regex: RegExp | undefined;
  if (args.literal !== true) {
    try {
      regex = new RegExp(args.pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      throw new RecoverableError('TOOL_INVALID_ARGS', '正则表达式无效：' + describeError(error));
    }
  }
  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= maxResults) break;
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      const raw = await readFile(file, 'utf8');
      if (raw.includes('\u0000')) continue;
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (hits.length >= maxResults) break;
        const line = lines[i] ?? '';
        const matched = regex !== undefined ? regex.test(line) : (ignoreCase ? line.toLowerCase().includes(needle) : line.includes(needle));
        if (matched) {
          const relative = path.relative(root, file).split(path.sep).join('/');
          hits.push(relative + ':' + (i + 1) + ':' + line.slice(0, 400));
        }
      }
    } catch {
      continue;
    }
  }
  return hits;
}

export const searchTool = defineTool({
  name: 'search',
  description: '在智能体工作目录内按正则或字面量检索文件内容，输出 文件:行号:内容。自动跳过 node_modules、.git 等目录。',
  schema: z.object({
    pattern: z.string().min(1).describe('正则表达式，literal 为 true 时按字面量匹配'),
    path: z.string().optional().describe('检索起点，缺省为工作目录'),
    glob: z.string().optional().describe('文件名过滤，如 *.ts 或 src/**/*.py'),
    ignore_case: z.boolean().optional().describe('忽略大小写'),
    literal: z.boolean().optional().describe('按字面量而非正则匹配'),
    max_results: z.number().int().positive().max(2000).optional().describe('最多返回的匹配行数，缺省 200'),
  }),
  run: async (args, ctx) => {
    const root = resolveInWorkspace(ctx.agent.workspace, args.path);
    const maxResults = args.max_results ?? 200;
    const query: SearchArgs = { pattern: args.pattern };
    if (args.path !== undefined) query.path = args.path;
    if (args.glob !== undefined) query.glob = args.glob;
    if (args.ignore_case !== undefined) query.ignore_case = args.ignore_case;
    if (args.literal !== undefined) query.literal = args.literal;

    const viaRg = await runRipgrep(query, root, ctx.signal);
    let lines: string[];
    let engine: string;
    if (viaRg === undefined) {
      lines = await searchWithNode(query, root, maxResults);
      engine = 'node 遍历（未检测到 rg）';
    } else if (!viaRg.ok) {
      throw new RecoverableError('TOOL_FAILED', 'ripgrep 执行失败：' + viaRg.message);
    } else {
      lines = viaRg.lines;
      engine = 'ripgrep';
    }

    const total = lines.length;
    const clipped = lines.slice(0, maxResults);
    const header = '检索 ' + displayPath(ctx.agent.workspace, root) + ' — ' + engine + '，命中 ' + total + ' 行' +
      (total > clipped.length ? '（仅显示前 ' + clipped.length + ' 行）' : '');
    if (clipped.length === 0) return { content: header + '\n未找到匹配项。' };
    return { content: header + '\n' + clipped.join('\n') };
  },
});
