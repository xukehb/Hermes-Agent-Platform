import { afterEach, describe, expect, it } from 'vitest';
import { ToolExecutor, ToolRegistry } from '../src/tools/index.js';
import { processManager } from '../src/tools/builtin/process-manager.js';
import type { ToolCall } from '../src/domain/index.js';
import type { ToolContext } from '../src/tools/index.js';
import type { ResolvedAgent, ResolvedPaths } from '../src/config/index.js';

function call(name: string, args: Record<string, unknown>, id = 'c-1'): ToolCall {
  return { id, name, args };
}

function makeHarness(agentId = 'process-agent') {
  const agent: ResolvedAgent = {
    id: agentId,
    name: agentId,
    description: '',
    workspace: process.cwd(),
    agentDir: '/tmp',
    model: { primary: 'mock/mock-model', fallbacks: [] },
    utilityModel: undefined,
    protocol: undefined,
    params: {},
    capabilities: ['code'],
    tools: { profile: 'coding', allow: [], deny: [] },
    subagentAllow: [],
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
    taskId: 'task-test-pm-' + Math.random().toString(36).slice(2, 8),
    depth: 0,
    signal: new AbortController().signal,
    env: {},
  };

  return { agent, ctx };
}

afterEach(() => {
  processManager.clear();
});

describe('后台长进程与常驻服务管理', () => {
  it('shell daemon 模式启动常驻进程并由 process_manager 管理完整生命周期', async () => {
    const harness = makeHarness();
    const executor = new ToolExecutor(ToolRegistry.builtin());

    // 1. 启动一个持续输出计数的 node 脚本
    const launchResult = await executor.execute(
      call('shell', {
        command: 'node -e "let count = 0; setInterval(() => { console.log(\'tick:\' + (++count)); }, 100);"',
        daemon: true,
      }),
      harness.ctx,
    );

    expect(launchResult.isError).toBe(false);
    expect(launchResult.content).toContain('后台常驻进程已启动');
    const idMatch = launchResult.content.match(/进程ID:\s*([^\s）)]+)/);
    expect(idMatch).toBeTruthy();
    const processId = idMatch![1]!;

    // 2. process_manager list 能够查看到该进程
    const listResult = await executor.execute(
      call('process_manager', {
        action: 'list',
      }),
      harness.ctx,
    );
    expect(listResult.isError).toBe(false);
    expect(listResult.content).toContain(processId);
    expect(listResult.content).toContain('running');

    // 3. 等待片刻，查看 status 与日志
    await new Promise((r) => setTimeout(r, 350));
    const statusResult = await executor.execute(
      call('process_manager', {
        action: 'status',
        process_id: processId,
      }),
      harness.ctx,
    );
    expect(statusResult.isError).toBe(false);
    expect(statusResult.content).toContain('【进程状态】');
    expect(statusResult.content).toContain('tick:');

    // 4. 发送终止信号
    const killResult = await executor.execute(
      call('process_manager', {
        action: 'kill',
        process_id: processId,
      }),
      harness.ctx,
    );
    expect(killResult.isError).toBe(false);
    expect(killResult.content).toContain('已向进程');

    // 5. 等待退出生效并再次检查状态
    await new Promise((r) => setTimeout(r, 100));
    const finalStatus = await executor.execute(
      call('process_manager', {
        action: 'status',
        process_id: processId,
      }),
      harness.ctx,
    );
    expect(finalStatus.content).not.toContain('状态: running');
  });

  it('支持向后台进程 stdin 发送交互输入', async () => {
    const harness = makeHarness();
    const executor = new ToolExecutor(ToolRegistry.builtin());

    // 启动等待 stdin 读取并回显的 node 脚本
    const launchResult = await executor.execute(
      call('shell', {
        command: 'node -e "process.stdin.on(\'data\', d => { console.log(\'ECHO:\' + d.toString().trim()); });"',
        daemon: true,
      }),
      harness.ctx,
    );

    const idMatch = launchResult.content.match(/进程ID:\s*([^\s）)]+)/);
    const processId = idMatch![1]!;

    // 向 stdin 写入消息
    const inputResult = await executor.execute(
      call('process_manager', {
        action: 'send_input',
        process_id: processId,
        input: 'hello_daemon_hap',
      }),
      harness.ctx,
    );
    expect(inputResult.isError).toBe(false);

    // 检查是否回显
    await new Promise((r) => setTimeout(r, 200));
    const statusResult = await executor.execute(
      call('process_manager', {
        action: 'status',
        process_id: processId,
      }),
      harness.ctx,
    );
    expect(statusResult.content).toContain('ECHO:hello_daemon_hap');
  });
});
