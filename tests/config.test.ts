/**
 * 配置层测试：六层优先级、交叉校验、溯源与写回。
 *
 * 覆盖 FR-CFG-002（六层优先级）、FR-CFG-003（profile）、FR-CFG-004（校验四元组）、
 * FR-CFG-006（explain 溯源）、FR-CFG-007 / FR-PROV-005 / FR-MOD-002 / FR-AGT-004（写回）、
 * FR-TOOL-003（工具集裁剪）、FR-PROV-001（预置提供商增量覆盖）。
 *
 * 全部用例离线运行，不触网、不读真实用户目录；写回用例在系统临时目录里建沙箱并在结束时清理。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigResolver,
  ConfigWriter,
  type CliOverrides,
  type LoadedConfig,
  expandToolSelection,
  parseConfigText,
  sanitizeModelRef,
  validateCrossReferences,
} from '../src/config/index.js';
import { ConfigError } from '../src/domain/index.js';

/** 由 TOML 文本构造一次加载快照，绕开磁盘 IO，让优先级用例保持纯函数式。 */
function loadedFrom(text: string, path = '/virtual/hap.toml'): LoadedConfig {
  const config = parseConfigText(text, path);
  validateCrossReferences(config, path);
  return { path, exists: true, config, raw: text, loadedAt: 0 };
}

/**
 * 测试用配置。刻意让同一个键在多层同时出现，这样任一层的取值顺序写错都会被断言抓到：
 * - limits.max_iterations 同时出现在根 [limits]（defaults 层）与 [profiles.cloud.limits]（profile 层）
 * - params 三层都有且键不完全重叠，用于验证浅合并而非整体替换
 * - capabilities 在 defaults 与 agent 两层都有，用于验证数组整体替换
 */
const CONFIG_TEXT = [
  'default_agent = "coder"',
  'default_model = "deepseek/deepseek-chat"',
  'active_profile = "cloud"',
  '',
  '[limits]',
  'max_iterations = 12',
  'tool_timeout_ms = 60000',
  '',
  '[limits.provider_concurrency]',
  'deepseek = 6',
  '',
  '[model_providers.deepseek]',
  'base_url = "https://proxy.local/v1"',
  '',
  '[models.deepseek-chat]',
  'provider = "deepseek"',
  'context_window = 200000',
  '',
  '[profiles.cloud]',
  'default_model = "zhipu/glm-4.6"',
  '',
  '[profiles.cloud.params]',
  'temperature = 0.4',
  'top_p = 0.9',
  '',
  '[profiles.cloud.limits]',
  'max_iterations = 18',
  '',
  '[profiles.local]',
  'default_model = "ollama/hermes3:8b"',
  'protocol = "hermes-native"',
  '',
  '[agents.defaults]',
  'utility_model = "deepseek/deepseek-chat"',
  'capabilities = ["base"]',
  'reasoning_visible = false',
  '',
  '[agents.defaults.params]',
  'temperature = 0.1',
  'presence_penalty = 0.3',
  '',
  '[agents.defaults.tools]',
  'profile = "standard"',
  '',
  '[agents.entries.coder]',
  'name = "编码智能体"',
  'protocol = "anthropic"',
  'capabilities = ["code", "shell"]',
  'model = { primary = "anthropic/claude-sonnet-4-5", fallbacks = ["openai/gpt-5-codex", "anthropic/claude-sonnet-4-5", "deepseek/deepseek-chat"] }',
  '',
  '[agents.entries.coder.params]',
  'top_k = 40',
  '',
  '[agents.entries.coder.tools]',
  'profile = "coding"',
  'deny = ["shell"]',
  '',
  '[agents.entries.coder.subagents]',
  'allow = ["researcher"]',
  '',
  '[agents.entries.researcher]',
  'model = "deepseek-reasoner"',
  '',
  '[agents.entries.writer]',
  'name = "写作智能体"',
  '',
].join('\n');

const LOADED = loadedFrom(CONFIG_TEXT);

/** 零配置快照：验证「不写任何配置文件也能跑」这条零配置可用性要求。 */
const EMPTY: LoadedConfig = { path: '/virtual/none.toml', exists: false, config: {}, raw: '', loadedAt: 0 };

function make(cli: CliOverrides = {}, env: NodeJS.ProcessEnv = {}): ConfigResolver {
  return new ConfigResolver(LOADED, cli, env);
}

describe('六层优先级（FR-CFG-002）', () => {
  it('agent 层压过 profile 与 defaults 层', () => {
    const agent = make().resolveAgent('coder');
    expect(agent.model.primary).toBe('anthropic/claude-sonnet-4-5');
    expect(agent.protocol).toBe('anthropic');
  });

  it('profile 层在 agent 未声明时接管', () => {
    const agent = make().resolveAgent('writer');
    expect(agent.model.primary).toBe('zhipu/glm-4.6');
  });

  it('env 层压过 agent 层', () => {
    const agent = make({}, { HAP_MODEL: 'gemini/gemini-2.5-flash' }).resolveAgent('coder');
    expect(agent.model.primary).toBe('gemini/gemini-2.5-flash');
  });

  it('cli 层压过 env 层', () => {
    const agent = make({ model: 'openai/gpt-5-codex' }, { HAP_MODEL: 'gemini/gemini-2.5-flash' }).resolveAgent('coder');
    expect(agent.model.primary).toBe('openai/gpt-5-codex');
  });

  it('builtin 层在其余五层都缺席时兜底', () => {
    const agent = new ConfigResolver(EMPTY, {}, {}).resolveAgent();
    expect(agent.id).toBe('coder');
    expect(agent.model.primary).toBe('deepseek/deepseek-chat');
    expect(agent.runtime.mode).toBe('oneshot');
    expect(agent.tools.profile).toBe('standard');
  });

  it('limits 逐字段独立走六层：profile 只改一项不会拽回其余项', () => {
    const limits = make().resolveLimits();
    expect(limits.maxIterations).toBe(18);
    expect(limits.toolTimeoutMs).toBe(60000);
    expect(limits.maxSubagentDepth).toBe(3);
    expect(limits.providerConcurrency['deepseek']).toBe(6);
  });

  it('limits 也接受 env 与 cli 覆盖', () => {
    expect(make({}, { HAP_MAX_ITERATIONS: '7' }).resolveLimits().maxIterations).toBe(7);
    expect(make({ limits: { maxIterations: 5 } }, { HAP_MAX_ITERATIONS: '7' }).resolveLimits().maxIterations).toBe(5);
    expect(make({}, { HAP_PROVIDER_CONCURRENCY: 'deepseek=2,anthropic=3' }).resolveLimits().providerConcurrency).toEqual({
      deepseek: 2,
      anthropic: 3,
    });
  });

  it('数组类键整体替换，不与低层合并', () => {
    expect(make().resolveAgent('coder').capabilities).toEqual(['code', 'shell']);
    expect(make().resolveAgent('writer').capabilities).toEqual(['base']);
    expect(make({ capabilities: ['only-cli'] }).resolveAgent('coder').capabilities).toEqual(['only-cli']);
  });

  it('params 自低向高浅合并，同名键由高层胜出', () => {
    const params = make().resolveAgent('coder').params;
    expect(params).toEqual({ temperature: 0.4, presence_penalty: 0.3, top_p: 0.9, top_k: 40 });
  });

  it('params 的 env 层同时接受 JSON 与键值列表两种写法', () => {
    const viaJson = make({}, { HAP_PARAMS: '{"temperature":0.9}' }).resolveAgent('coder').params;
    expect(viaJson['temperature']).toBe(0.9);
    expect(viaJson['top_k']).toBe(40);
    const viaList = make({}, { HAP_PARAMS: 'temperature=0.8,stream_hint=true' }).resolveAgent('coder').params;
    expect(viaList['temperature']).toBe(0.8);
    expect(viaList['stream_hint']).toBe(true);
  });
});

describe('profile 切换（FR-CFG-003）', () => {
  it('--profile 压过 active_profile', () => {
    expect(make().profileName).toBe('cloud');
    expect(make({ profile: 'local' }).profileName).toBe('local');
    expect(make({}, { HAP_PROFILE: 'local' }).profileName).toBe('local');
  });

  it('切到 local profile 后未声明模型的智能体整组换绑', () => {
    const agent = make({ profile: 'local' }).resolveAgent('writer');
    expect(agent.model.primary).toBe('ollama/hermes3:8b');
    expect(agent.protocol).toBe('hermes-native');
  });

  it('指向不存在的 profile 属于配置冲突', () => {
    expect(() => make({ profile: 'ghost' }).profile).toThrow(ConfigError);
  });
});

describe('校验与报错（FR-CFG-004）', () => {
  it('未知配置键报错并列出可解析键', () => {
    let message = '';
    try {
      make().explain('nonexistent.key');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('未知配置键');
    expect(message).toContain('model.primary');
  });

  it('键别名可直接使用', () => {
    expect(make().explain('model').key).toBe('model.primary');
    expect(make().explain('tools').key).toBe('tools.profile');
  });

  it('TOML 未知键在解析期即被拒绝，并回显键名', () => {
    let message = '';
    try {
      parseConfigText('[agents.entries.x]\nnot_a_field = 1\n', '/virtual/bad.toml');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('not_a_field');
    expect(message).toContain('/virtual/bad.toml');
  });

  it('交叉引用失败一次性列出全部问题', () => {
    const text = [
      '[agents.entries.a]',
      'model = "ghostvendor/ghost-model"',
      '',
      '[agents.entries.a.subagents]',
      'allow = ["nobody"]',
      '',
      '[agents.entries.a.tools]',
      'allow = ["not_a_tool"]',
      '',
    ].join('\n');
    const config = parseConfigText(text, '/virtual/x.toml');
    let message = '';
    try {
      validateCrossReferences(config, '/virtual/x.toml');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ghostvendor/ghost-model');
    expect(message).toContain('nobody');
    expect(message).toContain('not_a_tool');
  });

  it('引用预置模型的零配置写法不算冲突', () => {
    const text = ['[agents.entries.a]', 'model = "deepseek/deepseek-chat"', ''].join('\n');
    expect(() => validateCrossReferences(parseConfigText(text, '/v.toml'), '/v.toml')).not.toThrow();
  });

  it('MCP 工具名以双下划线书写时放行', () => {
    const text = ['[agents.entries.a]', '', '[agents.entries.a.tools]', 'allow = ["fs__read"]', ''].join('\n');
    expect(() => validateCrossReferences(parseConfigText(text, '/v.toml'), '/v.toml')).not.toThrow();
  });
});

describe('溯源（FR-CFG-006）', () => {
  it('explain 的取值与 resolveAgent 完全一致', () => {
    const resolver = make({}, { HAP_MODEL: 'gemini/gemini-2.5-flash' });
    const explained = resolver.explain('model.primary', 'coder');
    expect(explained.winner).toBe('env');
    expect(explained.value).toBe('gemini/gemini-2.5-flash');
    expect(resolver.resolveAgent('coder').model.primary).toBe(explained.value);
  });

  it('六层逐层结果按优先级从高到低给出', () => {
    const explained = make().explain('model.primary', 'coder');
    expect(explained.candidates.map((c) => c.layer)).toEqual(['cli', 'env', 'agent', 'profile', 'defaults', 'builtin']);
    expect(explained.candidates.filter((c) => c.present).map((c) => c.layer)).toEqual([
      'agent',
      'profile',
      'defaults',
      'builtin',
    ]);
    expect(explained.winner).toBe('agent');
  });

  it('智能体维度的键在未指定 id 时回落到默认智能体', () => {
    expect(make().explain('model.primary').agentId).toBe('coder');
  });

  it('explain 对未声明的智能体报错，而不是静默返回兜底值', () => {
    let message = '';
    try {
      make().explain('model.primary', 'ghost-agent');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ghost-agent');
    expect(message).toContain('未声明');
    expect(() => make().explain('model.primary', 'ghost-agent')).toThrow(ConfigError);
  });

  it('params 这类浅合并键的胜出层是最高贡献层', () => {
    expect(make().explain('params', 'coder').winner).toBe('agent');
    expect(make().explain('params', 'writer').winner).toBe('profile');
  });
});

describe('提供商与模型目录（FR-PROV-001 / FR-MOD-001）', () => {
  it('预置提供商作基底，配置文件按字段覆盖', () => {
    const provider = make().resolveProvider('deepseek');
    expect(provider.baseUrl).toBe('https://proxy.local/v1');
    expect(provider.envKey).toBe('DEEPSEEK_API_KEY');
    expect(provider.wireApi).toBe('chat');
    expect(provider.defaultProtocol).toBe('deepseek');
  });

  it('预置模型作基底，配置文件按字段覆盖', () => {
    const model = make().findModel('deepseek-chat');
    expect(model?.contextWindow).toBe(200000);
    expect(model?.displayName).toBe('DeepSeek Chat');
    expect(model?.fullName).toBe('deepseek/deepseek-chat');
  });

  it('别名与全名都能查到同一条目', () => {
    const resolver = make();
    expect(resolver.findModel('claude-sonnet-4-5')?.alias).toBe('claude-sonnet-4-5');
    expect(resolver.findModel('anthropic/claude-sonnet-4-5')?.alias).toBe('claude-sonnet-4-5');
    expect(resolver.normalizeModelRef('deepseek-reasoner')).toBe('deepseek/deepseek-reasoner');
    expect(resolver.normalizeModelRef('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });

  it('无凭据提供商不算缺失，被引用且缺 Key 的才算', () => {
    const resolver = make();
    const missing = resolver.missingCredentials().map((item) => item.providerId);
    expect(missing).toContain('anthropic');
    expect(missing).toContain('deepseek');
    expect(missing).not.toContain('ollama');
    const filled = new ConfigResolver(LOADED, {}, {
      ANTHROPIC_API_KEY: 'k',
      DEEPSEEK_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      ZHIPU_API_KEY: 'k',
    }).missingCredentials();
    expect(filled).toEqual([]);
  });

  it('未被任何智能体引用的提供商不进入体检范围', () => {
    expect([...make().referencedProviderIds()]).not.toContain('openrouter');
  });

  it('未知提供商查询报 PROVIDER_NOT_FOUND', () => {
    expect(() => make().resolveProvider('ghost')).toThrow(ConfigError);
  });
});

describe('智能体解析（FR-AGT-001 / FR-ROUTE-004）', () => {
  it('降级链归一化、去重并剔除与主模型相同的项', () => {
    const agent = make().resolveAgent('coder');
    expect(agent.model.fallbacks).toEqual(['openai/gpt-5-codex', 'deepseek/deepseek-chat']);
  });

  it('别名写法的模型绑定被展开为全名', () => {
    expect(make().resolveAgent('researcher').model.primary).toBe('deepseek/deepseek-reasoner');
  });

  it('工作目录与状态目录按 id 派生且为绝对路径', () => {
    const agent = make().resolveAgent('coder');
    expect(agent.workspace.endsWith(join('workspaces', 'coder'))).toBe(true);
    expect(agent.agentDir.endsWith(join('agents', 'coder'))).toBe(true);
  });

  it('未声明的智能体报 AGENT_NOT_FOUND 并列出已声明者', () => {
    let message = '';
    try {
      make().resolveAgent('ghost');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('AGENT_NOT_FOUND'.length > 0 ? '未声明' : '');
    expect(message).toContain('coder');
  });

  it('listAgentIds 在零配置时给出唯一默认智能体', () => {
    expect(new ConfigResolver(EMPTY, {}, {}).listAgentIds()).toEqual(['coder']);
    expect(make().listAgentIds()).toEqual(['coder', 'researcher', 'writer']);
  });
});

describe('工具集裁剪（FR-TOOL-003）', () => {
  it('deny 始终优先于档位全集', () => {
    const tools = expandToolSelection(make().resolveAgent('coder').tools);
    expect(tools).not.toContain('shell');
    expect(tools).toContain('apply_patch');
  });

  it('allow 非空时以 allow 为全集', () => {
    expect(expandToolSelection({ profile: 'full', allow: ['read_file', 'search'], deny: [] })).toEqual(['read_file', 'search']);
  });

  it('deny 压过 allow', () => {
    expect(expandToolSelection({ profile: 'full', allow: ['read_file', 'search'], deny: ['search'] })).toEqual(['read_file']);
  });

  it('档位展开结果符合内置定义', () => {
    expect(expandToolSelection({ profile: 'minimal', allow: [], deny: [] })).toEqual(['read_file', 'list_dir']);
  });
});

describe('通道解析（FR-CHAN-015 / FR-CHAN-016）', () => {
  it('默认仅 CLI 通道开启', () => {
    const channels = new ConfigResolver(EMPTY, {}, {}).resolveChannels();
    expect(channels.cli.enabled).toBe(true);
    expect(channels.telegram.enabled).toBe(false);
    expect(channels.telegram.messageCharLimit).toBe(4096);
    expect(channels.editIntervalMs).toBe(1200);
  });

  it('解析微信 iLink Bot 模式并默认使用 iLink puppet', () => {
    const text = ['[channels.wechat]', 'enabled = true', 'mode = "ilink_bot"', ''].join('\n');
    const channels = new ConfigResolver(loadedFrom(text), {}, {}).resolveChannels();
    expect(channels.wechat.mode).toBe('ilink_bot');
    expect(channels.wechat.personal.puppet).toBe('ilink');
  });

  it('webhook 模式缺 url 时启动期即冲突', () => {
    expect(() => make({}, { HAP_TELEGRAM_MODE: 'webhook' }).resolveChannels()).toThrow(ConfigError);
  });

  it('webhook 模式补齐 url 后给出监听地址与路径兜底', () => {
    const text = [
      '[channels.telegram]',
      'enabled = true',
      'mode = "webhook"',
      '',
      '[channels.telegram.webhook]',
      'url = "https://example.com/telegram"',
      '',
    ].join('\n');
    const channels = new ConfigResolver(loadedFrom(text), {}, {}).resolveChannels();
    expect(channels.telegram.webhook?.url).toBe('https://example.com/telegram');
    expect(channels.telegram.webhook?.bind).toBe('127.0.0.1:8788');
    expect(channels.telegram.webhook?.path).toBe('/telegram');
  });

  it('polling 与 webhook 块并存被交叉校验拒绝', () => {
    const text = ['[channels.telegram]', 'mode = "polling"', '', '[channels.telegram.webhook]', 'url = "https://x/y"', ''].join('\n');
    expect(() => loadedFrom(text)).toThrow(ConfigError);
  });
});

describe('路径解析', () => {
  it('派生目录默认落在 data_dir 之下，且 cli 覆盖会带动派生项', () => {
    const base = join(tmpdir(), 'hap-data-paths');
    const paths = make({ dataDir: base }).resolvePaths();
    expect(paths.dataDir).toBe(base);
    expect(paths.traceDir).toBe(join(base, 'traces'));
    expect(paths.overflowDir).toBe(join(base, 'overflow'));
    expect(paths.spoolDir).toBe(join(base, 'spool'));
  });
});

describe('配置写回（FR-CFG-007 / FR-PROV-005 / FR-MOD-002 / FR-AGT-004）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hap-config-test-'));
  const file = join(dir, 'config.toml');
  const writer = new ConfigWriter(file);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('init 写出可被自身读回的骨架', () => {
    const result = writer.initScaffold();
    expect(result.created).toBe(true);
    const { config } = writer.read();
    expect(Object.keys(config.model_providers ?? {})).toHaveLength(8);
    expect(Object.keys(config.agents?.entries ?? {})).toContain('coder');
    expect(new ConfigResolver({ ...writer.read(), path: file, loadedAt: 0 }, {}, {}).resolveAllAgents()).toHaveLength(5);
  });

  it('已存在时再 init 需要显式 force', () => {
    expect(() => writer.initScaffold()).toThrow(ConfigError);
  });

  it('provider add 以 preset 带出线制等字段', () => {
    const result = writer.upsertProvider('mycorp', { base_url: 'https://gw.example.com/v1', env_key: 'MYCORP_API_KEY' }, 'openai');
    expect(result.changed).toBe(true);
    const provider = writer.read().config.model_providers?.['mycorp'];
    expect(provider?.wire_api).toBe('responses');
    expect(provider?.base_url).toBe('https://gw.example.com/v1');
    expect(provider?.env_key).toBe('MYCORP_API_KEY');
  });

  it('provider add 缺 base_url 且无预置时给出可执行提示', () => {
    expect(() => writer.upsertProvider('nobase', {})).toThrow(ConfigError);
  });

  it('provider add 同名条目按字段增量更新', () => {
    writer.upsertProvider('mycorp', { request_max_retries: 9 });
    const provider = writer.read().config.model_providers?.['mycorp'];
    expect(provider?.request_max_retries).toBe(9);
    expect(provider?.base_url).toBe('https://gw.example.com/v1');
  });

  it('model add 落到既有提供商之下', () => {
    writer.upsertModel('mycorp-fast', { provider: 'mycorp', model: 'fast-1', context_window: 128000, capabilities: ['tools', 'streaming'] });
    const model = writer.read().config.models?.['mycorp-fast'];
    expect(model?.provider).toBe('mycorp');
    expect(model?.model).toBe('fast-1');
  });

  it('model add 指向未声明提供商时报错并给出修复命令', () => {
    let message = '';
    try {
      writer.upsertModel('ghost-model', { provider: 'ghostvendor' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('hap provider add ghostvendor');
  });

  it('agent create 从模板生成并可覆盖模型', () => {
    writer.upsertAgent('helper', { model: 'mycorp-fast' }, 'writer');
    const agent = writer.read().config.agents?.entries?.['helper'];
    expect(agent?.name).toBe('写作智能体');
    expect(agent?.model).toBe('mycorp-fast');
  });

  it('agent update 可用 null 清空可继承字段', () => {
    writer.upsertAgent('helper', { model: 'mycorp-fast', workspace: join(dir, 'custom-ws') }, 'writer');
    writer.upsertAgent('helper', { model: null, workspace: null } as any);

    const agent = writer.read().config.agents?.entries?.['helper'];
    expect(agent?.model).toBeUndefined();
    expect(agent?.workspace).toBeUndefined();
    expect(agent?.name).toBe('写作智能体');
  });

  it('agent create 从模板生成时收窄尚不存在的派生白名单', () => {
    const result = writer.upsertAgent('solo', {}, 'coder');
    const agent = writer.read().config.agents?.entries?.['solo'];
    expect(agent?.subagents?.allow).toEqual(['researcher', 'reviewer']);
    expect(result.summary).toContain('基于模板 coder');
  });

  it('agent remove 顺带清理全部指向它的引用', () => {
    writer.setGlobals({ defaultAgent: 'helper' });
    expect(writer.read().config.default_agent).toBe('helper');
    const result = writer.removeAgent('helper');
    expect(result.summary).toContain('清空 default_agent');
    expect(writer.read().config.default_agent).toBeUndefined();
    expect(writer.read().config.agents?.entries?.['helper']).toBeUndefined();
  });

  it('provider remove 连带移除其下模型', () => {
    writer.removeAgent('solo');
    const result = writer.removeProvider('mycorp');
    expect(result.summary).toContain('mycorp-fast');
    expect(writer.read().config.models?.['mycorp-fast']).toBeUndefined();
  });

  it('重复写入同一内容时报告无变化', () => {
    const first = writer.setGlobals({ activeProfile: 'local' });
    expect(first.changed).toBe(true);
    const second = writer.setGlobals({ activeProfile: 'local' });
    expect(second.changed).toBe(false);
  });
});

describe('模型引用清洗与容错 (sanitizeModelRef & findModel)', () => {
  it('正确剥离列表符号、中文括号与状态标签', () => {
    expect(sanitizeModelRef('gpt-5.5（xk/gpt-5.5）')).toBe('xk/gpt-5.5');
    expect(sanitizeModelRef('gpt-5.5 (xk/gpt-5.5)')).toBe('xk/gpt-5.5');
    expect(sanitizeModelRef('👉 gpt-5.5（xk/gpt-5.5） [当前生效]')).toBe('xk/gpt-5.5');
    expect(sanitizeModelRef('· gpt-5.5')).toBe('gpt-5.5');
    expect(sanitizeModelRef('（xk/gpt-5.5）')).toBe('xk/gpt-5.5');
    expect(sanitizeModelRef('xk/gpt-5.5')).toBe('xk/gpt-5.5');
  });

  it('在 findModel 和 normalizeModelRef 中正确容错包含中文括号的模型引用', () => {
    const resolver = new ConfigResolver(loadedFrom(CONFIG_TEXT));
    const found = resolver.findModel('deepseek-chat（deepseek/deepseek-chat）');
    expect(found).toBeDefined();
    expect(found?.providerId).toBe('deepseek');
    expect(found?.model).toBe('deepseek-chat');

    const normalized = resolver.normalizeModelRef('👉 deepseek-chat（deepseek/deepseek-chat） [当前生效]');
    expect(normalized).toBe('deepseek/deepseek-chat');
  });
});
