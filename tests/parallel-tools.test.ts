import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import { ToolExecutor, ToolRegistry } from '../src/tools/index.js';
import { ConfigResolver } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/index.js';
import { defineTool } from '../src/tools/define.js';
import { z } from 'zod';
import type { LoopRequest } from '../src/agent/types.js';

describe('AgentLoop Parallel Read-Only Tool Execution', () => {
  it('executes consecutive read-only tools concurrently and preserves output order', async () => {
    const executionTimestamps: Array<{ name: string; start: number; end: number }> = [];

    const toolA = defineTool({
      name: 'read_file',
      description: 'read file A',
      schema: z.object({ path: z.string() }),
      run: async (args) => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 60));
        const end = Date.now();
        executionTimestamps.push({ name: 'read_file_A', start, end });
        return { content: `content_of_${args.path}` };
      },
    });

    const toolB = defineTool({
      name: 'search',
      description: 'search B',
      schema: z.object({ query: z.string() }),
      run: async (args) => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 60));
        const end = Date.now();
        executionTimestamps.push({ name: 'search_B', start, end });
        return { content: `results_for_${args.query}` };
      },
    });

    const toolC = defineTool({
      name: 'write_file',
      description: 'mutating tool C',
      schema: z.object({ path: z.string(), content: z.string() }),
      run: async (args) => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 20));
        const end = Date.now();
        executionTimestamps.push({ name: 'write_file_C', start, end });
        return { content: `wrote_${args.path}` };
      },
    });

    const registry = new ToolRegistry();
    registry.register(toolA);
    registry.register(toolB);
    registry.register(toolC);

    const executor = new ToolExecutor(registry);

    const loop = new AgentLoop({
      resolver: {} as any,
      providers: {} as any,
      tools: registry,
    });

    const outcome = {
      text: 'reading files and then writing',
      reasoning: '',
      calls: [
        { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
        { id: 'call_2', name: 'search', args: { query: 'test' } },
        { id: 'call_3', name: 'write_file', args: { path: 'b.txt', content: 'hello' } },
      ],
      argErrors: new Map(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'tool_calls' as const,
      incomplete: [],
    };

    const request: LoopRequest = {
      agent: {
        id: 'test',
        name: 'test',
        providerId: 'p',
        model: 'm',
        tools: { allow: ['*'], deny: [], profile: 'all' },
        reasoningVisible: true,
        limits: {
          maxIterations: 10,
          compactThreshold: 1000,
          toolTimeoutMs: 10000,
          toolOutputMaxBytes: 50000,
        },
      } as any,
      paths: {
        dataDir: '/tmp',
        traceDir: '/tmp',
        overflowDir: '/tmp',
        spoolDir: '/tmp',
      },
      taskId: 'task_1',
      systemPrompt: 'sys',
      history: [],
      signal: new AbortController().signal,
      depth: 0,
      env: {},
    };

    const startTime = Date.now();
    const results = await (loop as any).runTools(request, executor, outcome, [
      toolA.definition,
      toolB.definition,
      toolC.definition,
    ]);
    const totalDuration = Date.now() - startTime;

    expect(results).toHaveLength(3);
    expect(results[0].content).toBe('content_of_a.txt');
    expect(results[1].content).toBe('results_for_test');
    expect(results[2].content).toBe('wrote_b.txt');

    // Concurrent execution of two 60ms tools takes ~60ms instead of 120ms
    expect(totalDuration).toBeLessThan(120);

    const a = executionTimestamps.find((x) => x.name === 'read_file_A')!;
    const b = executionTimestamps.find((x) => x.name === 'search_B')!;
    const c = executionTimestamps.find((x) => x.name === 'write_file_C')!;

    expect(a.start).toBeLessThan(b.end);
    expect(b.start).toBeLessThan(a.end);
    expect(c.start).toBeGreaterThanOrEqual(Math.min(a.end, b.end) - 10);
  });
});
