/**
 * goal_tracker 工具：供智能体在目标模式下显式推进规划与里程碑状态。
 */

import { z } from 'zod';
import { defineTool } from '../define.js';
import { GoalTracker, type MilestoneStatus } from '../../agent/goal-tracker.js';

// 单会话全局 GoalTracker 存储映射表
const activeTrackers = new Map<string, GoalTracker>();

export function getOrCreateTracker(sessionKey: string, initialTitle = '自主目标任务'): GoalTracker {
  let tracker = activeTrackers.get(sessionKey);
  if (!tracker) {
    tracker = new GoalTracker(initialTitle);
    activeTrackers.set(sessionKey, tracker);
  }
  return tracker;
}

export function getTracker(sessionKey: string): GoalTracker | undefined {
  return activeTrackers.get(sessionKey);
}

export function clearTracker(sessionKey: string): void {
  activeTrackers.delete(sessionKey);
}

export const goalTrackerSchema = z.object({
  action: z.enum(['init_plan', 'update_milestone', 'record_progress', 'complete_goal']).describe(
    '操作动作：init_plan(初始化分解里程碑清单) / update_milestone(更新某个里程碑状态) / record_progress(记录思考与阶段进展) / complete_goal(宣布目标彻底达成)'
  ),
  title: z.string().optional().describe('总目标标题（用于 init_plan）'),
  milestones: z.array(z.object({
    id: z.string().optional().describe('里程碑编号，如 m-1, m-2'),
    title: z.string().describe('里程碑简短标题，例如：定位问题根因、编写单元测试'),
    description: z.string().optional().describe('详细步骤与验收标准'),
  })).optional().describe('里程碑规划清单（用于 init_plan）'),
  milestoneId: z.string().optional().describe('目标里程碑的 ID 或标题（用于 update_milestone）'),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional().describe(
    '里程碑的新状态：pending(待办) / in_progress(执行中) / completed(已完成) / failed(失败)'
  ),
  result: z.string().optional().describe('当前里程碑的交付成果或结论说明'),
  note: z.string().optional().describe('过程性思考或进展笔记（用于 record_progress）'),
  summary: z.string().optional().describe('总体验收总结与最终交付报告（用于 complete_goal）'),
});

export const goalTrackerTool = defineTool({
  name: 'goal_tracker',
  description: '【目标模式专用】维护与追踪长任务的里程碑规划、子任务执行状态、进度演进以及最终验收交付。在目标模式中，请在开始时拆解里程碑，并在每一步执行后及时调用本工具更新进度。',
  schema: goalTrackerSchema,
  run: (args, ctx) => {
    const sessionKey = ctx.taskId || ctx.agent.id || 'default-session';
    const tracker = getOrCreateTracker(sessionKey, args.title || '自主目标任务');

    switch (args.action) {
      case 'init_plan': {
        if (!args.milestones || args.milestones.length === 0) {
          return {
            content: '错误：init_plan 必须提供至少 1 个 milestones 里程碑项。',
            isError: true,
          };
        }
        tracker.setMilestones(args.milestones);
        return {
          content: '✅ 目标规划已初始化并生效：\n\n' + tracker.toMarkdown(),
          isError: false,
        };
      }

      case 'update_milestone': {
        if (!args.milestoneId || !args.status) {
          return {
            content: '错误：update_milestone 必须提供 milestoneId 和 status。',
            isError: true,
          };
        }
        try {
          tracker.updateMilestone(args.milestoneId, args.status as MilestoneStatus, args.result);
          return {
            content: '✅ 里程碑状态已更新：\n\n' + tracker.toMarkdown(),
            isError: false,
          };
        } catch (err) {
          return {
            content: '更新里程碑失败：' + (err instanceof Error ? err.message : String(err)),
            isError: true,
          };
        }
      }

      case 'record_progress': {
        if (!args.note) {
          return {
            content: '错误：record_progress 必须提供 note 进展说明。',
            isError: true,
          };
        }
        tracker.addLog(args.note, args.milestoneId);
        return {
          content: '📝 已记录阶段进展："' + args.note + '"\n\n' + tracker.toMarkdown(),
          isError: false,
        };
      }

      case 'complete_goal': {
        const summaryText = args.summary || args.result || '已顺利完成所有里程碑任务。';
        tracker.complete(summaryText);
        return {
          content: '🎉 恭喜！目标已圆满达成并验收完成：\n\n' + tracker.toMarkdown(),
          isError: false,
        };
      }
    }
  },
});
