/**
 * apply_patch 工具：以信封补丁批量增删改文件（FR-TOOL-001/004）。
 *
 * 解析与文本应用逻辑在 patch-envelope.ts 中保持纯函数，本文件只负责文件系统落地。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { RecoverableError, describeError } from '../../domain/index.js';
import { defineTool } from '../define.js';
import { displayPath, ensureParentDir, resolveInWorkspace } from '../workspace.js';
import { applyHunks, parsePatch } from './patch-envelope.js';

const DESCRIPTION = [
  '以补丁信封批量修改文件，是多文件编辑的首选工具。格式：',
  '*** Begin Patch',
  '*** Add File: 相对路径',
  '+新文件的每一行都以 + 开头',
  '*** Update File: 相对路径',
  '@@ 可选的定位标记（如所在函数签名）',
  ' 保持不变的上下文行以空格开头',
  '-要删除的行',
  '+要新增的行',
  '*** Delete File: 相对路径',
  '*** End Patch',
  '要求：上下文行必须与文件当前内容逐字一致；不使用行号；同一补丁可包含多个文件。',
].join('\n');

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: DESCRIPTION,
  schema: z.object({
    patch: z.string().min(1).describe('完整补丁文本，含 Begin/End Patch 包裹'),
  }),
  run: async (args, ctx) => {
    const operations = parsePatch(args.patch);
    const summary: string[] = [];

    for (const operation of operations) {
      const target = resolveInWorkspace(ctx.agent.workspace, operation.path);
      const label = displayPath(ctx.agent.workspace, target);
      if (operation.kind === 'add') {
        if (await exists(target)) {
          throw new RecoverableError('TOOL_FAILED', '新增失败：' + label + ' 已存在，请改用 Update File 区块。', {
            context: { path: label },
          });
        }
        const body = operation.content === '' ? '' : operation.content + '\n';
        try {
          await ensureParentDir(target);
          await writeFile(target, body, 'utf8');
        } catch (error) {
          throw new RecoverableError('TOOL_FAILED', '新增失败：' + label + ' —— ' + describeError(error));
        }
        summary.push('A ' + label + '（' + operation.content.split('\n').length + ' 行）');
        continue;
      }
      if (operation.kind === 'delete') {
        try {
          await unlink(target);
        } catch (error) {
          throw new RecoverableError('TOOL_FAILED', '删除失败：' + label + ' —— ' + describeError(error));
        }
        summary.push('D ' + label);
        continue;
      }

      let original: string;
      try {
        original = await readFile(target, 'utf8');
      } catch (error) {
        throw new RecoverableError('TOOL_FAILED', '更新失败：无法读取 ' + label + ' —— ' + describeError(error));
      }
      const applied = applyHunks(original, operation.hunks, label);
      try {
        await writeFile(target, applied.text, 'utf8');
      } catch (error) {
        throw new RecoverableError('TOOL_FAILED', '更新失败：无法写回 ' + label + ' —— ' + describeError(error));
      }
      if (operation.moveTo !== undefined && operation.moveTo !== '') {
        const moved = resolveInWorkspace(ctx.agent.workspace, operation.moveTo);
        try {
          await ensureParentDir(moved);
          await rename(target, moved);
        } catch (error) {
          throw new RecoverableError('TOOL_FAILED', '移动失败：' + label + ' —— ' + describeError(error));
        }
        summary.push('M ' + label + ' → ' + displayPath(ctx.agent.workspace, moved) + '（+' + applied.stats.added + ' -' + applied.stats.removed + '）');
        continue;
      }
      summary.push('M ' + label + '（+' + applied.stats.added + ' -' + applied.stats.removed + '）');
    }

    return { content: '补丁已应用：\n' + summary.join('\n') };
  },
});
