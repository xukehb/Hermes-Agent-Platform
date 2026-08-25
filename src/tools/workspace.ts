/**
 * 工作目录解析（FR-TOOL-004）。
 *
 * 所有文件类与命令类工具的相对路径一律以智能体的 workspace 为基准展开，
 * 绝对路径按用户意图直接使用——按硬约束，本平台不做任何越界拦截或沙箱化处理。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** 把工具入参里的路径解析为绝对路径。target 缺省时返回工作目录本身。 */
export function resolveInWorkspace(workspace: string, target?: string): string {
  const raw = target === undefined || target.trim() === '' ? '.' : target;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspace, raw);
}

/** 生成回灌给模型的可读路径：工作目录内用相对路径，目录外保留绝对路径。 */
export function displayPath(workspace: string, absolute: string): string {
  const relative = path.relative(workspace, absolute);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
}

/** 确保父目录存在，供 write_file / apply_patch 落盘。 */
export async function ensureParentDir(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
}
