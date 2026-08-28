/**
 * open_external 工具：在用户操作系统中打开本地文件、目录或 URL 网页。
 */

import { execa } from 'execa';
import { z } from 'zod';
import { defineTool } from '../define.js';
import { resolveInWorkspace } from '../workspace.js';

export const openExternalTool = defineTool({
  name: 'open_external',
  description: '在用户的操作系统中打开本地文件、目录或 URL 网页（例如在系统默认浏览器中打开 HTML 网页预览、在资源管理器中定位文件、或唤起系统默认程序）。',
  schema: z.object({
    target: z.string().min(1).describe('要打开的目标：可以是 http/https 网址、本地文件路径或目录路径（支持绝对路径或相对于工作区目录的相对路径）'),
    app: z.string().optional().describe('可选：指定打开程序名称（例如 chrome、msedge、code、notepad、explorer 等）'),
  }),
  run: async (args, ctx) => {
    let target = args.target.trim();
    const isUrl = /^https?:\/\//i.test(target) || /^file:\/\//i.test(target);
    if (!isUrl) {
      target = resolveInWorkspace(ctx.agent.workspace, target);
    }

    try {
      if (process.platform === 'win32') {
        if (args.app) {
          await execa('cmd', ['/c', 'start', '', args.app, target], { shell: true });
        } else {
          await execa('cmd', ['/c', 'start', '', target], { shell: true });
        }
      } else if (process.platform === 'darwin') {
        const cmdArgs = args.app ? ['-a', args.app, target] : [target];
        await execa('open', cmdArgs);
      } else {
        await execa('xdg-open', [target]);
      }
      return { content: '✅ 已成功在本地操作系统中打开目标：' + target, isError: false };
    } catch (error) {
      return { content: '✗ 无法打开目标：' + (error instanceof Error ? error.message : String(error)), isError: true };
    }
  },
});
