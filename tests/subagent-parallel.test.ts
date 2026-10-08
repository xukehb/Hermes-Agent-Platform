import { describe, expect, it } from 'vitest';
import { ToolExecutor, ToolRegistry } from '../src/tools/index.js';
import { createSubagentSpawner, getBackgroundSubagent, listBackgroundSubagents } from '../src/agent/subagent.js';
import { emptyUsage, type ToolCall } from '../src/domain/index.js';
import type { ToolContext } from '../src/tools/index.js';
import type { ResolvedAgent, ResolvedPaths } from '../src/config/index.js';

function call(name: string, args: Record<string, unknown>, id = 'c-1'): ToolCall {
  return { id, name, args };
}

function makeHarness(agentId = 'orchestrator-agent') {
  const agent: ResolvedAgent = {
    id: agentId,
    name: agentId,
    description: '',
    workspace: '/tmp',
    agentDir: '/tmp',
    model: { primary: 'mock/mock-model', fallbacks: [] },
    utilityModel: undefined,
    protocol: undefined,
    params: {},
    capabilities: ['code'],
    tools: { profile: 'full', allow: [], deny: [] },
    subagentAllow: ['researcher', 'reviewer', 'coder'],
    runtime: { mode: 'oneshot', idleTimeoutMs: 60000 },
    identity: { emoji: '🤖', displayName: agentId },
    systemPromptFile: undefined,
    reasoningVisible: false,
    limits: {
      maxIterations: 12,
      maxSubagentDepth: 3,
      toolTimeoutMs: 5000,
      toolOutputMaxBytes: 32000,
      compactThreshold: 0.75,
      dailyTokenBudget: 0,
      sessionRetentionDays: 30,
      ingressQueueSize: 100,
      providerConcurrency: {},
      providerRpm: {},
      agentConcurrency: {},
      agentRpm: {},
      defaultProviderConcurrency: 2,
      defaultAgentConcurrency: 1,
    },
  };

  const paths: ResolvedPaths = {
    dataDir: '/tmp',
    traceDir: '/tmp',
    overflowDir: '/tmp',
    spoolDir: '/tmp',
  };

  const ctx: ToolContext = {
    agent,
    paths,
    taskId: 'task-test-' + Math.random().toString(36).slice(2, 8),
    depth: 0,
    signal: new AbortController().signal,
    env: {},
  };

  return { agent, ctx };
}

describe('多智能体并发与后台派生', () => {
  it('支持 subagents 列表并发派发并聚合结果', async () => {
    const harness = makeHarness();
    const dispatched: string[] = [];
    harness.ctx.spawn = async (request) => {
      dispatched.push(request.agentId);
      await new Promise((r) => setTimeout(r, 10));
      return {
        text: `${request.agentId} 处理完毕：${request.task}`,
        taskId: `sub-${request.agentId}`,
      };
    };

    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(
      call('spawn_subagent', {
        subagents: [
          { agent: 'researcher', task: '检索文献' },
          { agent: 'reviewer', task: '审查架构' },
        ],
      }),
      harness.ctx,
    );

    expect(result.isError).toBe(false);
    expect(dispatched).toEqual(['researcher', 'reviewer']);
    expect(result.content).toContain('【多智能体并发执行结果（共 2 项）】');
    expect(result.content).toContain('researcher 的结论');
    expect(result.content).toContain('reviewer 的结论');
  });

  it('多智能体派发中若有不在白名单的智能体则直接拦截', async () => {
    const harness = makeHarness();
    harness.ctx.spawn = async () => ({ text: '不应调用' });
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(
      call('spawn_subagent', {
        subagents: [
          { agent: 'researcher', task: '合法任务' },
          { agent: 'unauthorized-agent', task: '非法任务' },
        ],
      }),
      harness.ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('SUBAGENT_FORBIDDEN');
    expect(result.content).toContain('unauthorized-agent 不在');
  });

  it('后台异步模式（mode: background）立即返回句柄并记录在后台注册表中', async () => {
    const harness = makeHarness();
    let runnerCalled = false;
    let finishTask: (() => void) | undefined;

    const mockRunner = {
      runTask: async () => {
        runnerCalled = true;
        await new Promise<void>((r) => {
          finishTask = r;
        });
        return {
          taskId: 'bg-done-1',
          agentId: 'researcher',
          sessionKey: 'sub:parent:researcher',
          status: 'done' as const,
          text: '后台任务已最终完成',
          reasoning: '',
          messages: [],
          usage: emptyUsage(),
          iterations: 1,
          model: 'model',
          protocol: 'hermes-native' as const,
          finishReason: 'stop' as const,
          stopReason: 'stop' as const,
          retranslations: 0,
          tracePath: '/tmp/trace.jsonl',
        };
      },
    };

    harness.ctx.spawn = createSubagentSpawner(mockRunner);
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(
      call('spawn_subagent', {
        agent: 'researcher',
        task: '后台长时索引计算',
        mode: 'background',
      }),
      harness.ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('后台启动执行');
    expect(result.content).toContain('bg-sub:');
    expect(runnerCalled).toBe(true);

    const activeList = listBackgroundSubagents(harness.ctx.taskId);
    expect(activeList.length).toBe(1);
    const bgTask = activeList[0]!;
    expect(bgTask.agentId).toBe('researcher');
    expect(bgTask.status).toBe('running');

    // 完成异步任务
    finishTask!();
    await new Promise((r) => setTimeout(r, 20));

    const updatedTask = getBackgroundSubagent(bgTask.subtaskId);
    expect(updatedTask?.status).toBe('done');
    expect(updatedTask?.outcome?.text).toBe('后台任务已最终完成');
  });
});
