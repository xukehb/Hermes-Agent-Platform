import { describe, expect, it } from 'vitest';
import { HookManager, type PreTaskPayload, type PostTaskPayload } from '../src/agent/hooks/hook-manager.js';

describe('HookManager Lifecycle & Interceptors', () => {
  it('registers in-memory hooks and triggers pre_task and post_task', async () => {
    const manager = HookManager.getInstance();
    const calls: string[] = [];

    const unreg1 = manager.registerHook<PreTaskPayload>('pre_task', async (payload) => {
      calls.push(`pre_task:${payload.taskId}`);
    });

    const unreg2 = manager.registerHook<PostTaskPayload>('post_task', async (payload) => {
      calls.push(`post_task:${payload.taskId}:${payload.status}`);
    });

    await manager.triggerPreTask({ taskId: 't1', agentId: 'coder', input: 'hello' });
    await manager.triggerPostTask({ taskId: 't1', agentId: 'coder', status: 'done', iterations: 2 });

    expect(calls).toContain('pre_task:t1');
    expect(calls).toContain('post_task:t1:done');

    unreg1();
    unreg2();
  });

  it('triggers pre_tool and blocks dangerous tool calls via sandbox', async () => {
    const manager = HookManager.getInstance();

    // 尝试越界写入
    const result = await manager.triggerPreTool({
      taskId: 't2',
      agentId: 'coder',
      toolName: 'write_file',
      params: { path: '/etc/shadow', content: 'hack' },
      workspace: '/Users/test/workspace',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('沙箱');
  });

  it('allows safe tool calls through pre_tool', async () => {
    const manager = HookManager.getInstance();

    const result = await manager.triggerPreTool({
      taskId: 't3',
      agentId: 'coder',
      toolName: 'read_file',
      params: { path: '/Users/test/workspace/src/app.ts' },
      workspace: '/Users/test/workspace',
    });

    expect(result.allowed).toBe(true);
  });
});
