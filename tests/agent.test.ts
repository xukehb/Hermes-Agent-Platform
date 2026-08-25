/**
 * agent 层测试：路由分层、模型计划、上下文压缩、子智能体辅助函数与编排端到端。
 * 约束：全部使用 MockProviderClient，不触网；所有落盘路径指向临时目录，避免污染 ~/.hap。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentOrchestrator,
  AgentRouter,
  assertFitsContext,
  compactHistory,
  composeSubagentInput,
  inferIntentTags,
  parseMention,
  planModel,
  planModelChain,
  planUtilityModel,
  safeSplitIndex,
  shouldCompact,
  subagentSessionKey,
} from '../src/agent/index.js';
import type { TaskEvent } from '../src/agent/index.js';
import { ConfigResolver, parseConfigText } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/index.js';
import type { ProviderFactory } from '../src/providers/index.js';
import { MockProviderClient, errorTurn, textTurn, toolCallTurn } from '../src/providers/mock.js';
import type { AgentMessage } from '../src/domain/index.js';

/** 记录所有临时目录，测试结束统一清理。 */
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hap-agent-'));
  roots.push(root);
  return root;
}

/**
 * 生成测试用配置文本。
 * 路径统一用 TOML 字面量字符串（单引号），避免 Windows 反斜杠被当作转义序列。
 */
function baseConfig(root: string, limits: string[] = []): string {
  const lines: string[] = [
    "default_agent = 'alpha'",
    "default_model = 'mockp/model-a'",
    '',
    '[paths]',
    "data_dir = '" + join(root, 'data') + "'",
    '',
  ];
  if (limits.length > 0) {
    lines.push('[limits]', ...limits, '');
  }
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
    'context_window = 8000',
    'max_output_tokens = 1024',
    '',
    '[models.model-b]',
    "provider = 'mockf'",
    "model = 'model-b'",
    'context_window = 8000',
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
    '[agents.entries.alpha.subagents]',
    "allow = ['beta']",
    '',
    '[agents.entries.beta]',
    "name = 'Beta'",
    "capabilities = ['research', 'writing']",
    "model = 'mockf/model-b'",
    '',
    '[agents.entries.delta]',
    "name = 'Delta'",
    "model = { primary = 'mockp/model-a', fallbacks = ['mockp/model-a', 'mockf/model-b'] }",
    '',
    '[agents.entries.gamma]',
    "name = 'Gamma'",
    "capabilities = ['coding', 'review']",
    "model = 'mockf/model-b'",
    '',
  );
  return lines.join('\n') + '\n';
}

/** 构造纯内存 ConfigResolver（不落盘，用于纯函数层测试）。 */
function makeResolver(root: string, limits: string[] = []): ConfigResolver {
  const path = join(root, 'hap.toml');
  const raw = baseConfig(root, limits);
  return new ConfigResolver(
    { path, exists: true, config: parseConfigText(raw, path), raw, loadedAt: 0 },
    {},
    {},
  );
}

/** 构造真实编排器（写临时 hap.toml，内存会话库，注入 mock provider 工厂）。 */
function makeOrchestrator(factory: ProviderFactory, limits: string[] = []): AgentOrchestrator {
  const root = tempRoot();
  const path = join(root, 'hap.toml');
  writeFileSync(path, baseConfig(root, limits), 'utf8');
  return new AgentOrchestrator({ configPath: path, env: {}, factory, memoryStore: true });
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AgentRouter 路由分层', () => {
  const resolver = makeResolver(tempRoot());
  const router = new AgentRouter(resolver);

  it('按字典序暴露全部智能体', () => {
    expect(router.agentIds).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('显式指定优先于其它层', () => {
    const decision = router.route({ text: '帮我重构代码', explicitAgent: 'beta' });
    expect(decision.agentId).toBe('beta');
    expect(decision.layer).toBe('explicit');
  });

  it('消息提及命中并剥离前缀', () => {
    const decision = router.route({ text: '@beta 帮我查一下资料' });
    expect(decision.agentId).toBe('beta');
    expect(decision.layer).toBe('explicit');
    expect(decision.detail).toContain('提及');
    expect(decision.input).toBe('帮我查一下资料');
  });

  it('通道默认绑定生效', () => {
    const decision = router.route({ text: '随便聊聊', channelDefaultAgent: 'gamma' });
    expect(decision.agentId).toBe('gamma');
    expect(decision.layer).toBe('channel-binding');
  });

  it('通道默认绑定指向未知 id 时静默跳过', () => {
    const decision = router.route({ text: '随便聊聊', channelDefaultAgent: 'ghost' });
    expect(decision.agentId).toBe('alpha');
    expect(decision.layer).toBe('global-default');
  });

  it('能力路由并列时取字典序最小', () => {
    const decision = router.route({ text: '帮我重构代码' });
    expect(decision.agentId).toBe('alpha');
    expect(decision.layer).toBe('capability');
  });

  it('能力命中数更高者胜出', () => {
    const decision = router.route({ text: '请评审这段代码的质量' });
    expect(decision.agentId).toBe('gamma');
    expect(decision.layer).toBe('capability');
  });

  it('无任何线索时回落全局默认', () => {
    const decision = router.route({ text: '嗯' });
    expect(decision.agentId).toBe('alpha');
    expect(decision.layer).toBe('global-default');
  });

  it('显式指定未知智能体时抛出 AGENT_NOT_FOUND 并列出候选', () => {
    try {
      router.route({ text: 'x', explicitAgent: 'ghost' });
      expect.unreachable('应当抛出 AGENT_NOT_FOUND');
    } catch (error) {
      const err = error as { code?: string; userMessage?: string; message: string };
      expect(err.code).toBe('AGENT_NOT_FOUND');
      expect(err.userMessage ?? err.message).toContain('alpha');
    }
  });

  it('inferIntentTags 识别多个意图标签', () => {
    const tags = inferIntentTags('帮我重构代码并补充测试用例');
    expect(tags).toContain('coding');
    expect(tags).toContain('testing');
  });

  it('parseMention 支持 @ 与 /agent 两种形态', () => {
    expect(parseMention('@beta 你好')?.agent).toBe('beta');
    expect(parseMention('@beta 你好')?.rest).toBe('你好');
    expect(parseMention('/agent gamma 做事')?.agent).toBe('gamma');
    expect(parseMention('/agent gamma 做事')?.rest).toBe('做事');
    expect(parseMention('普通消息')).toBeUndefined();
  });
});

describe('模型计划', () => {
  const resolver = makeResolver(tempRoot());

  it('primary + fallbacks 组成候选链', () => {
    const chain = planModelChain(resolver, resolver.resolveAgent('alpha'));
    expect(chain.map((plan) => plan.fullName)).toEqual(['mockp/model-a', 'mockf/model-b']);
    expect(chain[0]?.protocol).toBe('openai-tools');
    expect(chain[0]?.maxTokens).toBe(1024);
    expect(chain[0]?.contextWindow).toBe(8000);
  });

  it('候选链按完整名去重', () => {
    const chain = planModelChain(resolver, resolver.resolveAgent('delta'));
    expect(chain.map((plan) => plan.fullName)).toEqual(['mockp/model-a', 'mockf/model-b']);
  });

  it('未登记模型仍可直连并回落默认上下文窗口', () => {
    const plan = planModel(resolver, resolver.resolveAgent('alpha'), 'mockp/unlisted-model');
    expect(plan.providerId).toBe('mockp');
    expect(plan.model).toBe('unlisted-model');
    expect(plan.contextWindow).toBe(32000);
  });

  it('无斜杠且非别名的引用抛出 MODEL_NOT_FOUND', () => {
    try {
      planModel(resolver, resolver.resolveAgent('alpha'), 'no-such-alias');
      expect.unreachable('应当抛出 MODEL_NOT_FOUND');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MODEL_NOT_FOUND');
    }
  });

  it('未配置 utility_model 时复用主模型', () => {
    const utility = planUtilityModel(resolver, resolver.resolveAgent('alpha'));
    expect(utility.fullName).toBe('mockp/model-a');
  });
});

describe('上下文压缩', () => {
  const root = tempRoot();
  const resolver = makeResolver(root);
  const agent = resolver.resolveAgent('alpha');

  function makeRegistry(client: MockProviderClient): ProviderRegistry {
    return new ProviderRegistry(resolver.resolveProviders(), { env: {}, factory: () => client });
  }

  it('shouldCompact 阈值向下取整且严格大于才触发', () => {
    const long = '这是一段用于填充上下文预算的中文文本。'.repeat(200);
    const hit = shouldCompact([{ role: 'user', content: long }], '系统提示', 200, 0.5);
    expect(hit.threshold).toBe(100);
    expect(hit.needed).toBe(true);

    const miss = shouldCompact([{ role: 'user', content: '短' }], '', 4000, 0.8);
    expect(miss.threshold).toBe(3200);
    expect(miss.needed).toBe(false);
  });

  it('safeSplitIndex 不会拆开 assistant 工具调用与 tool 结果', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: '问题一' },
      {
        role: 'assistant',
        content: '我来查一下目录',
        toolCalls: [{ id: 'c1', name: 'list_dir', args: {} }],
      },
      {
        role: 'tool',
        content: '目录结果',
        toolResult: { callId: 'c1', name: 'list_dir', content: '目录结果', isError: false },
      },
      { role: 'assistant', content: '这是答案' },
      { role: 'user', content: '问题二' },
      { role: 'assistant', content: '第二个答案' },
    ];
    expect(safeSplitIndex(history, 0)).toBe(0);
    expect(safeSplitIndex(history, 2)).toBe(4);
    expect(safeSplitIndex(history, 4)).toBe(4);
    expect(safeSplitIndex(history, 6)).toBe(6);
  });

  it('assertFitsContext 溢出时抛 CONTEXT_OVERFLOW', () => {
    expect(() => assertFitsContext(3999, 4000, 'mockp/model-a')).not.toThrow();
    try {
      assertFitsContext(5000, 4000, 'mockp/model-a');
      expect.unreachable('应当抛出 CONTEXT_OVERFLOW');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONTEXT_OVERFLOW');
    }
  });

  it('compactHistory 生成摘要并保留近期消息', async () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      history.push({ role: 'user', content: '第 ' + i + ' 轮提问，内容足够长以便产生可观的估算 token。' });
      history.push({ role: 'assistant', content: '第 ' + i + ' 轮回答，内容同样足够长以便产生可观的估算 token。' });
    }
    const client = new MockProviderClient({ providerId: 'mockp' });
    client.push(textTurn('这是压缩后的历史摘要。'));

    const utility = planUtilityModel(resolver, agent);
    const result = await compactHistory(history, '系统提示', {
      registry: makeRegistry(client),
      utility,
      signal: new AbortController().signal,
      keepRecent: 6,
    });

    expect(result.compacted).toBe(10);
    expect(result.summary).toBe('这是压缩后的历史摘要。');
    expect(result.history).toHaveLength(7);
    expect(result.history[0]?.role).toBe('system');
    expect(result.history[0]?.content).toContain('早期对话摘要');
    expect(result.history[0]?.content).toContain('mockp/model-a');
    expect(result.history[0]?.content).toContain('压缩自 10 条');
    expect(result.history[6]?.content).toContain('第 7 轮回答');
    expect(client.lastRequest?.tools ?? []).toHaveLength(0);
  });

  it('摘要为空时抛出可恢复的 CONTEXT_OVERFLOW', async () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      history.push({ role: 'user', content: '提问 ' + i });
      history.push({ role: 'assistant', content: '回答 ' + i });
    }
    const client = new MockProviderClient({ providerId: 'mockp' });
    client.push(textTurn(''));
    try {
      await compactHistory(history, '系统提示', {
        registry: makeRegistry(client),
        utility: planUtilityModel(resolver, agent),
        signal: new AbortController().signal,
      });
      expect.unreachable('应当抛出 CONTEXT_OVERFLOW');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONTEXT_OVERFLOW');
    }
  });

  it('可保留消息不足时抛 CONTEXT_OVERFLOW', async () => {
    const client = new MockProviderClient({ providerId: 'mockp' });
    client.push(textTurn('摘要'));
    try {
      await compactHistory([{ role: 'user', content: '只有一条' }], '系统提示', {
        registry: makeRegistry(client),
        utility: planUtilityModel(resolver, agent),
        signal: new AbortController().signal,
      });
      expect.unreachable('应当抛出 CONTEXT_OVERFLOW');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONTEXT_OVERFLOW');
    }
  });
});

describe('子智能体辅助函数', () => {
  it('会话键包含父任务与目标智能体', () => {
    expect(subagentSessionKey('task-1', 'beta')).toBe('sub:task-1:beta');
  });

  it('带背景时拼接为两段式输入', () => {
    expect(composeSubagentInput('整理结论', '  已有素材  ')).toBe('## 背景\n已有素材\n\n## 任务\n整理结论');
    expect(composeSubagentInput('整理结论')).toBe('整理结论');
  });
});
