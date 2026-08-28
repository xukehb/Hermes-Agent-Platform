/**
 * 工具层测试：定义器、裁剪、执行器、内置工具、注册表与 MCP 归一化。
 *
 * 文件类用例统一在系统临时目录里建独立工作区，测试结束整体删除，
 * 不污染仓库也不依赖网络（http_fetch 用例自起本地 http 服务）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseConfigText } from '../src/config/loader.js';
import type { ResolvedAgent, ResolvedLimits, ResolvedPaths } from '../src/config/resolved.js';
import { HapError } from '../src/domain/index.js';
import type { ToolCall, ToolDefinition, TraceEvent } from '../src/domain/index.js';
import {
  McpManager,
  ToolExecutor,
  ToolRegistry,
  applyHunks,
  defineTool,
  expandEnvRefs,
  matchesToolPattern,
  mcpContentText,
  parsePatch,
  resolveMcpServers,
  selectToolNames,
  toolJsonSchema,
  truncateToolOutput,
} from '../src/tools/index.js';
import type { ToolContext, ToolModule } from '../src/tools/index.js';

const ROOT = mkdtempSync(join(tmpdir(), 'hap-tools-test-'));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** 每个用例一个独立工作区，避免互相干扰。 */
function makeRoot(name: string): string {
  const root = join(ROOT, name);
  mkdirSync(join(root, 'ws'), { recursive: true });
  return root;
}

function makeLimits(): ResolvedLimits {
  return {
    maxIterations: 12,
    maxSubagentDepth: 2,
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
  };
}

function makePaths(root: string): ResolvedPaths {
  return {
    dataDir: join(root, 'data'),
    traceDir: join(root, 'data', 'traces'),
    overflowDir: join(root, 'data', 'overflow'),
    spoolDir: join(root, 'data', 'spool'),
  };
}

function makeAgent(root: string): ResolvedAgent {
  return {
    id: 'coder',
    name: 'coder',
    description: '测试用智能体',
    workspace: join(root, 'ws'),
    agentDir: join(root, 'state'),
    model: { primary: 'mock/mock-model', fallbacks: [] },
    utilityModel: undefined,
    protocol: undefined,
    params: {},
    capabilities: ['code'],
    tools: { profile: 'full', allow: [], deny: [] },
    subagentAllow: ['researcher'],
    runtime: { mode: 'oneshot', idleTimeoutMs: 60000 },
    identity: { emoji: '🤖', displayName: 'Coder' },
    systemPromptFile: undefined,
    reasoningVisible: false,
    limits: makeLimits(),
  };
}

interface Harness {
  root: string;
  agent: ResolvedAgent;
  paths: ResolvedPaths;
  ctx: ToolContext;
  traces: TraceEvent[];
  controller: AbortController;
}

function makeHarness(name: string): Harness {
  const root = makeRoot(name);
  const agent = makeAgent(root);
  const paths = makePaths(root);
  const controller = new AbortController();
  const traces: TraceEvent[] = [];
  const ctx: ToolContext = {
    agent,
    paths,
    taskId: 'task-' + name,
    signal: controller.signal,
    depth: 0,
    env: {},
    onTrace: (event) => traces.push(event),
  };
  return { root, agent, paths, ctx, traces, controller };
}

function call(name: string, args: Record<string, unknown>, id = 'call-1'): ToolCall {
  return { id, name, args };
}

function mcpDefinition(name: string, source: string): ToolDefinition {
  return { name, description: 'MCP 工具', parameters: { type: 'object', properties: {} }, source };
}

function mcpModule(name: string, source: string, originalName: string): ToolModule {
  return {
    definition: mcpDefinition(name, source),
    renamedFrom: originalName,
    handler: async () => ({ content: 'mcp-ok' }),
  };
}

describe('defineTool 与 JSON Schema 生成', () => {
  const demo = defineTool({
    name: 'demo',
    description: '演示工具',
    schema: z.object({
      text: z.string().min(1).describe('必填文本'),
      count: z.number().int().positive().optional().describe('可选次数'),
    }),
    source: 'test',
    run: async (args) => ({ content: args.text }),
  });

  it('生成的 schema 不含 $schema 且保留必填与描述', () => {
    const schema = demo.definition.parameters;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['text']);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.text?.description).toBe('必填文本');
  });

  it('剔除 z.number().int() 渲染出的安全整数边界', () => {
    const schema = toolJsonSchema(z.object({ n: z.number().int() }));
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.n?.maximum).toBeUndefined();
    expect(properties.n?.minimum).toBeUndefined();
    expect(properties.n?.type).toBe('integer');
  });

  it('校验失败时给出「路径: 原因」列表', () => {
    const validate = demo.validate;
    expect(validate).toBeDefined();
    if (validate === undefined) return;
    const outcome = validate({ count: -1 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.join(' | ')).toContain('text');
    expect(outcome.issues.join(' | ')).toContain('count');
  });
});

describe('工具输出裁剪与溢出落盘', () => {
  it('超过预算时保留首尾并写出完整文件', async () => {
    const root = makeRoot('overflow');
    const raw = 'A'.repeat(4000) + 'MIDDLE' + 'B'.repeat(4000);
    const result = await truncateToolOutput(raw, {
      maxBytes: 1000,
      overflowDir: join(root, 'overflow'),
      taskId: 'task/1',
      callId: 'call:1',
      toolName: 'shell',
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(1000);
    expect(result.content).toContain('已省略中间');
    expect(result.content.startsWith('AAA')).toBe(true);
    expect(result.content.endsWith('BBB')).toBe(true);
    const overflowPath = result.overflowPath;
    expect(overflowPath).toBeDefined();
    if (overflowPath === undefined) return;
    expect(readFileSync(overflowPath, 'utf8')).toBe(raw);
  });

  it('未超预算时原样返回且不落盘', async () => {
    const root = makeRoot('overflow-small');
    const result = await truncateToolOutput('短输出', {
      maxBytes: 32000,
      overflowDir: join(root, 'overflow'),
      taskId: 't',
      callId: 'c',
      toolName: 'shell',
    });
    expect(result).toEqual({ content: '短输出', truncated: false });
    expect(existsSync(join(root, 'overflow'))).toBe(false);
  });
});

describe('工具集裁剪', () => {
  const builtinDefs = ToolRegistry.builtin().definitions();
  const withMcp = [...builtinDefs, mcpDefinition('fs__read_text', 'fs'), mcpDefinition('fs__write_text', 'fs')];

  it('通配符只匹配 *', () => {
    expect(matchesToolPattern('fs__*', 'fs__read_text')).toBe(true);
    expect(matchesToolPattern('fs__*', 'other__read')).toBe(false);
    expect(matchesToolPattern('read_file', 'read_file')).toBe(true);
    expect(matchesToolPattern('read.file', 'read_file')).toBe(false);
  });

  it('allow 为空时取档位交集', () => {
    expect(selectToolNames({ profile: 'minimal', allow: [], deny: [] }, builtinDefs)).toEqual(['read_file', 'list_dir']);
  });

  it('MCP 工具在 allow 为空时自动纳入', () => {
    const names = selectToolNames({ profile: 'minimal', allow: [], deny: [] }, withMcp);
    expect(names).toEqual(['read_file', 'list_dir', 'fs__read_text', 'fs__write_text']);
  });

  it('allow 非空时完全以 allow 为准', () => {
    const names = selectToolNames({ profile: 'minimal', allow: ['shell', 'fs__*'], deny: [] }, withMcp);
    expect(names).toEqual(['shell', 'fs__read_text', 'fs__write_text']);
  });

  it('deny 优先于 allow 与档位', () => {
    const names = selectToolNames({ profile: 'full', allow: [], deny: ['http_fetch', 'spawn_*'] }, withMcp);
    expect(names).not.toContain('http_fetch');
    expect(names).not.toContain('spawn_subagent');
    expect(names).toContain('shell');
    const denied = selectToolNames({ profile: 'minimal', allow: ['fs__*'], deny: ['fs__write_text'] }, withMcp);
    expect(denied).toEqual(['fs__read_text']);
  });
});

describe('工具注册表', () => {
  it('内置工具齐备且顺序稳定', () => {
    expect(ToolRegistry.builtin().names()).toEqual([
      'shell',
      'open_external',
      'read_file',
      'write_file',
      'apply_patch',
      'list_dir',
      'search',
      'http_fetch',
      'spawn_subagent',
      'remote_exec',
      'remote_sysinfo',
      'remote_list_servers',
      'remote_upgrade_daemon',
      'find_definition',
      'find_references',
      'list_symbols',
      'host_sysinfo',
      'disk_cleanup',
      'ip_lookup',
      'generate_image',
    ]);
  });

  it('记录 MCP 前缀改名', () => {
    const registry = ToolRegistry.builtin();
    registry.register(mcpModule('fs__read_text', 'fs', 'read_text'));
    expect(registry.renames()).toEqual([
      { from: 'read_text', to: 'fs__read_text', source: 'fs', reason: 'mcp-namespace' },
    ]);
    expect(registry.has('fs__read_text')).toBe(true);
  });

  it('撞名时后来者改名并留痕', () => {
    const registry = ToolRegistry.builtin();
    const clash = defineTool({
      name: 'shell',
      description: '同名工具',
      schema: z.object({}),
      source: 'demo',
      run: async () => ({ content: 'x' }),
    });
    const stored = registry.register(clash);
    expect(stored.definition.name).toBe('demo__shell');
    expect(stored.renamedFrom).toBe('shell');
    expect(registry.renames()).toEqual([
      { from: 'shell', to: 'demo__shell', source: 'demo', reason: 'collision' },
    ]);
    const again = registry.register(clash);
    expect(again.definition.name).toBe('demo__shell_2');
    expect(registry.get('shell')?.definition.source).toBe('builtin');
  });

  it('按智能体裁剪声明', () => {
    const registry = ToolRegistry.builtin();
    const agent = makeAgent(makeRoot('registry-agent'));
    agent.tools = { profile: 'coding', allow: [], deny: ['spawn_subagent'] };
    const names = registry.definitionsFor(agent).map((definition) => definition.name);
    expect(names).toContain('shell');
    expect(names).toContain('apply_patch');
    expect(names).not.toContain('spawn_subagent');
    expect(names).not.toContain('http_fetch');
  });
});


describe('工具执行器', () => {
  it('未知工具以 isError 回灌并列出可用工具', async () => {
    const harness = makeHarness('exec-unknown');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('no_such_tool', {}), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到工具 no_such_tool');
    expect(result.content).toContain('read_file');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('被 deny 的工具等同于不存在', async () => {
    const harness = makeHarness('exec-denied');
    harness.agent.tools = { profile: 'full', allow: [], deny: ['shell'] };
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('shell', { command: 'echo hi' }), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到工具 shell');
  });

  it('参数不合法时回灌 issue 列表与 JSON Schema', async () => {
    const harness = makeHarness('exec-invalid');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('read_file', { path: 123 }), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数校验失败');
    expect(result.content).toContain('path');
    expect(result.content).toContain('JSON Schema');
    expect(result.content).toContain('start_line');
  });

  it('工具超时转为可回灌的错误结果', async () => {
    const harness = makeHarness('exec-timeout');
    const registry = ToolRegistry.builtin();
    registry.register(defineTool({
      name: 'sleepy',
      description: '故意不理 signal 的慢工具',
      schema: z.object({}),
      source: 'test',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { content: '不应看到' };
      },
    }));
    const executor = new ToolExecutor(registry, { timeoutMs: 20 });
    const result = await executor.execute(call('sleepy', {}), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('执行超时');
    expect(result.content).toContain('20ms');
  });

  it('任务取消时抛 TASK_ABORTED 而不是回灌', async () => {
    const harness = makeHarness('exec-abort');
    harness.controller.abort();
    const executor = new ToolExecutor(ToolRegistry.builtin());
    let code = '';
    try {
      await executor.execute(call('read_file', { path: 'a.txt' }), harness.ctx);
    } catch (error) {
      code = error instanceof HapError ? error.code : 'OTHER';
    }
    expect(code).toBe('TASK_ABORTED');
  });

  it('执行中抛出的可恢复错误带错误码回灌', async () => {
    const harness = makeHarness('exec-failure');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('read_file', { path: 'missing.txt' }), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('TOOL_FAILED');
    expect(result.content).toContain('读取文件');
  });

  it('超长输出裁剪并落 overflowPath，同时发出 trace', async () => {
    const harness = makeHarness('exec-truncate');
    harness.agent.limits.toolOutputMaxBytes = 600;
    const registry = ToolRegistry.builtin();
    registry.register(defineTool({
      name: 'noisy',
      description: '输出很长的工具',
      schema: z.object({}),
      source: 'test',
      run: async () => ({ content: 'X'.repeat(5000) }),
    }));
    const executor = new ToolExecutor(registry);
    const result = await executor.execute(call('noisy', {}, 'call-noisy'), harness.ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('已省略中间');
    const overflowPath = result.overflowPath;
    expect(overflowPath).toBeDefined();
    if (overflowPath !== undefined) expect(existsSync(overflowPath)).toBe(true);
    const event = harness.traces.at(-1);
    expect(event?.kind).toBe('tool');
    if (event !== undefined && event.kind === 'tool') {
      expect(event.name).toBe('noisy');
      expect(event.truncated).toBe(true);
      expect(event.isError).toBe(false);
      expect(event.argsDigest).toBe('');
    }
  });

  it('executeAll 按顺序执行并保留 callId', async () => {
    const harness = makeHarness('exec-all');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const results = await executor.executeAll([
      call('write_file', { path: 'a.txt', content: 'first' }, 'c1'),
      call('read_file', { path: 'a.txt' }, 'c2'),
    ], harness.ctx);
    expect(results.map((item) => item.callId)).toEqual(['c1', 'c2']);
    expect(results[1]?.content).toBe('first');
  });
});

describe('内置文件工具', () => {
  it('write_file / read_file / list_dir 走通', async () => {
    const harness = makeHarness('files');
    const executor = new ToolExecutor(ToolRegistry.builtin());

    const written = await executor.execute(call('write_file', { path: 'src/a.txt', content: '第一行\n第二行\n第三行' }), harness.ctx);
    expect(written.isError).toBe(false);
    expect(written.content).toContain('已覆盖写入 src/a.txt');

    const appended = await executor.execute(call('write_file', { path: 'src/a.txt', content: '\n第四行', append: true }), harness.ctx);
    expect(appended.content).toContain('已追加写入');

    const whole = await executor.execute(call('read_file', { path: 'src/a.txt' }), harness.ctx);
    expect(whole.content).toBe('第一行\n第二行\n第三行\n第四行');

    const slice = await executor.execute(call('read_file', { path: 'src/a.txt', start_line: 2, line_count: 2 }), harness.ctx);
    expect(slice.content).toContain('src/a.txt 第 2-3 行（共 4 行）');
    expect(slice.content).toContain('第二行');
    expect(slice.content).not.toContain('第一行');

    const listed = await executor.execute(call('list_dir', {}), harness.ctx);
    expect(listed.content).toContain('src/');
    expect(listed.content).toContain('a.txt');
  });

  it('list_dir 跳过重型目录并标注', async () => {
    const harness = makeHarness('files-heavy');
    mkdirSync(join(harness.agent.workspace, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(harness.agent.workspace, 'keep.txt'), 'k', 'utf8');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const listed = await executor.execute(call('list_dir', {}), harness.ctx);
    expect(listed.content).toContain('已跳过 node_modules');
    expect(listed.content).toContain('keep.txt');
  });
});

describe('search 工具', () => {
  it('命中与未命中都返回非异常结果', async () => {
    const harness = makeHarness('search');
    writeFileSync(join(harness.agent.workspace, 'one.ts'), 'export const needle = 1;\n', 'utf8');
    writeFileSync(join(harness.agent.workspace, 'two.md'), '没有目标\n', 'utf8');
    const executor = new ToolExecutor(ToolRegistry.builtin());

    const hit = await executor.execute(call('search', { pattern: 'needle' }), harness.ctx);
    expect(hit.isError).toBe(false);
    expect(hit.content).toContain('needle');
    expect(hit.content).toContain('one.ts');

    const miss = await executor.execute(call('search', { pattern: 'zzz_not_here_zzz' }), harness.ctx);
    expect(miss.isError).toBe(false);
    expect(miss.content).toContain('未找到');

    const scoped = await executor.execute(call('search', { pattern: 'needle', glob: '*.md' }), harness.ctx);
    expect(scoped.content).toContain('未找到');
  });
});

describe('apply_patch 信封', () => {
  it('解析新增、更新、删除与移动', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+hello',
      '*** Update File: old.txt',
      '*** Move to: moved.txt',
      '@@ marker',
      ' keep',
      '-drop',
      '+insert',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n');
    const operations = parsePatch(patch);
    expect(operations).toHaveLength(3);
    expect(operations[0]).toEqual({ kind: 'add', path: 'new.txt', content: 'hello' });
    const update = operations[1];
    expect(update?.kind).toBe('update');
    if (update !== undefined && update.kind === 'update') {
      expect(update.moveTo).toBe('moved.txt');
      expect(update.hunks[0]?.marker).toBe('marker');
      expect(update.hunks[0]?.lines).toEqual([
        { op: ' ', text: 'keep' },
        { op: '-', text: 'drop' },
        { op: '+', text: 'insert' },
      ]);
    }
    expect(operations[2]).toEqual({ kind: 'delete', path: 'gone.txt' });
  });

  it('缺少结尾标记时报参数错误', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Add File: a.txt\n+x\n')).toThrow(/End Patch/);
  });

  it('applyHunks 按上下文定位并统计增删', () => {
    const original = ['line1', 'target', 'line3'].join('\n');
    const applied = applyHunks(original, [{ marker: '', lines: [
      { op: ' ', text: 'line1' },
      { op: '-', text: 'target' },
      { op: '+', text: 'replaced' },
    ] }], 'demo.txt');
    expect(applied.text).toBe(['line1', 'replaced', 'line3'].join('\n'));
    expect(applied.stats).toEqual({ added: 1, removed: 1 });
  });

  it('上下文失配时提示先读文件', () => {
    expect(() => applyHunks('a\nb', [{ marker: '', lines: [{ op: '-', text: 'nope' }] }], 'demo.txt'))
      .toThrow(/未找到上下文/);
  });

  it('端到端：增改删同一补丁内完成', async () => {
    const harness = makeHarness('patch-e2e');
    writeFileSync(join(harness.agent.workspace, 'old.txt'), 'keep\ndrop\n', 'utf8');
    writeFileSync(join(harness.agent.workspace, 'gone.txt'), 'bye\n', 'utf8');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const patch = [
      '*** Begin Patch',
      '*** Add File: created.txt',
      '+brand new',
      '*** Update File: old.txt',
      '@@',
      ' keep',
      '-drop',
      '+kept',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n');
    const result = await executor.execute(call('apply_patch', { patch }), harness.ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('A created.txt');
    expect(result.content).toContain('M old.txt（+1 -1）');
    expect(result.content).toContain('D gone.txt');
    expect(readFileSync(join(harness.agent.workspace, 'created.txt'), 'utf8')).toBe('brand new\n');
    expect(readFileSync(join(harness.agent.workspace, 'old.txt'), 'utf8')).toContain('kept');
    expect(existsSync(join(harness.agent.workspace, 'gone.txt'))).toBe(false);
  });

  it('新增已存在的文件时提示改用 Update File', async () => {
    const harness = makeHarness('patch-exists');
    writeFileSync(join(harness.agent.workspace, 'dup.txt'), 'x', 'utf8');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(
      call('apply_patch', { patch: '*** Begin Patch\n*** Add File: dup.txt\n+y\n*** End Patch\n' }),
      harness.ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('已存在');
    expect(result.content).toContain('Update File');
  });
});

describe('shell 与 http_fetch', () => {
  it('shell 回灌退出码与合并输出', async () => {
    const harness = makeHarness('shell');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const ok = await executor.execute(call('shell', { command: 'node -e "console.log(1+1)"' }), harness.ctx);
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain('退出码 0');
    expect(ok.content).toContain('2');

    const bad = await executor.execute(call('shell', { command: 'node -e "process.exit(3)"' }), harness.ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('退出码 3');
  });

  it('http_fetch 抓取本地服务并按状态判定错误', async () => {
    const harness = makeHarness('http');
    const server = createServer((request, response) => {
      if (request.url === '/miss') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('pong');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = 'http://127.0.0.1:' + port;
    try {
      const executor = new ToolExecutor(ToolRegistry.builtin());
      const ok = await executor.execute(call('http_fetch', { url: base + '/ping' }), harness.ctx);
      expect(ok.isError).toBe(false);
      expect(ok.content).toContain('pong');
      const miss = await executor.execute(call('http_fetch', { url: base + '/miss' }), harness.ctx);
      expect(miss.isError).toBe(true);
      expect(miss.content).toContain('404');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('spawn_subagent 三道闸门', () => {
  it('未注入派生器时回灌 SUBAGENT_FORBIDDEN', async () => {
    const harness = makeHarness('spawn-none');
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('spawn_subagent', { agent: 'researcher', task: 't' }), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('SUBAGENT_FORBIDDEN');
    expect(result.content).toContain('未启用子智能体派生');
  });

  it('深度超限时回灌 SUBAGENT_DEPTH', async () => {
    const harness = makeHarness('spawn-depth');
    harness.ctx.spawn = async () => ({ text: '不应调用' });
    harness.ctx.depth = harness.agent.limits.maxSubagentDepth;
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('spawn_subagent', { agent: 'researcher', task: 't' }), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('SUBAGENT_DEPTH');
  });

  it('目标不在白名单时回灌 SUBAGENT_FORBIDDEN', async () => {
    const harness = makeHarness('spawn-allow');
    harness.ctx.spawn = async () => ({ text: '不应调用' });
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(call('spawn_subagent', { agent: 'writer', task: 't' }), harness.ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('白名单');
    expect(result.content).toContain('researcher');
  });

  it('放行时把结论带任务号回灌', async () => {
    const harness = makeHarness('spawn-ok');
    harness.ctx.spawn = async (request) => {
      expect(request.parentAgentId).toBe('coder');
      expect(request.depth).toBe(1);
      expect(request.context).toBe('背景');
      return { text: '子任务结论', taskId: 'sub-1' };
    };
    const executor = new ToolExecutor(ToolRegistry.builtin());
    const result = await executor.execute(
      call('spawn_subagent', { agent: 'researcher', task: '调研', context: '背景' }),
      harness.ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe('【researcher 的结论（任务 sub-1）】\n子任务结论');
  });
});

describe('MCP 归一化', () => {
  const config = parseConfigText([
    '[mcp_servers.fs]',
    'command = "node"',
    'args = ["server.js"]',
    'startup_timeout_ms = 5000',
    'env = { TOKEN = "$DEMO_TOKEN" }',
    '',
    '[mcp_servers.off]',
    'command = "node"',
    'enabled = false',
  ].join('\n'), 'memory.toml');

  it('归一化服务器声明并保留 enabled 标记', () => {
    const specs = resolveMcpServers(config);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      id: 'fs',
      command: 'node',
      args: ['server.js'],
      startupTimeoutMs: 5000,
      enabled: true,
    });
    expect(specs[0]?.env).toEqual({ TOKEN: '$DEMO_TOKEN' });
    expect(specs[1]?.enabled).toBe(false);
  });

  it('McpManager 只接管启用的服务器', () => {
    const manager = new McpManager(resolveMcpServers(config), { DEMO_TOKEN: 'abc' });
    expect(manager.serverIds).toEqual(['fs']);
  });

  it('env 引用在展开时才取值', () => {
    expect(expandEnvRefs('Bearer $TOKEN', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(expandEnvRefs('${TOKEN}/tail', { TOKEN: 'abc' })).toBe('abc/tail');
    expect(expandEnvRefs('$MISSING', {})).toBe('');
  });

  it('content 数组压平为文本且标注非文本块', () => {
    expect(mcpContentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(mcpContentText([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }])).toContain('图片输出：image/png');
    expect(mcpContentText([{ type: 'resource', resource: { uri: 'file:///x', text: 'body' } }])).toContain('【资源 file:///x】');
    expect(mcpContentText('直接字符串')).toBe('直接字符串');
    expect(mcpContentText(undefined)).toBe('');
  });
});
