/**
 * 子智能体派生器（FR-ROUTE-007/008/009）。
 *
 * 三道闸门的分工：
 * - 「未注入 spawn」「深度超限」「不在 subagentAllow」三个前置判断在
 *   builtin/spawn-subagent.ts 里完成，那里能把拒绝理由直接回灌给模型（工具错误），
 *   模型可以据此改用别的做法，比抛异常终止任务更有用。
 * - 本文件负责闸门放行之后的事：用独立会话键跑一次完整任务，把正文与用量交回。
 *
 * 会话键约定 sub:<父任务id>:<子智能体id>：
 * 子智能体不共享父会话历史（否则父的长历史会挤爆子的上下文，而且子智能体
 * 通常有不同的 system 提示），但同一父任务多次派生同一子智能体时会话可累积，
 * 这样「先让 researcher 查 A，再让它查 B」时第二次能看到第一次的结论。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { SubagentOutcome, SubagentRequest, SubagentSpawner } from '../tools/index.js';
import type { RunTaskRequest, TaskOutcome } from './types.js';

/** 派生一次子任务所需的最小运行能力，由编排器提供。 */
export interface SubagentRunner {
  runTask(request: RunTaskRequest): Promise<TaskOutcome>;
}

/** 拼接子智能体的会话键。 */
export function subagentSessionKey(parentTaskId: string, agentId: string): string {
  return 'sub:' + parentTaskId + ':' + agentId;
}

/**
 * 把子智能体的任务与上下文拼成一段输入。
 *
 * 上下文放在任务前面并用小标题分隔：子智能体的 system 提示里没有父任务的信息，
 * 若不显式给出背景，它只能凭 task 一句话工作，往往会重复父智能体已做过的探查。
 */
export function composeSubagentInput(task: string, context?: string): string {
  if (context === undefined || context.trim() === '') return task;
  return '## 背景\n' + context.trim() + '\n\n## 任务\n' + task;
}

/**
 * 构造派生器。
 *
 * 子任务的 depth 由调用方（spawn-subagent 工具）算好并传入，本函数原样下传，
 * 循环内部会再把它塞进 ToolContext，于是深度约束沿派生链自然传递。
 */
export function createSubagentSpawner(runner: SubagentRunner): SubagentSpawner {
  return async (request: SubagentRequest): Promise<SubagentOutcome> => {
    const runRequest: RunTaskRequest = {
      agentId: request.agentId,
      input: composeSubagentInput(request.task, request.context),
      sessionKey: subagentSessionKey(request.parentTaskId, request.agentId),
      depth: request.depth,
      signal: request.signal,
    };
    const outcome = await runner.runTask(runRequest);

    // 子任务失败不抛异常：把失败原因当作文本交回父智能体，
    // 父智能体可以改写任务重派或自己干，这比整条父任务一起失败更有用。
    const text = outcome.status === 'done'
      ? outcome.text
      : '子智能体 ' + request.agentId + ' 未能完成任务（状态：' + outcome.status + '）。'
        + (outcome.error === undefined ? '' : '原因：' + outcome.error)
        + (outcome.text === '' ? '' : '\n已产生的中间结论：\n' + outcome.text);

    const result: SubagentOutcome = { text };
    if (outcome.taskId !== undefined) result.taskId = outcome.taskId;
    if (outcome.usage !== undefined) result.usage = outcome.usage;
    return result;
  };
}
