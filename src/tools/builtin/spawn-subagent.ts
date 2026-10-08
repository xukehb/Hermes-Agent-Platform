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
import type { SubagentRequest } from '../types.js';

export const spawnSubagentTool = defineTool({
  name: 'spawn_subagent',
  description: '把一个明确、自包含的子任务交给指定子智能体执行，支持单任务同步/后台模式，及多智能体并发派发。',
  schema: z.object({
    agent: z.string().optional().describe('子智能体 id，必须在本智能体的 subagents_allow 白名单内（单任务模式）'),
    task: z.string().optional().describe('交给子智能体的完整任务描述，需自包含（单任务模式）'),
    context: z.string().optional().describe('可选的背景信息或已知结论'),
    mode: z.enum(['sync', 'background']).optional().default('sync').describe('执行模式：sync（同步等待，默认）或 background（后台异步）'),
    subagents: z.array(z.object({
      agent: z.string().min(1).describe('子智能体 id'),
      task: z.string().min(1).describe('子任务描述'),
      context: z.string().optional().describe('可选背景信息'),
    })).optional().describe('支持多智能体并发派发，传入数组并发执行'),
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

    const tasksToRun: Array<{ agent: string; task: string; context?: string | undefined }> = [];
    if (Array.isArray(args.subagents) && args.subagents.length > 0) {
      for (const s of args.subagents) {
        tasksToRun.push({ agent: s.agent, task: s.task, context: s.context });
      }
    } else if (args.agent && args.task) {
      tasksToRun.push({ agent: args.agent, task: args.task, context: args.context });
    } else {
      throw new RecoverableError(
        'SUBAGENT_FORBIDDEN',
        '必须指定目标 agent 和 task，或者提供 subagents 列表。',
      );
    }

    const allow = ctx.agent.subagentAllow ?? [];
    for (const item of tasksToRun) {
      if (!allow.includes(item.agent)) {
        const allowed = allow.length > 0 ? allow.join('、') : '（空）';
        throw new RecoverableError(
          'SUBAGENT_FORBIDDEN',
          '智能体 ' + item.agent + ' 不在 ' + ctx.agent.id + ' 的 subagents_allow 白名单内。可派生：' + allowed,
          { context: { requested: item.agent, allow: [...allow] } },
        );
      }
    }

    const isBackground = args.mode === 'background';

    // 并发派发执行所有子任务
    const outcomes = await Promise.all(
      tasksToRun.map(async (item) => {
        const req: SubagentRequest = {
          parentAgentId: ctx.agent.id,
          agentId: item.agent,
          task: item.task,
          depth: nextDepth,
          parentTaskId: ctx.taskId,
          signal: ctx.signal,
          context: item.context,
          background: isBackground,
        };
        const outcome = await spawn(req);
        return { agent: item.agent, outcome };
      }),
    );

    if (outcomes.length === 1 && outcomes[0]) {
      const { agent, outcome } = outcomes[0];
      const suffix = outcome.taskId === undefined ? '' : '（任务 ' + outcome.taskId + '）';
      return { content: '【' + agent + ' 的结论' + suffix + '】\n' + outcome.text };
    }

    // 多个并发结果格式化聚合
    const lines = [`【多智能体并发执行结果（共 ${outcomes.length} 项）】`];
    for (let i = 0; i < outcomes.length; i++) {
      const item = outcomes[i];
      if (!item) continue;
      const { agent, outcome } = item;
      const suffix = outcome.taskId === undefined ? '' : '（任务 ' + outcome.taskId + '）';
      lines.push(`\n### [${i + 1}] ${agent} 的结论${suffix}\n${outcome.text}`);
    }
    return { content: lines.join('\n') };
  },
});
