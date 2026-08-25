/**
 * shell 工具：在智能体工作目录内执行命令（FR-TOOL-001/004）。
 *
 * 直接复用 execa，不自研进程封装：它已处理跨平台 shell 选择、编码、
 * cancelSignal 终止与 timeout，且 reject: false 让非零退出码走正常回灌路径而非异常路径。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { execa } from 'execa';
import { z } from 'zod';
import { defineTool } from '../define.js';
import { resolveInWorkspace } from '../workspace.js';

/** execa 的返回类型随选项条件推导，此处按需读取字段，避免与其条件类型缠斗。 */
interface ExecaLike {
  exitCode?: number | undefined;
  all?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  failed?: boolean;
  timedOut?: boolean;
  isCanceled?: boolean;
  isTerminated?: boolean;
  signal?: string | undefined;
  message?: string;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
  return '';
}

export const shellTool = defineTool({
  name: 'shell',
  description: '在智能体工作目录内执行 shell 命令，返回合并后的 stdout/stderr 与退出码。适合运行构建、测试、git 等命令。',
  schema: z.object({
    command: z.string().min(1).describe('完整命令行，例如 npm test 或 git status --short'),
    cwd: z.string().optional().describe('相对工作目录的子目录，缺省为工作目录本身'),
    timeout_ms: z.number().positive().optional().describe('单命令超时，缺省受 limits.tool_timeout_ms 约束'),
  }),
  run: async (args, ctx) => {
    const cwd = resolveInWorkspace(ctx.agent.workspace, args.cwd);
    const options: {
      shell: boolean;
      cwd: string;
      all: boolean;
      reject: boolean;
      cancelSignal: AbortSignal;
      encoding: 'utf8';
      timeout?: number;
    } = { shell: true, cwd, all: true, reject: false, cancelSignal: ctx.signal, encoding: 'utf8' };
    if (args.timeout_ms !== undefined) options.timeout = args.timeout_ms;

    const startedAt = Date.now();
    const result = (await execa(args.command, options)) as unknown as ExecaLike;
    const elapsed = Date.now() - startedAt;

    const merged = textOf(result.all) || [textOf(result.stdout), textOf(result.stderr)].filter((part) => part !== '').join('\n');
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
    const notes: string[] = ['退出码 ' + exitCode, '耗时 ' + (elapsed / 1000).toFixed(1) + 's'];
    if (result.timedOut === true) notes.push('已超时终止');
    if (result.signal !== undefined && result.signal !== null) notes.push('信号 ' + result.signal);

    const header = '$ ' + args.command + '\n（' + notes.join('，') + '）';
    const body = merged.trim() === '' ? '（无输出）' : merged;
    return { content: header + '\n' + body, isError: exitCode !== 0 };
  },
});
