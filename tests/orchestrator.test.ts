/**
 * AgentOrchestrator 端到端测试：路由 → 模型计划 → 工具回灌 → 降级重译 →
 * 轮数上限 → 中止 → 日预算 → trace 落盘 → 用量统计。
 *
 * 约束：全部走 MockProviderClient（不触网）；配置里的 data_dir / workspace_root /
 * agent_dir_root 一律指向临时目录，避免污染用户主目录下的 ~/.hap。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOrchestrator } from '../src/agent/index.js';
import type { TaskEvent } from '../src/agent/index.js';
import type { ProviderFactory } from '../src/providers/index.js';
import { MockProviderClient, errorTurn, textTurn, toolCallTurn } from '../src/providers/mock.js';

const roots: string[] = [];
const created: AgentOrchestrator[] = [];

/** 测试用配置：两个提供商、两个模型别名、两个智能体。 */
function configText(root: string, limits: readonly string[] = []): string {
  const lines: string[] = [
    "default_agent = 'alpha'",
    "default_model = 'mockp/model-a'",
    '',
    '[paths]',
    "data_dir = '" + join(root, 'data') + "'",
    '',
  ];
  if (limits.length > 0) lines.push('[limits]', ...limits, '');
  lines.push(
    '[model_providers.mockp]',
    "name = 'Mock 主通道'",
    "base_url = 'http://127.0.0.1:9/v1'",
    "wire_api = 'chat'",
    "default_protocol = 'openai-tools'",
    '',
    '[model_providers.mockf]',
    "name = 'Mock 备用通道'",
    "base_url = 'http://127.0.0.1:9/v1'",
    "wire_api = 'chat'",
    "default_protocol = 'openai-tools'",
    '',
    '[models.model-a]',
    "provider = 'mockp'",
    "model = 'model-a'",
    'context_window = 32000',
    'max_output_tokens = 1024',
    '',
    '[models.model-b]',
    "provider = 'mockf'",
    "model = 'model-b'",
    'context_window = 32000',
    'max_output_tokens = 1024',
    '',
    '[agents.defaults]',
    "workspace_root = '" + join(root, 'ws') + "'",
    "agent_dir_root = '" + join(root, 'agents') + "'",
    '',
    '[agents.entries.alpha]',
    "name = 'Alpha'",
    "capabilities = ['coding']",
    "model = { primary = 'mockp/model-a', fallbacks = ['mockf/model-b'] }",
    '',
    '[agents.entries.alpha.tools]',
    "profile = 'minimal'",
    '',
    '[agents.entries.beta]',
    "name = 'Beta'",
    "capabilities = ['research']",
    "model = 'mockf/model-b'",
    '',
    '[agents.entries.beta.tools]',
    "profile = 'minimal'",
    '',
  );
  return lines.join('\n') + '\n';
}

interface Harness {
  orchestrator: AgentOrchestrator;
  primary: MockProviderClient;
  fallback: MockProviderClient;
  root: string;
}

/** 建立一套隔离的编排环境。每个用例独占临时目录与 mock 脚本。 */
function harness(limits: readonly string[] = []): Harness {
  const root = mkdtempSync(join(tmpdir(), 'hap-orch-'));
  roots.push(root);
  const path = join(root, 'hap.toml');
  writeFileSync(path, configText(root, limits), 'utf8');

  const primary = new MockProviderClient({ providerId: 'mockp' });
  const fallback = new MockProviderClient({ providerId: 'mockf' });
  const factory: ProviderFactory = (ctx) => (ctx.provider.id === 'mockf' ? fallback : primary);

  const orchestrator = new AgentOrchestrator({ configPath: path, env: {}, factory, memoryStore: true });
  created.push(orchestrator);
  return { orchestrator, primary, fallback, root };
}

/** 在智能体工作区放一个可读文件，供 read_file 工具调用使用。 */
function seedWorkspace(h: Harness, agentId: string, fileName: string, content: string): string {
  h.orchestrator.agents.ensureDirectories(agentId);
  const workspace = h.orchestrator.config.resolveAgent(agentId).workspace;
  const file = join(workspace, fileName);
  writeFileSync(file, content, 'utf8');
  return file;
}

afterAll(async () => {
  for (const orchestrator of created) await orchestrator.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('AgentOrchestrator 单轮任务', () => {
  it('完成一次纯文本任务并写出 trace', async () => {
    const h = harness();
    h.primary.push(textTurn('这是第一轮回答。', {
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    }));

    const events: TaskEvent[] = [];
    const outcome = await h.orchestrator.runTask({
      input: '帮我实现一个函数',
      sessionKey: 'tg:1001',
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe('done');
    expect(outcome.agentId).toBe('alpha');
    expect(outcome.text).toBe('这是第一轮回答。');
    expect(outcome.model).toBe('mockp/model-a');
    expect(outcome.protocol).toBe('openai-tools');
    expect(outcome.stopReason).toBe('stop');
    expect(outcome.iterations).toBe(1);
    expect(outcome.usage.totalTokens).toBe(20);
    expect(outcome.error).toBeUndefined();

    expect(events.some((event) => event.type === 'iteration')).toBe(true);
    expect(events.some((event) => event.type === 'text')).toBe(true);
    expect(events.some((event) => event.type === 'usage')).toBe(true);

    expect(existsSync(outcome.tracePath)).toBe(true);
    const lines = readFileSync(outcome.tracePath, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0] ?? '{}') as { taskId?: string; status?: string };
    expect(header.taskId).toBe(outcome.taskId);
    expect(header.status).toBe('done');

    const summary = h.orchestrator.trace(outcome.taskId);
    expect(summary?.status).toBe('done');
    expect(summary?.models).toContain('mockp/model-a');
    expect(summary?.route).toBeDefined();
    expect(summary?.usage.totalTokens).toBe(20);
  });

  it('显式指定智能体时改用其主模型', async () => {
    const h = harness();
    h.fallback.push(textTurn('Beta 的回答。'));

    const outcome = await h.orchestrator.runTask({ agentId: 'beta', input: '查一下资料', sessionKey: 'tg:2' });

    expect(outcome.agentId).toBe('beta');
    expect(outcome.model).toBe('mockf/model-b');
    expect(outcome.text).toBe('Beta 的回答。');
    expect(h.primary.callCount).toBe(0);
  });

  it('多轮对话把历史带入下一次请求', async () => {
    const h = harness();
    h.primary.push(textTurn('第一次回答。'), textTurn('第二次回答。'));

    await h.orchestrator.runTask({ input: '第一个问题', sessionKey: 'tg:3' });
    await h.orchestrator.runTask({ input: '第二个问题', sessionKey: 'tg:3' });

    const rendered = JSON.stringify(h.primary.lastRequest?.messages ?? []);
    expect(rendered).toContain('第一个问题');
    expect(rendered).toContain('第一次回答。');
    expect(rendered).toContain('第二个问题');
  });
});

describe('AgentOrchestrator 工具回灌', () => {
  it('执行工具并把结果回灌给模型', async () => {
    const h = harness();
    seedWorkspace(h, 'alpha', 'notes.md', '这是示例内容。');
    h.primary.push(
      toolCallTurn([{ name: 'read_file', args: { path: 'notes.md' } }], { text: '我先读一下文件。' }),
      textTurn('文件里写的是示例内容。'),
    );

    const events: TaskEvent[] = [];
    const outcome = await h.orchestrator.runTask({
      input: '看看 notes.md 写了什么',
      sessionKey: 'tg:4',
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe('done');
    expect(outcome.iterations).toBe(2);
    expect(outcome.text).toBe('文件里写的是示例内容。');
    expect(outcome.messages).toHaveLength(3);
    expect(outcome.messages[0]?.toolCalls?.[0]?.name).toBe('read_file');
    expect(outcome.messages[1]?.role).toBe('tool');
    expect(outcome.messages[1]?.toolResult?.isError).toBe(false);
    expect(outcome.messages[1]?.content).toContain('示例内容');

    const started = events.filter((event) => event.type === 'tool_start');
    const ended = events.filter((event) => event.type === 'tool_end');
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);

    const summary = h.orchestrator.trace(outcome.taskId);
    expect(summary?.tools.map((tool) => tool.name)).toEqual(['read_file']);
    expect(summary?.tools[0]?.isError).toBe(false);
  });

  it('工具不在白名单时以错误结果回灌而不中断任务', async () => {
    const h = harness();
    h.primary.push(
      toolCallTurn([{ name: 'shell', args: { command: 'echo hi' } }]),
      textTurn('那我换个办法。'),
    );

    const outcome = await h.orchestrator.runTask({ input: '跑个命令', sessionKey: 'tg:5' });

    expect(outcome.status).toBe('done');
    expect(outcome.messages[1]?.toolResult?.isError).toBe(true);
    expect(outcome.text).toBe('那我换个办法。');
  });
});

describe('AgentOrchestrator 降级与上限', () => {
  it('主模型失败时切换到备用模型并计入重译次数', async () => {
    const h = harness();
    h.primary.push(errorTurn(new Error('主通道 500')));
    h.fallback.push(textTurn('备用模型完成了任务。'));

    const events: TaskEvent[] = [];
    const outcome = await h.orchestrator.runTask({
      input: '帮我实现功能',
      sessionKey: 'tg:6',
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe('done');
    expect(outcome.model).toBe('mockf/model-b');
    expect(outcome.retranslations).toBe(1);
    expect(outcome.text).toBe('备用模型完成了任务。');

    const switches = events.filter((event) => event.type === 'model_switch');
    expect(switches).toHaveLength(1);
    expect(events.some((event) => event.type === 'notice')).toBe(true);

    const summary = h.orchestrator.trace(outcome.taskId);
    expect(summary?.switches[0]?.to).toBe('mockf/model-b');
  });

  it('降级链全部失败时返回 failed 而不抛异常', async () => {
    const h = harness();
    h.primary.push(errorTurn(new Error('主通道挂了')));
    h.fallback.push(errorTurn(new Error('备用也挂了')));

    const outcome = await h.orchestrator.runTask({ input: '试试看', sessionKey: 'tg:7' });

    expect(outcome.status).toBe('failed');
    expect(outcome.stopReason).toBe('fallback_exhausted');
    expect(outcome.error ?? '').toContain('备用也挂了');
    expect(outcome.text).toBe('');
    expect(existsSync(outcome.tracePath)).toBe(true);
  });

  it('达到轮数上限时给出提示并汇总中间结论', async () => {
    const h = harness(['max_iterations = 2']);
    seedWorkspace(h, 'alpha', 'notes.md', '循环读取的内容。');
    // 每轮都返回工具调用，模型永不收敛，用来触发轮数上限保护
    h.primary.push(toolCallTurn([{ name: 'read_file', args: { path: 'notes.md' } }], { text: '继续读。' }));
    h.primary.push(toolCallTurn([{ name: 'read_file', args: { path: 'notes.md' } }], { text: '还在读。' }));

    const events: TaskEvent[] = [];
    const outcome = await h.orchestrator.runTask({
      input: '一直读文件',
      sessionKey: 'tg:8',
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe('done');
    expect(outcome.iterations).toBe(2);
    expect(outcome.stopReason).toBe('max_iterations');
    expect(outcome.text).not.toBe('');
    const notices = events.filter(
      (event): event is { type: 'notice'; message: string } => event.type === 'notice',
    );
    expect(notices.some((event) => event.message.includes('轮数上限'))).toBe(true);
  });
});

describe('AgentOrchestrator 中止与配额', () => {
  it('abortSession 能中止同会话的进行中任务', async () => {
    const h = harness();
    h.primary.push(textTurn('这条不会送达。', { delayMs: 5000 }));

    const pending = h.orchestrator.runTask({ input: '慢任务', sessionKey: 'tg:9' });
    const running = h.orchestrator.runningTasks();
    expect(running).toHaveLength(1);
    expect(running[0]?.sessionKey).toBe('tg:9');

    const stopped = h.orchestrator.abortSession('tg:9');
    expect(stopped).toHaveLength(1);

    const outcome = await pending;
    expect(outcome.status).toBe('aborted');
    expect(outcome.stopReason).toBe('aborted');
    expect(h.orchestrator.runningTasks()).toHaveLength(0);
  });

  it('abort 按任务 id 中止，未知 id 返回 false', async () => {
    const h = harness();
    h.primary.push(textTurn('慢', { delayMs: 5000 }));
    const pending = h.orchestrator.runTask({ input: '慢任务', sessionKey: 'tg:10' });
    const taskId = h.orchestrator.runningTasks()[0]?.taskId ?? '';
    expect(h.orchestrator.abort(taskId)).toBe(true);
    expect(h.orchestrator.abort('不存在的任务')).toBe(false);
    const outcome = await pending;
    expect(outcome.status).toBe('aborted');
  });

  it('日预算耗尽后拒绝新任务', async () => {
    const h = harness(['daily_token_budget = 10']);
    h.primary.push(
      textTurn('第一次成功。', { usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 } }),
      textTurn('这次不该被调用。'),
    );

    const first = await h.orchestrator.runTask({ input: '第一个任务', sessionKey: 'tg:11' });
    expect(first.status).toBe('done');

    const second = await h.orchestrator.runTask({ input: '第二个任务', sessionKey: 'tg:11' });
    expect(second.status).toBe('failed');
    expect(second.error ?? '').toContain('预算');
    expect(h.primary.callCount).toBe(1);
  });
});

describe('AgentOrchestrator 观测接口', () => {
  it('usageSince 聚合用量，status 汇总会话状态', async () => {
    const h = harness();
    h.primary.push(
      textTurn('答复一', { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
      textTurn('答复二', { usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } }),
    );

    await h.orchestrator.runTask({ input: '任务一', sessionKey: 'tg:12' });
    await h.orchestrator.runTask({ input: '任务二', sessionKey: 'tg:12' });

    const usage = h.orchestrator.usageSince('1970-01-01T00:00:00.000Z');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.agentId).toBe('alpha');
    expect(usage[0]?.providerId).toBe('mockp');
    expect(usage[0]?.model).toBe('mockp/model-a');
    expect(usage[0]?.totalTokens).toBe(40);
    expect(usage[0]?.calls).toBe(2);

    const status = h.orchestrator.status('tg:12');
    expect(status.sessionKey).toBe('tg:12');
    expect(status.agentId).toBe('alpha');
    expect(status.model).toBe('mockp/model-a');
    expect(status.chain).toEqual(['mockp/model-a', 'mockf/model-b']);
    expect(status.running).toHaveLength(0);
    expect(status.recent.length).toBeGreaterThanOrEqual(2);
    expect(status.todayTokens).toBe(40);
  });

  it('findTask 能按 id 找回任务行，未知 id 返回 undefined', async () => {
    const h = harness();
    h.primary.push(textTurn('好的。'));
    const outcome = await h.orchestrator.runTask({ input: '一个任务', sessionKey: 'tg:13' });

    const row = h.orchestrator.findTask(outcome.taskId);
    expect(row?.taskId).toBe(outcome.taskId);
    expect(row?.status).toBe('done');
    expect(h.orchestrator.findTask('无此任务')).toBeUndefined();
    expect(h.orchestrator.trace('无此任务')).toBeUndefined();
  });

  it('内存存储模式下 recoverInterrupted 返回空列表', () => {
    const h = harness();
    expect(h.orchestrator.recoverInterrupted()).toEqual([]);
  });
});
