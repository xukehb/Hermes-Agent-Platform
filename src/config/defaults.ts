/**
 * 内置默认值与预置资产。
 *
 * 本文件是 FR-CFG-002 六层优先级中「内置默认值」这一层的唯一真相来源：
 * schema.ts 里所有字段都不带 zod default，因此 profile / defaults / agent 条目的缺省行为
 * 完全由此处决定，不会出现 zod 抢在 profile 之前生效的错序。
 *
 * 同时收纳三类预置资产，用于支撑「像 ocx 一样运行时添加服务商与模型」：
 * - BUILTIN_PROVIDERS：8 家提供商的现成参数，供 hap provider add --preset <id>；
 * - BUILTIN_MODELS：模型目录预置，提供 context_window / max_output_tokens / capabilities；
 * - AGENT_TEMPLATES：智能体模板，供 hap agent create --from-template <名>（FR-AGT-005）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ProtocolName, WireApi } from '../domain/index.js';
import type { ResolvedChannels, ResolvedLimits, RuntimeMode, ToolProfileName } from './resolved.js';
import type { AgentDefaultsConfig, AgentEntryConfig, HapConfig, ModelEntryConfig, ModelProviderConfig } from './schema.js';

/** 内置工具名清单（FR-TOOL-001）。顺序即 <tools> 段的展示顺序。 */
export const BUILTIN_TOOL_NAMES = [
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
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * 工具集档位到工具名清单的展开表（FR-TOOL-003）。
 * allow 为空时取该档位全集，deny 始终在最后生效。
 */
export const TOOL_PROFILES: Record<ToolProfileName, readonly BuiltinToolName[]> = {
  minimal: ['read_file', 'list_dir'],
  standard: ['read_file', 'write_file', 'list_dir', 'search', 'http_fetch', 'open_external', 'remote_list_servers', 'find_definition', 'find_references', 'list_symbols', 'host_sysinfo', 'disk_cleanup', 'ip_lookup'],
  coding: ['read_file', 'write_file', 'list_dir', 'search', 'shell', 'open_external', 'apply_patch', 'spawn_subagent', 'remote_exec', 'remote_sysinfo', 'remote_list_servers', 'remote_upgrade_daemon', 'find_definition', 'find_references', 'list_symbols', 'host_sysinfo', 'disk_cleanup', 'ip_lookup'],
  research: ['read_file', 'write_file', 'list_dir', 'search', 'http_fetch', 'open_external', 'spawn_subagent', 'remote_list_servers', 'find_definition', 'find_references', 'list_symbols', 'host_sysinfo', 'disk_cleanup', 'ip_lookup'],
  full: [...BUILTIN_TOOL_NAMES],
};

/** 配额上限的内置默认值，数值取自规格第 4 节参考配置。 */
export const BUILTIN_LIMITS: ResolvedLimits = {
  maxIterations: 24,
  maxSubagentDepth: 3,
  toolTimeoutMs: 120_000,
  toolOutputMaxBytes: 262_144,
  compactThreshold: 0.8,
  dailyTokenBudget: 5_000_000,
  sessionRetentionDays: 30,
  ingressQueueSize: 1_000,
  providerConcurrency: {},
  providerRpm: {},
  agentConcurrency: {},
  agentRpm: {},
  defaultProviderConcurrency: 4,
  defaultAgentConcurrency: 2,
};

/** 通道的内置默认值。默认仅 CLI 通道开启，Telegram 与 HTTP 需显式启用。 */
export const BUILTIN_CHANNELS: ResolvedChannels = {
  editIntervalMs: 1_200,
  asyncThresholdMs: 20_000,
  telegram: {
    enabled: false,
    tokenEnv: 'TELEGRAM_BOT_TOKEN',
    mode: 'polling',
    defaultAgent: undefined,
    mentionPatterns: ['@hap'],
    messageCharLimit: 4_096,
    webhook: undefined,
  },
  whatsapp: {
    enabled: false,
    authDir: '~/.hap/whatsapp-auth',
    defaultAgent: undefined,
    mentionPatterns: ['@hap'],
    messageCharLimit: 4_096,
    reconnectInitialMs: 1_000,
    reconnectMaxMs: 60_000,
    qrLog: true,
  },
  wechat: {
    enabled: false,
    mode: 'personal',
    defaultAgent: undefined,
    mentionPatterns: ['@hap'],
    messageCharLimit: 2_048,
    authDir: '~/.hap/wechat-auth',
    qrLog: true,
    personal: { puppet: 'service' as const, puppetServiceTokenEnv: 'WECHATY_PUPPET_SERVICE_TOKEN', puppetServiceEndpoint: undefined },
    wecom: undefined,
    officialAccount: undefined,
  },
  http: { enabled: false, bind: '127.0.0.1:8787', defaultAgent: undefined },
  cli: { enabled: true, defaultAgent: undefined },
};

/** 标量键的内置默认值。ConfigResolver 以此作为第六层。 */
export const BUILTIN = {
  /** 全局默认智能体，路由第四优先级（FR-ROUTE-003） */
  defaultAgent: 'coder',
  /** 全局默认模型 */
  defaultModel: 'deepseek/deepseek-chat',
  /** 协议探测链的最后一环（FR-LOOP-012 / FR-PROV-008） */
  protocol: 'openai-tools' as ProtocolName,
  runtimeMode: 'oneshot' as RuntimeMode,
  /** persistent 会话的空闲回收时长（FR-TASK-001） */
  runtimeIdleTimeoutMs: 1_800_000,
  toolProfile: 'standard' as ToolProfileName,
  identityEmoji: 'AI',
  reasoningVisible: false,
  workspaceRoot: '~/.hap/workspaces',
  agentDirRoot: '~/.hap/agents',
  dataDir: '~/.hap',
  /** 默认配置文件路径（FR-CFG-001） */
  configPath: '~/.hap/config.toml',
  /** 提供商字段的兜底值 */
  provider: {
    wireApi: 'chat' as WireApi,
    defaultProtocol: 'openai-tools' as ProtocolName,
    requestMaxRetries: 4,
    streamMaxRetries: 5,
    streamIdleTimeoutMs: 300_000,
    /** Anthropic max_tokens 必填时的兜底值（FR-LOOP-011A） */
    maxTokensDefault: 8_192,
  },
};

/**
 * 8 家提供商预置。
 *
 * 仅 anthropic 为原生线制，其余全部走 OpenAI 兼容线制（FR-PROV-009）；
 * default_protocol 决定其下模型的协议默认值（FR-PROV-008）。
 * ollama 无 env_key，按 FR-PROV-003 以空凭据调用。
 */
export const BUILTIN_PROVIDERS: Record<string, ModelProviderConfig> = {
  deepseek: {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    env_key: 'DEEPSEEK_API_KEY',
    wire_api: 'chat',
    default_protocol: 'deepseek',
  },
  openai: {
    name: 'OpenAI (ChatGPT)',
    base_url: 'https://api.openai.com/v1',
    env_key: 'OPENAI_API_KEY',
    wire_api: 'responses',
    default_protocol: 'openai-tools',
    request_max_retries: 4,
    stream_max_retries: 10,
    stream_idle_timeout_ms: 300_000,
  },
  anthropic: {
    name: 'Anthropic Claude',
    // Anthropic SDK 自行拼接 /v1/messages，base_url 必须止于域名。
    // 若写成 .../v1 会得到 /v1/v1/messages 并直接 404（见 tests/wire.test.ts）。
    base_url: 'https://api.anthropic.com',
    env_key: 'ANTHROPIC_API_KEY',
    wire_api: 'anthropic-messages',
    default_protocol: 'anthropic',
    max_tokens_default: 8_192,
  },
  zhipu: {
    name: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    env_key: 'ZHIPU_API_KEY',
    wire_api: 'chat',
    default_protocol: 'openai-tools',
  },
  gemini: {
    name: 'Google Gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    env_key: 'GEMINI_API_KEY',
    wire_api: 'chat',
    default_protocol: 'openai-tools',
  },
  openrouter: {
    name: 'OpenRouter (聚合备用)',
    base_url: 'https://openrouter.ai/api/v1',
    env_key: 'OPENROUTER_API_KEY',
    wire_api: 'chat',
    default_protocol: 'openai-tools',
    http_headers: { 'X-Title': 'HAP' },
  },
  nous: {
    name: 'Nous Hermes',
    base_url: 'https://inference-api.nousresearch.com/v1',
    env_key: 'NOUS_API_KEY',
    wire_api: 'chat',
    default_protocol: 'hermes-native',
  },
  ollama: {
    name: 'Ollama (本地离线备用)',
    base_url: 'http://localhost:11434/v1',
    wire_api: 'chat',
    default_protocol: 'hermes-native',
  },
};

/**
 * 模型目录预置。
 *
 * context_window 供上下文压缩阈值计算（FR-LOOP-013），max_output_tokens 供 Anthropic 请求补齐
 * （FR-LOOP-011A），capabilities 里的 vision 决定图片附件能否直投（FR-CHAN-011）。
 */
export const BUILTIN_MODELS: Record<string, ModelEntryConfig> = {
  'deepseek-chat': {
    provider: 'deepseek',
    display_name: 'DeepSeek Chat',
    context_window: 131_072,
    max_output_tokens: 8_192,
    capabilities: ['tools', 'streaming', 'longctx'],
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    display_name: 'DeepSeek Reasoner',
    context_window: 131_072,
    max_output_tokens: 65_536,
    capabilities: ['tools', 'streaming', 'reasoning', 'longctx'],
  },
  'claude-sonnet-4-5': {
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4.5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    capabilities: ['tools', 'vision', 'streaming', 'reasoning', 'longctx'],
  },
  'gpt-5-codex': {
    provider: 'openai',
    display_name: 'GPT-5 Codex',
    context_window: 400_000,
    max_output_tokens: 128_000,
    capabilities: ['tools', 'vision', 'streaming', 'reasoning', 'longctx'],
  },
  'glm-4.6': {
    provider: 'zhipu',
    display_name: '智谱 GLM-4.6',
    context_window: 204_800,
    max_output_tokens: 131_072,
    capabilities: ['tools', 'streaming', 'reasoning', 'longctx'],
  },
  'gemini-2.5-pro': {
    provider: 'gemini',
    display_name: 'Gemini 2.5 Pro',
    context_window: 1_048_576,
    max_output_tokens: 65_536,
    capabilities: ['tools', 'vision', 'streaming', 'reasoning', 'longctx'],
  },
  'gemini-2.5-flash': {
    provider: 'gemini',
    display_name: 'Gemini 2.5 Flash',
    context_window: 1_048_576,
    max_output_tokens: 65_536,
    capabilities: ['tools', 'vision', 'streaming', 'longctx'],
  },
  'hermes-4-405b': {
    provider: 'nous',
    model: 'Hermes-4-405B',
    display_name: 'Nous Hermes 4 405B',
    context_window: 131_072,
    max_output_tokens: 16_384,
    capabilities: ['tools', 'streaming', 'reasoning', 'longctx'],
    protocol: 'hermes-native',
  },
  'hermes3:8b': {
    provider: 'ollama',
    display_name: 'Ollama Hermes3 8B',
    context_window: 131_072,
    max_output_tokens: 8_192,
    capabilities: ['tools', 'streaming'],
    protocol: 'hermes-native',
  },
};

/**
 * 智能体模板（FR-AGT-005）。
 *
 * 规格要求内置 coder / researcher / writer / ops / vision 五个模板；此处额外提供 reviewer，
 * 因为第 4 节参考配置的五智能体示例用到它，两处共用同一份定义可避免定义漂移。
 * 每个模板的 fallbacks 均跨厂商，因此降级会穿越协议边界，由 FR-LOOP-015 的历史重译兜底。
 */
export const AGENT_TEMPLATES: Record<string, AgentEntryConfig> = {
  coder: {
    name: '编码智能体',
    description: '读写代码、运行测试、提交补丁与远程服务器部署',
    model: { primary: 'anthropic/claude-sonnet-4-5', fallbacks: ['openai/gpt-5-codex', 'deepseek/deepseek-chat'] },
    protocol: 'anthropic',
    capabilities: ['code', 'shell', 'longctx'],
    tools: { profile: 'coding', allow: ['shell', 'apply_patch', 'search', 'read_file', 'write_file', 'list_dir', 'spawn_subagent', 'remote_exec', 'remote_sysinfo', 'remote_list_servers', 'remote_upgrade_daemon'], deny: ['http_fetch'] },
    runtime: { mode: 'persistent' },
    subagents: { allow: ['researcher', 'reviewer'] },
    identity: { emoji: 'DEV' },
  },
  researcher: {
    name: '研究智能体',
    description: '检索资料、交叉核对、产出带引用的结论',
    model: { primary: 'deepseek/deepseek-reasoner', fallbacks: ['gemini/gemini-2.5-pro', 'anthropic/claude-sonnet-4-5'] },
    protocol: 'deepseek',
    capabilities: ['research', 'web', 'longctx'],
    tools: { profile: 'research', allow: ['http_fetch', 'read_file', 'write_file', 'search', 'remote_list_servers'] },
    identity: { emoji: 'DOC' },
  },
  reviewer: {
    name: '评审智能体',
    description: '审查补丁质量、指出风险与不一致',
    model: { primary: 'openai/gpt-5-codex', fallbacks: ['anthropic/claude-sonnet-4-5'] },
    protocol: 'openai-tools',
    capabilities: ['code', 'review'],
    params: { temperature: 0.2 },
    tools: { profile: 'coding', deny: ['shell', 'apply_patch', 'write_file', 'remote_exec'] },
    identity: { emoji: 'REV' },
  },
  writer: {
    name: '写作智能体',
    description: '撰写中文文档、周报与对外说明',
    model: { primary: 'zhipu/glm-4.6', fallbacks: ['deepseek/deepseek-chat'] },
    protocol: 'openai-tools',
    capabilities: ['writing', 'zh'],
    params: { temperature: 0.7 },
    tools: { profile: 'standard', allow: ['read_file', 'write_file', 'search'] },
    identity: { emoji: 'TXT' },
  },
  ops: {
    name: '巡检与运维智能体',
    description: '定时巡检服务状态、操控远程服务器并汇总排障',
    model: { primary: 'gemini/gemini-2.5-flash', fallbacks: ['ollama/hermes3:8b'] },
    protocol: 'openai-tools',
    capabilities: ['ops', 'shell'],
    tools: { profile: 'minimal', allow: ['shell', 'http_fetch', 'read_file', 'remote_exec', 'remote_sysinfo', 'remote_list_servers', 'remote_upgrade_daemon'] },
    identity: { emoji: 'OPS' },
  },
  vision: {
    name: '视觉智能体',
    description: '解析截图与图片附件并给出结论',
    model: { primary: 'gemini/gemini-2.5-pro', fallbacks: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5-codex'] },
    protocol: 'openai-tools',
    capabilities: ['vision', 'research'],
    tools: { profile: 'standard', allow: ['read_file', 'write_file', 'http_fetch'] },
    identity: { emoji: 'IMG' },
  },
};

/** 智能体默认值的脚手架取值，对应第 4 节 [agents.defaults]。 */
export const SCAFFOLD_AGENT_DEFAULTS: AgentDefaultsConfig = {
  workspace_root: '~/.hap/workspaces',
  agent_dir_root: '~/.hap/agents',
  utility_model: 'deepseek/deepseek-chat',
  reasoning_visible: false,
  runtime: { mode: 'oneshot' },
  tools: { profile: 'standard' },
};

/** 脚手架写入的智能体条目 id，取自第 4 节五智能体示例。 */
const SCAFFOLD_AGENT_IDS: readonly string[] = ['coder', 'researcher', 'reviewer', 'writer', 'ops'];

/** 从模板表中挑出脚手架用到的条目，避免第 4 节示例与模板表各写一份。 */
function scaffoldAgentEntries(): Record<string, AgentEntryConfig> {
  const wanted = new Set(SCAFFOLD_AGENT_IDS);
  const entries: Record<string, AgentEntryConfig> = {};
  for (const [id, entry] of Object.entries(AGENT_TEMPLATES)) {
    if (wanted.has(id)) {
      entries[id] = entry;
    }
  }
  return entries;
}

/**
 * hap init 写入的完整配置骨架，等价于规格第 4 节的参考配置。
 * 由对象经 smol-toml 序列化产出，因此配置结构只有一份真相来源，不存在手写 TOML 与 schema 漂移的可能。
 */
export const SCAFFOLD_CONFIG: HapConfig = {
  default_agent: 'coder',
  active_profile: 'cloud',
  limits: {
    max_iterations: BUILTIN_LIMITS.maxIterations,
    max_subagent_depth: BUILTIN_LIMITS.maxSubagentDepth,
    tool_timeout_ms: BUILTIN_LIMITS.toolTimeoutMs,
    tool_output_max_bytes: BUILTIN_LIMITS.toolOutputMaxBytes,
    compact_threshold: BUILTIN_LIMITS.compactThreshold,
    daily_token_budget: BUILTIN_LIMITS.dailyTokenBudget,
  },
  model_providers: BUILTIN_PROVIDERS,
  models: BUILTIN_MODELS,
  profiles: {
    cloud: { default_model: 'deepseek/deepseek-chat' },
    local: { default_model: 'ollama/hermes3:8b', utility_model: 'ollama/hermes3:8b', protocol: 'hermes-native' },
  },
  agents: {
    defaults: SCAFFOLD_AGENT_DEFAULTS,
    entries: scaffoldAgentEntries(),
  },
  channels: {
    edit_interval_ms: BUILTIN_CHANNELS.editIntervalMs,
    async_threshold_ms: BUILTIN_CHANNELS.asyncThresholdMs,
    telegram: {
      enabled: true,
      token_env: 'TELEGRAM_BOT_TOKEN',
      mode: 'polling',
      default_agent: 'coder',
      mention_patterns: ['@hap'],
      message_char_limit: 4_096,
    },
    whatsapp: {
      enabled: false,
      auth_dir: '~/.hap/whatsapp-auth',
      default_agent: 'coder',
      mention_patterns: ['@hap'],
      message_char_limit: 4_096,
      reconnect_initial_ms: 1_000,
      reconnect_max_ms: 60_000,
      qr_log: true,
    },
    http: { enabled: true, bind: '127.0.0.1:8787' },
    cli: { enabled: true },
  },
};
