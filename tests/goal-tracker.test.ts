import { describe, expect, it, beforeEach } from 'vitest';
import { GoalTracker } from '../src/agent/goal-tracker.js';
import {
  goalTrackerTool,
  getTracker,
  getOrCreateTracker,
  clearTracker,
} from '../src/tools/builtin/goal-tracker-tool.js';
import { BUILTIN_TOOL_NAMES, TOOL_PROFILES } from '../src/config/defaults.js';

describe('GoalTracker 目标追踪器与状态机', () => {
  const taskId = 'test-task-1001';

  beforeEach(() => {
    clearTracker(taskId);
  });

  it('已注册为内置工具并包含在 automator 与 full 档位', () => {
    expect(BUILTIN_TOOL_NAMES).toContain('goal_tracker');
    expect(TOOL_PROFILES.full).toContain('goal_tracker');
    expect(TOOL_PROFILES.standard).toContain('goal_tracker');
  });

  it('能够初始化目标与里程碑，首个里程碑默认为 in_progress', () => {
    const tracker = new GoalTracker('完成系统重构与自动化测试', '详细规划');
    const plan = tracker.setMilestones([
      { id: 'm1', title: '完成代码模块重构' },
      { id: 'm2', title: '编写自动化测试用例' },
    ]);

    expect(plan.title).toBe('完成系统重构与自动化测试');
    expect(plan.description).toBe('详细规划');
    expect(plan.milestones.length).toBe(2);
    expect(plan.status).toBe('in_progress');
    expect(plan.milestones[0]?.id).toBe('m1');
    expect(plan.milestones[0]?.status).toBe('in_progress');
    expect(plan.milestones[1]?.status).toBe('pending');
  });

  it('能够跃迁里程碑状态并动态重算进度百分比', () => {
    const tracker = new GoalTracker('端到端测试');
    tracker.setMilestones([
      { id: 'm1', title: '任务一' },
      { id: 'm2', title: '任务二' },
    ]);

    // m1 completed 后，m2 应该自动流转为 in_progress
    tracker.updateMilestone('m1', 'completed', '已通过单元测试');
    let plan = tracker.getPlan();
    expect(plan.milestones[0]?.status).toBe('completed');
    expect(plan.milestones[0]?.result).toBe('已通过单元测试');
    expect(plan.milestones[1]?.status).toBe('in_progress');
    // completed (1) + in_progress (1 * 0.4) = 1.4 / 2 = 70%
    expect(plan.progress).toBe(70);

    tracker.updateMilestone('m2', 'completed', '全部通过');
    plan = tracker.getPlan();
    expect(plan.progress).toBe(100);
    expect(plan.status).toBe('completed');
  });

  it('里程碑失败时支持 fail 方法将目标状态标记为 failed', () => {
    const tracker = new GoalTracker('构建发布');
    tracker.setMilestones([
      { id: 'm1', title: '编译构建' },
      { id: 'm2', title: '推流上线' },
    ]);

    tracker.updateMilestone('m1', 'failed', '编译错误');
    tracker.fail('编译未通过导致终止');
    const plan = tracker.getPlan();
    expect(plan.status).toBe('failed');
    expect(plan.milestones[0]?.status).toBe('failed');
    expect(plan.summary).toContain('未达成：编译未通过导致终止');
  });

  it('支持 addLog 追加执行记录与自省', () => {
    const tracker = new GoalTracker('全流程执行');
    tracker.setMilestones([{ id: 'm1', title: '步骤1' }]);
    tracker.addLog('已探索浏览器 DOM 树，找到了按钮位置', 'm1');

    const plan = tracker.getPlan();
    const lastLog = plan.logs[plan.logs.length - 1];
    expect(lastLog?.note).toContain('找到了按钮位置');
    expect(lastLog?.milestoneId).toBe('m1');
  });

  it('complete 显式闭环完成目标', () => {
    const tracker = new GoalTracker('目标');
    tracker.setMilestones([{ id: 'm1', title: '步骤1' }]);
    tracker.complete('所有要求已圆满达成');

    const plan = tracker.getPlan();
    expect(plan.status).toBe('completed');
    expect(plan.progress).toBe(100);
    expect(plan.summary).toBe('所有要求已圆满达成');
  });

  it('toMarkdown 渲染优雅的 Markdown 进度展示卡片', () => {
    const tracker = new GoalTracker('演示目标');
    tracker.setMilestones([
      { id: 'm1', title: '准备就绪' },
      { id: 'm2', title: '正在执行' },
      { id: 'm3', title: '尚未开始' },
    ]);
    tracker.updateMilestone('m1', 'completed');

    const md = tracker.toMarkdown();
    expect(md).toContain('### 🎯 目标执行状态：演示目标');
    expect(md).toContain('里程碑规划与达成情况');
    expect(md).toContain('✅ `m1` 准备就绪');
    expect(md).toContain('🔄 `m2` **正在执行** *(当前执行)*');
    expect(md).toContain('⏳ `m3` 尚未开始');
  });

  it('全局单例池 getOrCreateTracker 与 clearTracker 正常工作', () => {
    const t1 = getOrCreateTracker(taskId, '初始标题');
    expect(getTracker(taskId)).toBe(t1);
    clearTracker(taskId);
    expect(getTracker(taskId)).toBeUndefined();
  });
});

describe('goal_tracker 工具执行器', () => {
  const dummyCtx: any = {
    taskId: 'tool-test-task',
    agent: { id: 'primary' },
    stepIndex: 1,
    workingDirectory: process.cwd(),
    environment: {},
    abortSignal: new AbortController().signal,
  };

  beforeEach(() => {
    clearTracker('tool-test-task');
  });

  it('调用 init_plan 能够初始化计划并返回看板', async () => {
    const res = await goalTrackerTool.run(
      {
        action: 'init_plan',
        title: '爬取网页最新数据',
        milestones: [
          { id: 'step1', title: '启动浏览器并打开页面' },
          { id: 'step2', title: '提取列表并保存' },
        ],
      },
      dummyCtx,
    );

    expect(res.isError).toBe(false);
    expect(res.content).toContain('目标规划已初始化');
    expect(res.content).toContain('爬取网页最新数据');
    expect(res.content).toContain('启动浏览器并打开页面');
  });

  it('调用 update_milestone 更新里程碑状态', async () => {
    await goalTrackerTool.run(
      {
        action: 'init_plan',
        title: '自动化操作',
        milestones: [{ id: 'm1', title: '步骤1' }],
      },
      dummyCtx,
    );

    const res = await goalTrackerTool.run(
      {
        action: 'update_milestone',
        milestoneId: 'm1',
        status: 'completed',
        result: '成功完成',
      },
      dummyCtx,
    );

    expect(res.isError).toBe(false);
    expect(res.content).toContain('里程碑状态已更新');
  });

  it('遇到缺少 milestones 或未知 action 时正确拦截', async () => {
    const res = await goalTrackerTool.run(
      { action: 'init_plan' },
      dummyCtx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('必须提供至少 1 个 milestones');
  });
});
