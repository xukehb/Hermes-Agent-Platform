/**
 * spawn_subagent 工具：把子任务派给另一个智能体（FR-ROUTE-007~009）。
 *
 * 三道闸门按 §6 错误表回灌而非终止任务：
 * 未注入派生器、深度超限（SUBAGENT_DEPTH）、目标不在白名单（SUBAGENT_FORBIDDEN）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { z } from 'zod';
import { RecoverableError } from '../../domain/index.js';
import { defineTool } from '../define.js';

export const spawnSubagentTool = defineTool({
  name: 'spawn_subagent',
  description: '把一个明确、自包含的子任务交给指定子智能体执行，并返回它的结论。只能派给白名单内的智能体。',
  schema: z.object({
    agent: z.string().min(1).describe('子智能体 id，必须在本智能体的 subagents_allow 白名单内'),
    task: z.string().min(1).describe('交给子智能体的完整任务描述，需自包含'),
    context: z.string().optional().describe('可选的背景信息或已知结论'),
  }),
  run: async (args, ctx) => {
    const spawn = ctx.spawn;
    if (spawn === undefined) {
      throw new RecoverableError('SUBAGENT_FORBIDDEN', '当前运行环境未启用子智能体派生，请自行完成该子任务。');
    }
    const nextDepth = ctx.depth + 1;
    const maxDepth = ctx.agent.limits.maxSubagentDepth;
    if (nextDepth > maxDepth) {
      throw new RecoverableError(
        'SUBAGENT_DEPTH',
        '派生深度已达上限 ' + maxDepth + '（当前深度 ' + ctx.depth + '），请自行完成该子任务。',
        { context: { depth: ctx.depth, maxDepth } },
      );
    }
    const allow = ctx.agent.subagentAllow;
    if (!allow.includes(args.agent)) {
      const allowed = allow.length > 0 ? allow.join('、') : '（空）';
      throw new RecoverableError(
        'SUBAGENT_FORBIDDEN',
        '智能体 ' + args.agent + ' 不在 ' + ctx.agent.id + ' 的 subagents_allow 白名单内。可派生：' + allowed,
        { context: { requested: args.agent, allow: [...allow] } },
      );
    }

    const request: {
      parentAgentId: string;
      agentId: string;
      task: string;
      depth: number;
      parentTaskId: string;
      signal: AbortSignal;
      context?: string;
    } = {
      parentAgentId: ctx.agent.id,
      agentId: args.agent,
      task: args.task,
      depth: nextDepth,
      parentTaskId: ctx.taskId,
      signal: ctx.signal,
    };
    if (args.context !== undefined) request.context = args.context;

    const outcome = await spawn(request);
    const suffix = outcome.taskId === undefined ? '' : '（任务 ' + outcome.taskId + '）';
    return { content: '【' + args.agent + ' 的结论' + suffix + '】\n' + outcome.text };
  },
});
