/**
 * 配置分层解析（FR-CFG-002 / FR-CFG-003 / FR-CFG-006）。
 *
 * 核心设计：一张声明式的键规格表 KEY_SPECS。
 * 每个可解析键在表里登记六个提取器（cli / env / agent / profile / defaults / builtin），
 * resolve 与 explain 共用同一张表走同一条 pick 通路，因此「解释出的来源」与「实际取到的值」
 * 不可能漂移——这是 FR-CFG-006 能被信任的前提。
 *
 * 合并语义（FR-AGT-003）：
 * - 标量与数组：整体覆盖，高优先层出现即胜出，数组不做追加；
 * - params 表：自低向高浅合并，便于 [agents.defaults] 定基调、条目只改单个采样参数。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { join } from 'node:path';
import { ConfigError, type ConfigLayer, type ProtocolName, type WireApi } from '../domain/index.js';
import { BUILTIN, BUILTIN_CHANNELS, BUILTIN_LIMITS, BUILTIN_MODELS, BUILTIN_PROVIDERS, TOOL_PROFILES } from './defaults.js';
import { type LoadedConfig, expandHome } from './loader.js';
import type {
  ExplainCandidate,
  ExplainResult,
  ResolvedAgent,
  ResolvedChannels,
  ResolvedLimits,
  ResolvedModel,
  ResolvedPaths,
  ResolvedProvider,
  ResolvedToolSelection,
  RuntimeMode,
  ToolProfileName,
} from './resolved.js';
import type { AgentDefaultsConfig, AgentEntryConfig, HapConfig, ModelEntryConfig, ModelProviderConfig, ProfileConfig } from './schema.js';

/** 优先级从高到低，即 FR-CFG-002 的层序。 */
export const LAYER_ORDER: readonly ConfigLayer[] = ['cli', 'env', 'agent', 'profile', 'defaults', 'builtin'];

/**
 * 清洗并标准化用户输入的模型引用，容错各种来自 /models 列表复制或带括号、表情符号、状态标记的输入：
 * 例如：
 * - "gpt-5.5（xk/gpt-5.5）" -> "xk/gpt-5.5"
 * - "gpt-5.5 (xk/gpt-5.5)" -> "xk/gpt-5.5"
 * - "👉 gpt-5.5（xk/gpt-5.5） [当前生效]" -> "xk/gpt-5.5"
 * - "· gpt-5.5" -> "gpt-5.5"
 * - "（xk/gpt-5.5）" -> "xk/gpt-5.5"
 */
export function sanitizeModelRef(raw: string): string {
  if (!raw) return '';
  let ref = raw.trim();

  // 1. 去除开头的列表符号，例如：👉, ·, *, •, -, > 等
  ref = ref.replace(/^[👉·*•\->\s]+/, '').trim();

  // 2. 去除末尾的状态标记，例如：[当前生效], (当前生效), [active], (默认) 等
  ref = ref.replace(/[\(\[\{（【][^()（）\[\]]*?(生效|active|默认|当前|ready)[^()（）\[\]]*?[\)\]\}）】]/gi, '').trim();

  // 3. 处理带有全名标注的格式，例如：alias（provider/model）或 alias (provider/model) 或 alias [provider/model]
  const bracketMatch = ref.match(/^([^\(（\[【]+)[\(（\[【]([^\)）\]】]+)[\)）\]】]$/);
  if (bracketMatch) {
    const aliasPart = bracketMatch[1]?.trim() || '';
    const innerPart = bracketMatch[2]?.trim() || '';
    // 如果括号内本身是 provider/model 格式（含 /），优先取最精确的 fullName
    if (innerPart.includes('/')) {
      return innerPart;
    }
    if (aliasPart) {
      return aliasPart;
    }
  }

  // 4. 处理纯括号包裹的输入，例如：（xk/gpt-5.5）或 (xk/gpt-5.5) 或 [xk/gpt-5.5]
  const pureBracketMatch = ref.match(/^[\(（\[【]([^\)）\]】]+)[\)）\]】]$/);
  if (pureBracketMatch && pureBracketMatch[1]) {
    return pureBracketMatch[1].trim();
  }

  return ref;
}

/** CLI 参数覆盖。字段与 commander 选项一一对应，构成优先级最高的一层。 */
export interface CliOverrides {
  agent?: string;
  profile?: string;
  model?: string;
  fallbacks?: string[];
  utilityModel?: string;
  protocol?: ProtocolName;
  params?: Record<string, unknown>;
  capabilities?: string[];
  toolProfile?: ToolProfileName;
  toolAllow?: string[];
  toolDeny?: string[];
  subagentAllow?: string[];
  runtimeMode?: RuntimeMode;
  idleTimeoutMs?: number;
  workspace?: string;
  agentDir?: string;
  systemPromptFile?: string;
  reasoningVisible?: boolean;
  dataDir?: string;
  limits?: Partial<ResolvedLimits>;
  editIntervalMs?: number;
  asyncThresholdMs?: number;
}

/** 一次取值所处的上下文。agent 相关字段在解析全局键时为 undefined。 */
interface LayerContext {
  root: HapConfig;
  cli: CliOverrides;
  env: NodeJS.ProcessEnv;
  profileName: string | undefined;
  profile: ProfileConfig | undefined;
  defaults: AgentDefaultsConfig | undefined;
  agentId: string | undefined;
  agent: AgentEntryConfig | undefined;
}

type Extractor = (ctx: LayerContext) => unknown;

interface KeySpec {
  key: string;
  /** 该键属于全局维度还是智能体维度。explain 靠它决定是否补上默认智能体上下文 */
  scope: 'global' | 'agent';
  /** override：高层整体覆盖；shallow：自低向高浅合并（仅用于 params 这类开放表） */
  merge: 'override' | 'shallow';
  extractors: Partial<Record<ConfigLayer, Extractor>>;
  /** 每层的来源描述，直接出现在 hap config explain 的输出里 */
  sources: Partial<Record<ConfigLayer, string>>;
}

// ─────────── 环境变量读取helpers ───────────

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = envString(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 期望数字，实际为 "' + raw + '"', { envKey: name });
  }
  return value;
}

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = envString(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const lowered = raw.toLowerCase();
  if (lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on') {
    return true;
  }
  if (lowered === '0' || lowered === 'false' || lowered === 'no' || lowered === 'off') {
    return false;
  }
  throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 期望布尔值，实际为 "' + raw + '"', { envKey: name });
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = envString(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const items = raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  return items.length > 0 ? items : undefined;
}

function envEnum<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[]): T | undefined {
  const raw = envString(env, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 期望取值之一 [' + allowed.join(', ') + ']，实际为 "' + raw + '"', { envKey: name });
  }
  return raw as T;
}

/** 解析 a=1,b=2 形式的数值映射，用于按 provider/agent 维度设置配额的环境变量覆盖。 */
function envNumberRecord(env: NodeJS.ProcessEnv, name: string): Record<string, number> | undefined {
  const raw = envString(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 期望 键=数字 形式，实际为 "' + trimmed + '"', { envKey: name });
    }
    const value = Number(trimmed.slice(eq + 1));
    if (!Number.isFinite(value)) {
      throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 的 "' + trimmed + '" 右侧不是数字', { envKey: name });
    }
    result[trimmed.slice(0, eq).trim()] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ─────────── 模型绑定 helpers ───────────

function bindingPrimary(binding: unknown): string | undefined {
  if (typeof binding === 'string') {
    return binding;
  }
  if (binding !== null && typeof binding === 'object') {
    const primary = (binding as { primary?: unknown }).primary;
    if (typeof primary === 'string') {
      return primary;
    }
  }
  return undefined;
}

function bindingFallbacks(binding: unknown): string[] | undefined {
  if (binding !== null && typeof binding === 'object' && !Array.isArray(binding)) {
    const fallbacks = (binding as { fallbacks?: unknown }).fallbacks;
    if (Array.isArray(fallbacks)) {
      return fallbacks.filter((item): item is string => typeof item === 'string');
    }
  }
  return undefined;
}

/** 取 [paths].data_dir 的原始声明值，供派生目录的 builtin 提取器复用。 */
function rawDataDir(ctx: LayerContext): string {
  return ctx.cli.dataDir ?? envString(ctx.env, 'HAP_DATA_DIR') ?? ctx.root.paths?.data_dir ?? BUILTIN.dataDir;
}

// ─────────── 配额键描述表 ───────────

interface LimitDescriptor {
  field: keyof ResolvedLimits;
  tomlKey: string;
  envName: string;
  kind: 'number' | 'record';
}

const LIMIT_DESCRIPTORS: readonly LimitDescriptor[] = [
  { field: 'maxIterations', tomlKey: 'max_iterations', envName: 'HAP_MAX_ITERATIONS', kind: 'number' },
  { field: 'maxSubagentDepth', tomlKey: 'max_subagent_depth', envName: 'HAP_MAX_SUBAGENT_DEPTH', kind: 'number' },
  { field: 'toolTimeoutMs', tomlKey: 'tool_timeout_ms', envName: 'HAP_TOOL_TIMEOUT_MS', kind: 'number' },
  { field: 'toolOutputMaxBytes', tomlKey: 'tool_output_max_bytes', envName: 'HAP_TOOL_OUTPUT_MAX_BYTES', kind: 'number' },
  { field: 'compactThreshold', tomlKey: 'compact_threshold', envName: 'HAP_COMPACT_THRESHOLD', kind: 'number' },
  { field: 'dailyTokenBudget', tomlKey: 'daily_token_budget', envName: 'HAP_DAILY_TOKEN_BUDGET', kind: 'number' },
  { field: 'sessionRetentionDays', tomlKey: 'session_retention_days', envName: 'HAP_SESSION_RETENTION_DAYS', kind: 'number' },
  { field: 'ingressQueueSize', tomlKey: 'ingress_queue_size', envName: 'HAP_INGRESS_QUEUE_SIZE', kind: 'number' },
  { field: 'providerConcurrency', tomlKey: 'provider_concurrency', envName: 'HAP_PROVIDER_CONCURRENCY', kind: 'record' },
  { field: 'providerRpm', tomlKey: 'provider_rpm', envName: 'HAP_PROVIDER_RPM', kind: 'record' },
  { field: 'agentConcurrency', tomlKey: 'agent_concurrency', envName: 'HAP_AGENT_CONCURRENCY', kind: 'record' },
  { field: 'agentRpm', tomlKey: 'agent_rpm', envName: 'HAP_AGENT_RPM', kind: 'record' },
  { field: 'defaultProviderConcurrency', tomlKey: 'default_provider_concurrency', envName: 'HAP_DEFAULT_PROVIDER_CONCURRENCY', kind: 'number' },
  { field: 'defaultAgentConcurrency', tomlKey: 'default_agent_concurrency', envName: 'HAP_DEFAULT_AGENT_CONCURRENCY', kind: 'number' },
];

function limitSpecs(): KeySpec[] {
  return LIMIT_DESCRIPTORS.map((descriptor) => ({
    key: 'limits.' + descriptor.tomlKey,
    scope: 'global' as const,
    merge: 'override' as const,
    extractors: {
      cli: (ctx: LayerContext): unknown => ctx.cli.limits?.[descriptor.field],
      env: (ctx: LayerContext): unknown =>
        descriptor.kind === 'number' ? envNumber(ctx.env, descriptor.envName) : envNumberRecord(ctx.env, descriptor.envName),
      profile: (ctx: LayerContext): unknown => (ctx.profile?.limits as Record<string, unknown> | undefined)?.[descriptor.tomlKey],
      defaults: (ctx: LayerContext): unknown => (ctx.root.limits as Record<string, unknown> | undefined)?.[descriptor.tomlKey],
      builtin: (): unknown => BUILTIN_LIMITS[descriptor.field],
    },
    sources: {
      cli: '--' + descriptor.tomlKey.replace(/_/g, '-'),
      env: descriptor.envName,
      profile: 'profiles.<active>.limits.' + descriptor.tomlKey,
      defaults: 'limits.' + descriptor.tomlKey,
      builtin: 'BUILTIN_LIMITS.' + String(descriptor.field),
    },
  }));
}

// ─────────── 键规格构造 ───────────

/** 单层的提取器与来源描述。 */
interface LayerSpec {
  extract: Extractor;
  source: string;
}

/**
 * 组装一个键规格。只登记实际存在的层：未登记的层在 explain 输出里显示为「该层不适用」，
 * 于是「这个键没有 profile 层」与「profile 层没声明这个键」两种情况可以被区分开。
 */
function makeSpec(
  key: string,
  scope: 'global' | 'agent',
  layers: Partial<Record<ConfigLayer, LayerSpec>>,
  merge: 'override' | 'shallow' = 'override',
): KeySpec {
  const extractors: Partial<Record<ConfigLayer, Extractor>> = {};
  const sources: Partial<Record<ConfigLayer, string>> = {};
  for (const layer of LAYER_ORDER) {
    const entry = layers[layer];
    if (entry !== undefined) {
      extractors[layer] = entry.extract;
      sources[layer] = entry.source;
    }
  }
  return { key, scope, merge, extractors, sources };
}

/** 枚举白名单。CLI 与环境变量送进来的是裸字符串，靠这几张表收敛。 */
const PROTOCOL_NAMES: readonly ProtocolName[] = ['hermes-native', 'openai-tools', 'deepseek', 'anthropic'];
const TOOL_PROFILE_NAMES: readonly ToolProfileName[] = ['minimal', 'standard', 'coding', 'research', 'full'];
const RUNTIME_MODES: readonly RuntimeMode[] = ['oneshot', 'persistent'];
const TELEGRAM_MODES: readonly ('polling' | 'webhook')[] = ['polling', 'webhook'];
const WECHAT_MODES: readonly ('personal' | 'ilink_bot' | 'wecom' | 'official_account')[] = ['personal', 'ilink_bot', 'wecom', 'official_account'];

/** webhook 监听地址与路径的内置兜底值（FR-CHAN-016）。 */
const TELEGRAM_WEBHOOK_BIND = '127.0.0.1:8788';
const TELEGRAM_WEBHOOK_PATH = '/telegram';
const WECHAT_WECOM_BIND = '127.0.0.1:8789';
const WECHAT_WECOM_PATH = '/wecom';
const WECHAT_OFFICIAL_ACCOUNT_BIND = '127.0.0.1:8790';
const WECHAT_OFFICIAL_ACCOUNT_PATH = '/wechat-oa';

/**
 * 解析采样参数的环境变量覆盖。两种写法都接受：
 * - 整段 JSON 对象：HAP_PARAMS={"temperature":0.2,"top_p":0.9}
 * - 键值逗号列表：HAP_PARAMS=temperature=0.2,top_p=0.9（值按数字 → 布尔 → 字符串依次尝试）
 */
function envParams(env: NodeJS.ProcessEnv, name: string): Record<string, unknown> | undefined {
  const raw = envString(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 以 { 开头但不是合法 JSON', { envKey: name });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 期望 JSON 对象', { envKey: name });
    }
    return parsed as Record<string, unknown>;
  }
  const result: Record<string, unknown> = {};
  for (const pair of trimmed.split(',')) {
    const item = pair.trim();
    if (item === '') {
      continue;
    }
    const eq = item.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError('CONFIG_INVALID', '环境变量 ' + name + ' 期望 键=值 形式，实际为 "' + item + '"', { envKey: name });
    }
    const key = item.slice(0, eq).trim();
    const text = item.slice(eq + 1).trim();
    const numeric = Number(text);
    if (text !== '' && Number.isFinite(numeric)) {
      result[key] = numeric;
    } else if (text === 'true' || text === 'false') {
      result[key] = text === 'true';
    } else {
      result[key] = text;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** profile 层的采样参数：profiles.<active>.params 打底，其 agent_defaults.params 叠加。 */
function profileParams(ctx: LayerContext): Record<string, unknown> | undefined {
  const base = ctx.profile?.params;
  const nested = ctx.profile?.agent_defaults?.params;
  if (base === undefined && nested === undefined) {
    return undefined;
  }
  return { ...(base ?? {}), ...(nested ?? {}) };
}

/** 由 workspace_root / agent_dir_root 派生单个智能体的目录（FR-AGT-002）。 */
function deriveAgentPath(root: string | undefined, agentId: string | undefined): string | undefined {
  return root === undefined ? undefined : join(root, agentId ?? 'default');
}

// ─────────── 智能体维度键规格（FR-AGT-003） ───────────

function agentSpecs(): KeySpec[] {
  return [
    makeSpec('name', 'agent', {
      agent: { extract: (ctx) => ctx.agent?.name, source: 'agents.entries.<id>.name' },
      builtin: { extract: (ctx) => ctx.agentId ?? '', source: '智能体 id 本身' },
    }),
    makeSpec('description', 'agent', {
      agent: { extract: (ctx) => ctx.agent?.description, source: 'agents.entries.<id>.description' },
      defaults: { extract: (ctx) => ctx.defaults?.description, source: 'agents.defaults.description' },
      builtin: { extract: () => '', source: '空描述' },
    }),
    makeSpec('model.primary', 'agent', {
      cli: { extract: (ctx) => ctx.cli.model, source: '--model' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_MODEL'), source: 'HAP_MODEL' },
      agent: { extract: (ctx) => bindingPrimary(ctx.agent?.model), source: 'agents.entries.<id>.model' },
      profile: {
        extract: (ctx) => bindingPrimary(ctx.profile?.agent_defaults?.model) ?? ctx.profile?.default_model,
        source: 'profiles.<active>.agent_defaults.model / profiles.<active>.default_model',
      },
      defaults: {
        extract: (ctx) => bindingPrimary(ctx.defaults?.model) ?? ctx.root.default_model,
        source: 'agents.defaults.model / default_model',
      },
      builtin: {
        extract: (ctx) => {
          const userModels = Object.keys(ctx.root.models ?? {});
          if (userModels.length > 0) {
            return userModels[0];
          }
          return ctx.root.default_model ?? BUILTIN.defaultModel;
        },
        source: 'BUILTIN.defaultModel',
      },
    }),
    makeSpec('model.fallbacks', 'agent', {
      cli: { extract: (ctx) => ctx.cli.fallbacks, source: '--fallback（可重复）' },
      env: { extract: (ctx) => envList(ctx.env, 'HAP_FALLBACKS'), source: 'HAP_FALLBACKS（逗号分隔）' },
      agent: { extract: (ctx) => bindingFallbacks(ctx.agent?.model), source: 'agents.entries.<id>.model.fallbacks' },
      profile: { extract: (ctx) => bindingFallbacks(ctx.profile?.agent_defaults?.model), source: 'profiles.<active>.agent_defaults.model.fallbacks' },
      defaults: { extract: (ctx) => bindingFallbacks(ctx.defaults?.model), source: 'agents.defaults.model.fallbacks' },
      builtin: { extract: () => [], source: '无降级链' },
    }),
    makeSpec('utility_model', 'agent', {
      cli: { extract: (ctx) => ctx.cli.utilityModel, source: '--utility-model' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_UTILITY_MODEL'), source: 'HAP_UTILITY_MODEL' },
      agent: { extract: (ctx) => ctx.agent?.utility_model, source: 'agents.entries.<id>.utility_model' },
      profile: {
        extract: (ctx) => ctx.profile?.agent_defaults?.utility_model ?? ctx.profile?.utility_model,
        source: 'profiles.<active>.agent_defaults.utility_model / profiles.<active>.utility_model',
      },
      defaults: { extract: (ctx) => ctx.defaults?.utility_model, source: 'agents.defaults.utility_model' },
      builtin: { extract: () => undefined, source: '留空则复用主模型（FR-ROUTE-002）' },
    }),
    makeSpec('protocol', 'agent', {
      cli: { extract: (ctx) => ctx.cli.protocol, source: '--protocol' },
      env: { extract: (ctx) => envEnum(ctx.env, 'HAP_PROTOCOL', PROTOCOL_NAMES), source: 'HAP_PROTOCOL' },
      agent: { extract: (ctx) => ctx.agent?.protocol, source: 'agents.entries.<id>.protocol' },
      profile: {
        extract: (ctx) => ctx.profile?.agent_defaults?.protocol ?? ctx.profile?.protocol,
        source: 'profiles.<active>.agent_defaults.protocol / profiles.<active>.protocol',
      },
      defaults: { extract: (ctx) => ctx.defaults?.protocol, source: 'agents.defaults.protocol' },
      builtin: { extract: () => undefined, source: '留空，交给协议探测链（FR-LOOP-012）' },
    }),
    makeSpec(
      'params',
      'agent',
      {
        cli: { extract: (ctx) => ctx.cli.params, source: '--param k=v（可重复）' },
        env: { extract: (ctx) => envParams(ctx.env, 'HAP_PARAMS'), source: 'HAP_PARAMS' },
        agent: { extract: (ctx) => ctx.agent?.params, source: 'agents.entries.<id>.params' },
        profile: { extract: (ctx) => profileParams(ctx), source: 'profiles.<active>.params + agent_defaults.params' },
        defaults: { extract: (ctx) => ctx.defaults?.params, source: 'agents.defaults.params' },
        builtin: { extract: () => ({}), source: '空参数表' },
      },
      'shallow',
    ),
    makeSpec('capabilities', 'agent', {
      cli: { extract: (ctx) => ctx.cli.capabilities, source: '--capability（可重复）' },
      env: { extract: (ctx) => envList(ctx.env, 'HAP_CAPABILITIES'), source: 'HAP_CAPABILITIES' },
      agent: { extract: (ctx) => ctx.agent?.capabilities, source: 'agents.entries.<id>.capabilities' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.capabilities, source: 'profiles.<active>.agent_defaults.capabilities' },
      defaults: { extract: (ctx) => ctx.defaults?.capabilities, source: 'agents.defaults.capabilities' },
      builtin: { extract: () => [], source: '无能力标签' },
    }),
    makeSpec('tools.profile', 'agent', {
      cli: { extract: (ctx) => ctx.cli.toolProfile, source: '--tools' },
      env: { extract: (ctx) => envEnum(ctx.env, 'HAP_TOOL_PROFILE', TOOL_PROFILE_NAMES), source: 'HAP_TOOL_PROFILE' },
      agent: { extract: (ctx) => ctx.agent?.tools?.profile, source: 'agents.entries.<id>.tools.profile' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.tools?.profile, source: 'profiles.<active>.agent_defaults.tools.profile' },
      defaults: { extract: (ctx) => ctx.defaults?.tools?.profile, source: 'agents.defaults.tools.profile' },
      builtin: { extract: () => BUILTIN.toolProfile, source: 'BUILTIN.toolProfile' },
    }),
    makeSpec('tools.allow', 'agent', {
      cli: { extract: (ctx) => ctx.cli.toolAllow, source: '--tool-allow（可重复）' },
      env: { extract: (ctx) => envList(ctx.env, 'HAP_TOOL_ALLOW'), source: 'HAP_TOOL_ALLOW' },
      agent: { extract: (ctx) => ctx.agent?.tools?.allow, source: 'agents.entries.<id>.tools.allow' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.tools?.allow, source: 'profiles.<active>.agent_defaults.tools.allow' },
      defaults: { extract: (ctx) => ctx.defaults?.tools?.allow, source: 'agents.defaults.tools.allow' },
      builtin: { extract: () => [], source: '空表示取 profile 全集' },
    }),
    makeSpec('tools.deny', 'agent', {
      cli: { extract: (ctx) => ctx.cli.toolDeny, source: '--tool-deny（可重复）' },
      env: { extract: (ctx) => envList(ctx.env, 'HAP_TOOL_DENY'), source: 'HAP_TOOL_DENY' },
      agent: { extract: (ctx) => ctx.agent?.tools?.deny, source: 'agents.entries.<id>.tools.deny' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.tools?.deny, source: 'profiles.<active>.agent_defaults.tools.deny' },
      defaults: { extract: (ctx) => ctx.defaults?.tools?.deny, source: 'agents.defaults.tools.deny' },
      builtin: { extract: () => [], source: '不禁用任何工具' },
    }),
    makeSpec('subagents.allow', 'agent', {
      cli: { extract: (ctx) => ctx.cli.subagentAllow, source: '--subagent-allow（可重复）' },
      env: { extract: (ctx) => envList(ctx.env, 'HAP_SUBAGENT_ALLOW'), source: 'HAP_SUBAGENT_ALLOW' },
      agent: { extract: (ctx) => ctx.agent?.subagents?.allow, source: 'agents.entries.<id>.subagents.allow' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.subagents?.allow, source: 'profiles.<active>.agent_defaults.subagents.allow' },
      defaults: { extract: (ctx) => ctx.defaults?.subagents?.allow, source: 'agents.defaults.subagents.allow' },
      builtin: { extract: () => [], source: '默认禁止派生（FR-ROUTE-008）' },
    }),
    makeSpec('runtime.mode', 'agent', {
      cli: { extract: (ctx) => ctx.cli.runtimeMode, source: '--runtime-mode' },
      env: { extract: (ctx) => envEnum(ctx.env, 'HAP_RUNTIME_MODE', RUNTIME_MODES), source: 'HAP_RUNTIME_MODE' },
      agent: { extract: (ctx) => ctx.agent?.runtime?.mode, source: 'agents.entries.<id>.runtime.mode' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.runtime?.mode, source: 'profiles.<active>.agent_defaults.runtime.mode' },
      defaults: { extract: (ctx) => ctx.defaults?.runtime?.mode, source: 'agents.defaults.runtime.mode' },
      builtin: { extract: () => BUILTIN.runtimeMode, source: 'BUILTIN.runtimeMode' },
    }),
    makeSpec('runtime.idle_timeout_ms', 'agent', {
      cli: { extract: (ctx) => ctx.cli.idleTimeoutMs, source: '--idle-timeout-ms' },
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_IDLE_TIMEOUT_MS'), source: 'HAP_IDLE_TIMEOUT_MS' },
      agent: { extract: (ctx) => ctx.agent?.runtime?.idle_timeout_ms, source: 'agents.entries.<id>.runtime.idle_timeout_ms' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.runtime?.idle_timeout_ms, source: 'profiles.<active>.agent_defaults.runtime.idle_timeout_ms' },
      defaults: { extract: (ctx) => ctx.defaults?.runtime?.idle_timeout_ms, source: 'agents.defaults.runtime.idle_timeout_ms' },
      builtin: { extract: () => BUILTIN.runtimeIdleTimeoutMs, source: 'BUILTIN.runtimeIdleTimeoutMs' },
    }),
    makeSpec('identity.emoji', 'agent', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_IDENTITY_EMOJI'), source: 'HAP_IDENTITY_EMOJI' },
      agent: { extract: (ctx) => ctx.agent?.identity?.emoji, source: 'agents.entries.<id>.identity.emoji' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.identity?.emoji, source: 'profiles.<active>.agent_defaults.identity.emoji' },
      defaults: { extract: (ctx) => ctx.defaults?.identity?.emoji, source: 'agents.defaults.identity.emoji' },
      builtin: { extract: () => BUILTIN.identityEmoji, source: 'BUILTIN.identityEmoji' },
    }),
    makeSpec('identity.display_name', 'agent', {
      agent: { extract: (ctx) => ctx.agent?.identity?.display_name, source: 'agents.entries.<id>.identity.display_name' },
      defaults: { extract: (ctx) => ctx.defaults?.identity?.display_name, source: 'agents.defaults.identity.display_name' },
      builtin: { extract: (ctx) => ctx.agent?.name ?? ctx.agentId ?? '', source: '智能体 name 或 id' },
    }),
    makeSpec('system_prompt_file', 'agent', {
      cli: { extract: (ctx) => ctx.cli.systemPromptFile, source: '--system-prompt-file' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_SYSTEM_PROMPT_FILE'), source: 'HAP_SYSTEM_PROMPT_FILE' },
      agent: { extract: (ctx) => ctx.agent?.system_prompt_file, source: 'agents.entries.<id>.system_prompt_file' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.system_prompt_file, source: 'profiles.<active>.agent_defaults.system_prompt_file' },
      defaults: { extract: (ctx) => ctx.defaults?.system_prompt_file, source: 'agents.defaults.system_prompt_file' },
      builtin: { extract: () => undefined, source: '无外置职责段（FR-AGT-007）' },
    }),
    makeSpec('reasoning_visible', 'agent', {
      cli: { extract: (ctx) => ctx.cli.reasoningVisible, source: '--reasoning-visible' },
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_REASONING_VISIBLE'), source: 'HAP_REASONING_VISIBLE' },
      agent: { extract: (ctx) => ctx.agent?.reasoning_visible, source: 'agents.entries.<id>.reasoning_visible' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.reasoning_visible, source: 'profiles.<active>.agent_defaults.reasoning_visible' },
      defaults: { extract: (ctx) => ctx.defaults?.reasoning_visible, source: 'agents.defaults.reasoning_visible' },
      builtin: { extract: () => BUILTIN.reasoningVisible, source: 'BUILTIN.reasoningVisible' },
    }),
    makeSpec('workspace', 'agent', {
      cli: { extract: (ctx) => ctx.cli.workspace, source: '--workspace' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_WORKSPACE'), source: 'HAP_WORKSPACE' },
      agent: { extract: (ctx) => ctx.agent?.workspace, source: 'agents.entries.<id>.workspace' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.workspace, source: 'profiles.<active>.agent_defaults.workspace' },
      defaults: {
        extract: (ctx) => ctx.defaults?.workspace ?? deriveAgentPath(ctx.defaults?.workspace_root, ctx.agentId),
        source: 'agents.defaults.workspace / agents.defaults.workspace_root + id',
      },
      builtin: { extract: (ctx) => join(BUILTIN.workspaceRoot, ctx.agentId ?? 'default'), source: 'BUILTIN.workspaceRoot + id' },
    }),
    makeSpec('agent_dir', 'agent', {
      cli: { extract: (ctx) => ctx.cli.agentDir, source: '--agent-dir' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_AGENT_DIR'), source: 'HAP_AGENT_DIR' },
      agent: { extract: (ctx) => ctx.agent?.agent_dir, source: 'agents.entries.<id>.agent_dir' },
      profile: { extract: (ctx) => ctx.profile?.agent_defaults?.agent_dir, source: 'profiles.<active>.agent_defaults.agent_dir' },
      defaults: {
        extract: (ctx) => ctx.defaults?.agent_dir ?? deriveAgentPath(ctx.defaults?.agent_dir_root, ctx.agentId),
        source: 'agents.defaults.agent_dir / agents.defaults.agent_dir_root + id',
      },
      builtin: { extract: (ctx) => join(BUILTIN.agentDirRoot, ctx.agentId ?? 'default'), source: 'BUILTIN.agentDirRoot + id' },
    }),
  ];
}

// ─────────── 全局键规格 ───────────

function globalSpecs(): KeySpec[] {
  return [
    makeSpec('default_agent', 'global', {
      cli: { extract: (ctx) => ctx.cli.agent, source: '--agent' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_AGENT'), source: 'HAP_AGENT' },
      profile: { extract: (ctx) => ctx.profile?.default_agent, source: 'profiles.<active>.default_agent' },
      defaults: { extract: (ctx) => ctx.root.default_agent, source: 'default_agent' },
      builtin: { extract: () => BUILTIN.defaultAgent, source: 'BUILTIN.defaultAgent' },
    }),
    makeSpec('default_model', 'global', {
      cli: { extract: (ctx) => ctx.cli.model, source: '--model' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_MODEL'), source: 'HAP_MODEL' },
      profile: { extract: (ctx) => ctx.profile?.default_model, source: 'profiles.<active>.default_model' },
      defaults: { extract: (ctx) => ctx.root.default_model, source: 'default_model' },
      builtin: { extract: () => BUILTIN.defaultModel, source: 'BUILTIN.defaultModel' },
    }),
    makeSpec('active_profile', 'global', {
      cli: { extract: (ctx) => ctx.cli.profile, source: '--profile' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_PROFILE'), source: 'HAP_PROFILE' },
      defaults: { extract: (ctx) => ctx.root.active_profile, source: 'active_profile' },
      builtin: { extract: () => undefined, source: '不启用任何 profile' },
    }),
    makeSpec('paths.data_dir', 'global', {
      cli: { extract: (ctx) => ctx.cli.dataDir, source: '--data-dir' },
      env: { extract: (ctx) => envString(ctx.env, 'HAP_DATA_DIR'), source: 'HAP_DATA_DIR' },
      defaults: { extract: (ctx) => ctx.root.paths?.data_dir, source: 'paths.data_dir' },
      builtin: { extract: () => BUILTIN.dataDir, source: 'BUILTIN.dataDir' },
    }),
    makeSpec('paths.trace_dir', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_TRACE_DIR'), source: 'HAP_TRACE_DIR' },
      defaults: { extract: (ctx) => ctx.root.paths?.trace_dir, source: 'paths.trace_dir' },
      builtin: { extract: (ctx) => join(expandHome(rawDataDir(ctx)), 'traces'), source: '<data_dir>/traces' },
    }),
    makeSpec('paths.overflow_dir', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_OVERFLOW_DIR'), source: 'HAP_OVERFLOW_DIR' },
      defaults: { extract: (ctx) => ctx.root.paths?.overflow_dir, source: 'paths.overflow_dir' },
      builtin: { extract: (ctx) => join(expandHome(rawDataDir(ctx)), 'overflow'), source: '<data_dir>/overflow' },
    }),
    makeSpec('paths.spool_dir', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_SPOOL_DIR'), source: 'HAP_SPOOL_DIR' },
      defaults: { extract: (ctx) => ctx.root.paths?.spool_dir, source: 'paths.spool_dir' },
      builtin: { extract: (ctx) => join(expandHome(rawDataDir(ctx)), 'spool'), source: '<data_dir>/spool' },
    }),
  ];
}

// ─────────── 通道键规格 ───────────

function channelSpecs(): KeySpec[] {
  return [
    makeSpec('channels.edit_interval_ms', 'global', {
      cli: { extract: (ctx) => ctx.cli.editIntervalMs, source: '--edit-interval-ms' },
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_EDIT_INTERVAL_MS'), source: 'HAP_EDIT_INTERVAL_MS' },
      defaults: { extract: (ctx) => ctx.root.channels?.edit_interval_ms, source: 'channels.edit_interval_ms' },
      builtin: { extract: () => BUILTIN_CHANNELS.editIntervalMs, source: 'BUILTIN_CHANNELS.editIntervalMs' },
    }),
    makeSpec('channels.async_threshold_ms', 'global', {
      cli: { extract: (ctx) => ctx.cli.asyncThresholdMs, source: '--async-threshold-ms' },
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_ASYNC_THRESHOLD_MS'), source: 'HAP_ASYNC_THRESHOLD_MS' },
      defaults: { extract: (ctx) => ctx.root.channels?.async_threshold_ms, source: 'channels.async_threshold_ms' },
      builtin: { extract: () => BUILTIN_CHANNELS.asyncThresholdMs, source: 'BUILTIN_CHANNELS.asyncThresholdMs' },
    }),
    makeSpec('channels.telegram.enabled', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_TELEGRAM_ENABLED'), source: 'HAP_TELEGRAM_ENABLED' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.enabled, source: 'channels.telegram.enabled' },
      builtin: { extract: () => BUILTIN_CHANNELS.telegram.enabled, source: 'BUILTIN_CHANNELS.telegram.enabled' },
    }),
    makeSpec('channels.telegram.token_env', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_TELEGRAM_TOKEN_ENV'), source: 'HAP_TELEGRAM_TOKEN_ENV' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.token_env, source: 'channels.telegram.token_env' },
      builtin: { extract: () => BUILTIN_CHANNELS.telegram.tokenEnv, source: 'BUILTIN_CHANNELS.telegram.tokenEnv' },
    }),
    makeSpec('channels.telegram.mode', 'global', {
      env: { extract: (ctx) => envEnum(ctx.env, 'HAP_TELEGRAM_MODE', TELEGRAM_MODES), source: 'HAP_TELEGRAM_MODE' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.mode, source: 'channels.telegram.mode' },
      builtin: { extract: () => BUILTIN_CHANNELS.telegram.mode, source: 'BUILTIN_CHANNELS.telegram.mode' },
    }),
    makeSpec('channels.telegram.default_agent', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_TELEGRAM_DEFAULT_AGENT'), source: 'HAP_TELEGRAM_DEFAULT_AGENT' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.default_agent, source: 'channels.telegram.default_agent' },
      builtin: { extract: () => undefined, source: '留空则回落到 default_agent（FR-ROUTE-003）' },
    }),
    makeSpec('channels.telegram.mention_patterns', 'global', {
      env: { extract: (ctx) => envList(ctx.env, 'HAP_TELEGRAM_MENTIONS'), source: 'HAP_TELEGRAM_MENTIONS' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.mention_patterns, source: 'channels.telegram.mention_patterns' },
      builtin: { extract: () => [...BUILTIN_CHANNELS.telegram.mentionPatterns], source: 'BUILTIN_CHANNELS.telegram.mentionPatterns' },
    }),
    makeSpec('channels.telegram.message_char_limit', 'global', {
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_TELEGRAM_MESSAGE_CHAR_LIMIT'), source: 'HAP_TELEGRAM_MESSAGE_CHAR_LIMIT' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.message_char_limit, source: 'channels.telegram.message_char_limit' },
      builtin: { extract: () => BUILTIN_CHANNELS.telegram.messageCharLimit, source: 'BUILTIN_CHANNELS.telegram.messageCharLimit' },
    }),
    makeSpec('channels.telegram.webhook.url', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_TELEGRAM_WEBHOOK_URL'), source: 'HAP_TELEGRAM_WEBHOOK_URL' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.webhook?.url, source: 'channels.telegram.webhook.url' },
      builtin: { extract: () => undefined, source: 'polling 模式不需要 webhook' },
    }),
    makeSpec('channels.telegram.webhook.bind', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_TELEGRAM_WEBHOOK_BIND'), source: 'HAP_TELEGRAM_WEBHOOK_BIND' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.webhook?.bind, source: 'channels.telegram.webhook.bind' },
      builtin: { extract: () => TELEGRAM_WEBHOOK_BIND, source: '内置 ' + TELEGRAM_WEBHOOK_BIND },
    }),
    makeSpec('channels.telegram.webhook.path', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_TELEGRAM_WEBHOOK_PATH'), source: 'HAP_TELEGRAM_WEBHOOK_PATH' },
      defaults: { extract: (ctx) => ctx.root.channels?.telegram?.webhook?.path, source: 'channels.telegram.webhook.path' },
      builtin: { extract: () => TELEGRAM_WEBHOOK_PATH, source: '内置 ' + TELEGRAM_WEBHOOK_PATH },
    }),
    makeSpec('channels.whatsapp.enabled', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_WHATSAPP_ENABLED'), source: 'HAP_WHATSAPP_ENABLED' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.enabled, source: 'channels.whatsapp.enabled' },
      builtin: { extract: () => BUILTIN_CHANNELS.whatsapp.enabled, source: 'BUILTIN_CHANNELS.whatsapp.enabled' },
    }),
    makeSpec('channels.whatsapp.auth_dir', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_WHATSAPP_AUTH_DIR'), source: 'HAP_WHATSAPP_AUTH_DIR' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.auth_dir, source: 'channels.whatsapp.auth_dir' },
      builtin: { extract: () => BUILTIN_CHANNELS.whatsapp.authDir, source: 'BUILTIN_CHANNELS.whatsapp.authDir' },
    }),
    makeSpec('channels.whatsapp.default_agent', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_WHATSAPP_DEFAULT_AGENT'), source: 'HAP_WHATSAPP_DEFAULT_AGENT' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.default_agent, source: 'channels.whatsapp.default_agent' },
      builtin: { extract: () => undefined, source: '留空则回落到 default_agent' },
    }),
    makeSpec('channels.whatsapp.mention_patterns', 'global', {
      env: { extract: (ctx) => envList(ctx.env, 'HAP_WHATSAPP_MENTIONS'), source: 'HAP_WHATSAPP_MENTIONS' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.mention_patterns, source: 'channels.whatsapp.mention_patterns' },
      builtin: { extract: () => [...BUILTIN_CHANNELS.whatsapp.mentionPatterns], source: 'BUILTIN_CHANNELS.whatsapp.mentionPatterns' },
    }),
    makeSpec('channels.whatsapp.message_char_limit', 'global', {
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_WHATSAPP_MESSAGE_CHAR_LIMIT'), source: 'HAP_WHATSAPP_MESSAGE_CHAR_LIMIT' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.message_char_limit, source: 'channels.whatsapp.message_char_limit' },
      builtin: { extract: () => BUILTIN_CHANNELS.whatsapp.messageCharLimit, source: 'BUILTIN_CHANNELS.whatsapp.messageCharLimit' },
    }),
    makeSpec('channels.whatsapp.reconnect_initial_ms', 'global', {
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_WHATSAPP_RECONNECT_INITIAL_MS'), source: 'HAP_WHATSAPP_RECONNECT_INITIAL_MS' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.reconnect_initial_ms, source: 'channels.whatsapp.reconnect_initial_ms' },
      builtin: { extract: () => BUILTIN_CHANNELS.whatsapp.reconnectInitialMs, source: 'BUILTIN_CHANNELS.whatsapp.reconnectInitialMs' },
    }),
    makeSpec('channels.whatsapp.reconnect_max_ms', 'global', {
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_WHATSAPP_RECONNECT_MAX_MS'), source: 'HAP_WHATSAPP_RECONNECT_MAX_MS' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.reconnect_max_ms, source: 'channels.whatsapp.reconnect_max_ms' },
      builtin: { extract: () => BUILTIN_CHANNELS.whatsapp.reconnectMaxMs, source: 'BUILTIN_CHANNELS.whatsapp.reconnectMaxMs' },
    }),
    makeSpec('channels.whatsapp.qr_log', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_WHATSAPP_QR_LOG'), source: 'HAP_WHATSAPP_QR_LOG' },
      defaults: { extract: (ctx) => ctx.root.channels?.whatsapp?.qr_log, source: 'channels.whatsapp.qr_log' },
      builtin: { extract: () => BUILTIN_CHANNELS.whatsapp.qrLog, source: 'BUILTIN_CHANNELS.whatsapp.qrLog' },
    }),
    makeSpec('channels.wechat.enabled', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_WECHAT_ENABLED'), source: 'HAP_WECHAT_ENABLED' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.enabled, source: 'channels.wechat.enabled' },
      builtin: { extract: () => BUILTIN_CHANNELS.wechat.enabled, source: 'BUILTIN_CHANNELS.wechat.enabled' },
    }),
    makeSpec('channels.wechat.mode', 'global', {
      env: { extract: (ctx) => envEnum(ctx.env, 'HAP_WECHAT_MODE', WECHAT_MODES), source: 'HAP_WECHAT_MODE' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.mode, source: 'channels.wechat.mode' },
      builtin: { extract: () => BUILTIN_CHANNELS.wechat.mode, source: 'BUILTIN_CHANNELS.wechat.mode' },
    }),
    makeSpec('channels.wechat.default_agent', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_WECHAT_DEFAULT_AGENT'), source: 'HAP_WECHAT_DEFAULT_AGENT' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.default_agent, source: 'channels.wechat.default_agent' },
      builtin: { extract: () => undefined, source: '留空则回落到 default_agent' },
    }),
    makeSpec('channels.wechat.mention_patterns', 'global', {
      env: { extract: (ctx) => envList(ctx.env, 'HAP_WECHAT_MENTIONS'), source: 'HAP_WECHAT_MENTIONS' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.mention_patterns, source: 'channels.wechat.mention_patterns' },
      builtin: { extract: () => [...BUILTIN_CHANNELS.wechat.mentionPatterns], source: 'BUILTIN_CHANNELS.wechat.mentionPatterns' },
    }),
    makeSpec('channels.wechat.message_char_limit', 'global', {
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_WECHAT_MESSAGE_CHAR_LIMIT'), source: 'HAP_WECHAT_MESSAGE_CHAR_LIMIT' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.message_char_limit, source: 'channels.wechat.message_char_limit' },
      builtin: { extract: () => BUILTIN_CHANNELS.wechat.messageCharLimit, source: 'BUILTIN_CHANNELS.wechat.messageCharLimit' },
    }),
    makeSpec('channels.wechat.auth_dir', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_WECHAT_AUTH_DIR'), source: 'HAP_WECHAT_AUTH_DIR' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.auth_dir, source: 'channels.wechat.auth_dir' },
      builtin: { extract: () => BUILTIN_CHANNELS.wechat.authDir, source: 'BUILTIN_CHANNELS.wechat.authDir' },
    }),
    makeSpec('channels.wechat.qr_log', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_WECHAT_QR_LOG'), source: 'HAP_WECHAT_QR_LOG' },
      defaults: { extract: (ctx) => ctx.root.channels?.wechat?.qr_log, source: 'channels.wechat.qr_log' },
      builtin: { extract: () => BUILTIN_CHANNELS.wechat.qrLog, source: 'BUILTIN_CHANNELS.wechat.qrLog' },
    }),
    makeSpec('channels.http.enabled', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_HTTP_ENABLED'), source: 'HAP_HTTP_ENABLED' },
      defaults: { extract: (ctx) => ctx.root.channels?.http?.enabled, source: 'channels.http.enabled' },
      builtin: { extract: () => BUILTIN_CHANNELS.http.enabled, source: 'BUILTIN_CHANNELS.http.enabled' },
    }),
    makeSpec('channels.http.bind', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_HTTP_BIND'), source: 'HAP_HTTP_BIND' },
      defaults: { extract: (ctx) => ctx.root.channels?.http?.bind, source: 'channels.http.bind' },
      builtin: { extract: () => BUILTIN_CHANNELS.http.bind, source: 'BUILTIN_CHANNELS.http.bind' },
    }),
    makeSpec('channels.http.default_agent', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_HTTP_DEFAULT_AGENT'), source: 'HAP_HTTP_DEFAULT_AGENT' },
      defaults: { extract: (ctx) => ctx.root.channels?.http?.default_agent, source: 'channels.http.default_agent' },
      builtin: { extract: () => undefined, source: '留空则回落到 default_agent' },
    }),
    makeSpec('channels.http.auth_token', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_HTTP_AUTH_TOKEN'), source: 'HAP_HTTP_AUTH_TOKEN' },
      defaults: { extract: () => undefined, source: '仅支持环境变量 HAP_HTTP_AUTH_TOKEN' },
      builtin: { extract: () => undefined, source: '未配置' },
    }),
    makeSpec('channels.http.max_body_bytes', 'global', {
      env: { extract: (ctx) => envNumber(ctx.env, 'HAP_HTTP_MAX_BODY_BYTES'), source: 'HAP_HTTP_MAX_BODY_BYTES' },
      defaults: { extract: () => undefined, source: '使用 HTTP 通道默认上限' },
      builtin: { extract: () => undefined, source: '使用 HTTP 通道默认上限' },
    }),
    makeSpec('channels.cli.enabled', 'global', {
      env: { extract: (ctx) => envBoolean(ctx.env, 'HAP_CLI_ENABLED'), source: 'HAP_CLI_ENABLED' },
      defaults: { extract: (ctx) => ctx.root.channels?.cli?.enabled, source: 'channels.cli.enabled' },
      builtin: { extract: () => BUILTIN_CHANNELS.cli.enabled, source: 'BUILTIN_CHANNELS.cli.enabled' },
    }),
    makeSpec('channels.cli.default_agent', 'global', {
      env: { extract: (ctx) => envString(ctx.env, 'HAP_CLI_DEFAULT_AGENT'), source: 'HAP_CLI_DEFAULT_AGENT' },
      defaults: { extract: (ctx) => ctx.root.channels?.cli?.default_agent, source: 'channels.cli.default_agent' },
      builtin: { extract: () => undefined, source: '留空则回落到 default_agent' },
    }),
  ];
}

/** 全部可解析键。resolve 与 explain 共用这一张表。 */
export const KEY_SPECS: readonly KeySpec[] = [...globalSpecs(), ...agentSpecs(), ...limitSpecs(), ...channelSpecs()];

const SPEC_BY_KEY: Map<string, KeySpec> = new Map(KEY_SPECS.map((spec) => [spec.key, spec]));

/** 命令行上的短写法到规范键名的映射，便于 hap config explain model。 */
export const KEY_ALIASES: Record<string, string> = {
  model: 'model.primary',
  fallbacks: 'model.fallbacks',
  tools: 'tools.profile',
  agent: 'default_agent',
  profile: 'active_profile',
  data_dir: 'paths.data_dir',
  telegram_mode: 'channels.telegram.mode',
  whatsapp: 'channels.whatsapp.enabled',
  wechat: 'channels.wechat.enabled',
  wechat_mode: 'channels.wechat.mode',
};
// ─────────── 取值通路：resolve 与 explain 的唯一入口 ───────────

/** 一次取值的完整结果。value 是最终值，candidates 是逐层记录，explain 直接透出。 */
interface PickResult {
  value: unknown;
  winner: ConfigLayer;
  candidates: ExplainCandidate[];
}

/** 某层未登记提取器时的占位说明：区分「该键没有这一层」与「这一层没声明该键」。 */
const LAYER_NOT_APPLICABLE = '(该层不适用)';

/**
 * 按六层优先级取值。
 *
 * override 语义：从高到低第一个 present 的层胜出。
 * shallow 语义：自低向高逐层浅合并，因此高层只需声明想改的子键；winner 记为最高的贡献层。
 */
function pick(spec: KeySpec, ctx: LayerContext): PickResult {
  const candidates: ExplainCandidate[] = [];
  for (const layer of LAYER_ORDER) {
    const extractor = spec.extractors[layer];
    if (extractor === undefined) {
      candidates.push({ layer, present: false, value: undefined, source: LAYER_NOT_APPLICABLE });
      continue;
    }
    const value = extractor(ctx);
    candidates.push({ layer, present: value !== undefined, value, source: spec.sources[layer] ?? layer });
  }

  if (spec.merge === 'shallow') {
    let merged: Record<string, unknown> = {};
    let winner: ConfigLayer = 'builtin';
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate === undefined || !candidate.present) {
        continue;
      }
      const record = asRecord(candidate.value);
      if (record === undefined) {
        continue;
      }
      merged = { ...merged, ...record };
      winner = candidate.layer;
    }
    return { value: merged, winner, candidates };
  }

  for (const candidate of candidates) {
    if (candidate.present) {
      return { value: candidate.value, winner: candidate.layer, candidates };
    }
  }
  return { value: undefined, winner: 'builtin', candidates };
}

// ─────────── 形态收敛 helpers ───────────
// 提取器返回 unknown（同一个键在不同层可能来自 CLI 字符串、环境变量或 TOML），
// 落到 Resolved* 之前统一在这里收敛，避免运行时到处写类型断言。

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 数组整体覆盖，空数组是「用户主动清空」的有效表达，不再回落到下层。 */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNumberRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      result[key] = item;
    }
  }
  return result;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

// ─────────── 解析器 ───────────

/**
 * 分层配置解析器。
 *
 * 一次加载对应一个实例；配置热重载时整体换新实例，进行中的任务继续持有旧实例，
 * 于是「任务执行期间配置不变」这条不变量由对象生命周期本身保证，无需加锁（FR-CFG-005）。
 */
export class ConfigResolver {
  /** 本次解析所依据的配置快照，CLI 需要它回显配置文件路径。 */
  readonly loaded: LoadedConfig;

  private readonly cli: CliOverrides;
  private readonly env: NodeJS.ProcessEnv;

  /** 提供商、模型、配额三张表在一次实例生命周期内不变，惰性算一次即可。 */
  private cachedProviders: Map<string, ResolvedProvider> | undefined;
  private cachedModels: Map<string, ResolvedModel> | undefined;
  private cachedLimits: ResolvedLimits | undefined;

  constructor(loaded: LoadedConfig, cli: CliOverrides = {}, env: NodeJS.ProcessEnv = process.env) {
    this.loaded = loaded;
    this.cli = cli;
    this.env = env;
  }

  get config(): HapConfig {
    return this.loaded.config;
  }

  /** 生效的 profile 名。--profile > HAP_PROFILE > active_profile（FR-CFG-003）。 */
  get profileName(): string | undefined {
    return this.cli.profile ?? envString(this.env, 'HAP_PROFILE') ?? this.config.active_profile;
  }

  /** 生效的 profile 内容。名字指向不存在的 profile 属于配置冲突，直接中止而非静默忽略。 */
  get profile(): ProfileConfig | undefined {
    const name = this.profileName;
    if (name === undefined) {
      return undefined;
    }
    const found = this.config.profiles?.[name];
    if (found === undefined) {
      const known = Object.keys(this.config.profiles ?? {});
      throw new ConfigError(
        'CONFIG_CONFLICT',
        'profile "' + name + '" 未声明。已声明的 profile：' + (known.length > 0 ? known.join(', ') : '(无)'),
        { profile: name, known },
      );
    }
    return found;
  }

  private context(agentId?: string): LayerContext {
    const root = this.config;
    return {
      root,
      cli: this.cli,
      env: this.env,
      profileName: this.profileName,
      profile: this.profile,
      defaults: root.agents?.defaults,
      agentId,
      agent: agentId === undefined ? undefined : root.agents?.entries?.[agentId],
    };
  }

  private specFor(key: string): KeySpec {
    const canonical = KEY_ALIASES[key] ?? key;
    const spec = SPEC_BY_KEY.get(canonical);
    if (spec === undefined) {
      throw new ConfigError('CONFIG_INVALID', '未知配置键 "' + key + '"。可解析的键：\n  ' + this.keys().join('\n  '), { key });
    }
    return spec;
  }

  private read(key: string, ctx: LayerContext): unknown {
    return pick(this.specFor(key), ctx).value;
  }

  /** 全部可解析键，供 CLI 补全与错误提示使用。 */
  keys(): string[] {
    return KEY_SPECS.map((spec) => spec.key).sort((a, b) => a.localeCompare(b));
  }

  // ── 全局维度 ──

  resolvePaths(): ResolvedPaths {
    const ctx = this.context();
    const dataDir = expandHome(asString(this.read('paths.data_dir', ctx)) ?? BUILTIN.dataDir);
    return {
      dataDir,
      traceDir: expandHome(asString(this.read('paths.trace_dir', ctx)) ?? join(dataDir, 'traces')),
      overflowDir: expandHome(asString(this.read('paths.overflow_dir', ctx)) ?? join(dataDir, 'overflow')),
      spoolDir: expandHome(asString(this.read('paths.spool_dir', ctx)) ?? join(dataDir, 'spool')),
    };
  }

  /**
   * 解析配额上限。
   *
   * 逐字段赋值而非整体替换：limits 的 14 个键各自独立走六层，
   * 因此 profile 只改 max_iterations 时不会把其余 13 项一起拽回内置值。
   */
  resolveLimits(): ResolvedLimits {
    if (this.cachedLimits !== undefined) {
      return this.cachedLimits;
    }
    const ctx = this.context();
    const limits: ResolvedLimits = {
      ...BUILTIN_LIMITS,
      providerConcurrency: { ...BUILTIN_LIMITS.providerConcurrency },
      providerRpm: { ...BUILTIN_LIMITS.providerRpm },
      agentConcurrency: { ...BUILTIN_LIMITS.agentConcurrency },
      agentRpm: { ...BUILTIN_LIMITS.agentRpm },
    };
    const view = limits as unknown as Record<string, number | Record<string, number>>;
    for (const descriptor of LIMIT_DESCRIPTORS) {
      const raw = this.read('limits.' + descriptor.tomlKey, ctx);
      if (descriptor.kind === 'number') {
        const value = asNumber(raw);
        if (value !== undefined) {
          view[descriptor.field] = value;
        }
      } else {
        const record = asNumberRecord(raw);
        if (record !== undefined && Object.keys(record).length > 0) {
          view[descriptor.field] = record;
        }
      }
    }
    this.cachedLimits = limits;
    return limits;
  }

  resolveChannels(): ResolvedChannels {
    const ctx = this.context();
    const mode = asEnum(this.read('channels.telegram.mode', ctx), TELEGRAM_MODES) ?? BUILTIN_CHANNELS.telegram.mode;
    const webhookUrl = asString(this.read('channels.telegram.webhook.url', ctx));
    if (mode === 'webhook' && webhookUrl === undefined) {
      throw new ConfigError('CONFIG_CONFLICT', 'channels.telegram.mode = "webhook" 但未提供 webhook.url（FR-CHAN-016）', {
        key: 'channels.telegram.webhook.url',
      });
    }
    const webhook =
      mode === 'webhook' && webhookUrl !== undefined
        ? {
            url: webhookUrl,
            bind: asString(this.read('channels.telegram.webhook.bind', ctx)) ?? TELEGRAM_WEBHOOK_BIND,
            path: asString(this.read('channels.telegram.webhook.path', ctx)) ?? TELEGRAM_WEBHOOK_PATH,
          }
        : undefined;

    return {
      editIntervalMs: asNumber(this.read('channels.edit_interval_ms', ctx)) ?? BUILTIN_CHANNELS.editIntervalMs,
      asyncThresholdMs: asNumber(this.read('channels.async_threshold_ms', ctx)) ?? BUILTIN_CHANNELS.asyncThresholdMs,
      telegram: {
        enabled: asBoolean(this.read('channels.telegram.enabled', ctx)) ?? BUILTIN_CHANNELS.telegram.enabled,
        tokenEnv: asString(this.read('channels.telegram.token_env', ctx)) ?? BUILTIN_CHANNELS.telegram.tokenEnv,
        mode,
        defaultAgent: asString(this.read('channels.telegram.default_agent', ctx)),
        mentionPatterns: asStringArray(this.read('channels.telegram.mention_patterns', ctx)) ?? [...BUILTIN_CHANNELS.telegram.mentionPatterns],
        messageCharLimit: asNumber(this.read('channels.telegram.message_char_limit', ctx)) ?? BUILTIN_CHANNELS.telegram.messageCharLimit,
        webhook,
      },
      whatsapp: {
        enabled: asBoolean(this.read('channels.whatsapp.enabled', ctx)) ?? BUILTIN_CHANNELS.whatsapp.enabled,
        authDir: expandHome(asString(this.read('channels.whatsapp.auth_dir', ctx)) ?? BUILTIN_CHANNELS.whatsapp.authDir),
        defaultAgent: asString(this.read('channels.whatsapp.default_agent', ctx)),
        mentionPatterns: asStringArray(this.read('channels.whatsapp.mention_patterns', ctx)) ?? [...BUILTIN_CHANNELS.whatsapp.mentionPatterns],
        messageCharLimit: asNumber(this.read('channels.whatsapp.message_char_limit', ctx)) ?? BUILTIN_CHANNELS.whatsapp.messageCharLimit,
        reconnectInitialMs: asNumber(this.read('channels.whatsapp.reconnect_initial_ms', ctx)) ?? BUILTIN_CHANNELS.whatsapp.reconnectInitialMs,
        reconnectMaxMs: asNumber(this.read('channels.whatsapp.reconnect_max_ms', ctx)) ?? BUILTIN_CHANNELS.whatsapp.reconnectMaxMs,
        qrLog: asBoolean(this.read('channels.whatsapp.qr_log', ctx)) ?? BUILTIN_CHANNELS.whatsapp.qrLog,
      },
      wechat: {
        enabled: asBoolean(this.read('channels.wechat.enabled', ctx)) ?? BUILTIN_CHANNELS.wechat.enabled,
        mode: asEnum(this.read('channels.wechat.mode', ctx), WECHAT_MODES) ?? BUILTIN_CHANNELS.wechat.mode,
        defaultAgent: asString(this.read('channels.wechat.default_agent', ctx)),
        mentionPatterns: asStringArray(this.read('channels.wechat.mention_patterns', ctx)) ?? [...BUILTIN_CHANNELS.wechat.mentionPatterns],
        messageCharLimit: asNumber(this.read('channels.wechat.message_char_limit', ctx)) ?? BUILTIN_CHANNELS.wechat.messageCharLimit,
        authDir: expandHome(asString(this.read('channels.wechat.auth_dir', ctx)) ?? BUILTIN_CHANNELS.wechat.authDir),
        qrLog: asBoolean(this.read('channels.wechat.qr_log', ctx)) ?? BUILTIN_CHANNELS.wechat.qrLog,
        personal: {
          puppet: ctx.root.channels?.wechat?.personal?.puppet ?? BUILTIN_CHANNELS.wechat.personal.puppet,
          ilinkAccountId: ctx.root.channels?.wechat?.personal?.ilink_account_id ?? BUILTIN_CHANNELS.wechat.personal.ilinkAccountId,
          puppetServiceTokenEnv: ctx.root.channels?.wechat?.personal?.puppet_service_token_env ?? BUILTIN_CHANNELS.wechat.personal.puppetServiceTokenEnv,
          puppetServiceEndpoint: ctx.root.channels?.wechat?.personal?.puppet_service_endpoint,
        },
        wecom: ctx.root.channels?.wechat?.wecom
          ? {
              corpId: ctx.root.channels.wechat.wecom.corp_id,
              corpSecretEnv: ctx.root.channels.wechat.wecom.corp_secret_env ?? 'WECHAT_WECOM_CORP_SECRET',
              agentId: ctx.root.channels.wechat.wecom.agent_id,
              token: ctx.root.channels.wechat.wecom.token,
              encodingAesKey: ctx.root.channels.wechat.wecom.encoding_aes_key,
              webhookUrlEnv: ctx.root.channels.wechat.wecom.webhook_url_env ?? 'WECHAT_WECOM_WEBHOOK_URL',
              bind: ctx.root.channels.wechat.wecom.bind ?? WECHAT_WECOM_BIND,
              path: ctx.root.channels.wechat.wecom.path ?? WECHAT_WECOM_PATH,
            }
          : undefined,
        officialAccount: ctx.root.channels?.wechat?.official_account
          ? {
              appId: ctx.root.channels.wechat.official_account.app_id,
              appSecretEnv: ctx.root.channels.wechat.official_account.app_secret_env ?? 'WECHAT_OA_APP_SECRET',
              token: ctx.root.channels.wechat.official_account.token,
              encodingAesKey: ctx.root.channels.wechat.official_account.encoding_aes_key,
              bind: ctx.root.channels.wechat.official_account.bind ?? WECHAT_OFFICIAL_ACCOUNT_BIND,
              path: ctx.root.channels.wechat.official_account.path ?? WECHAT_OFFICIAL_ACCOUNT_PATH,
            }
          : undefined,
      },
      http: {
        enabled: asBoolean(this.read('channels.http.enabled', ctx)) ?? BUILTIN_CHANNELS.http.enabled,
        bind: asString(this.read('channels.http.bind', ctx)) ?? BUILTIN_CHANNELS.http.bind,
        defaultAgent: asString(this.read('channels.http.default_agent', ctx)),
        authToken: asString(this.read('channels.http.auth_token', ctx)),
        maxBodyBytes: (() => {
          const value = this.read('channels.http.max_body_bytes', ctx);
          return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
        })(),
      },
      cli: {
        enabled: asBoolean(this.read('channels.cli.enabled', ctx)) ?? BUILTIN_CHANNELS.cli.enabled,
        defaultAgent: asString(this.read('channels.cli.default_agent', ctx)),
      },
    };
  }

  // ── 提供商与模型目录 ──

  /**
   * 解析提供商表。预置 8 家作为基底，配置文件同名条目按字段覆盖。
   *
   * 「按字段覆盖」而非「整体替换」意味着用户只写 base_url 换代理地址时，
   * wire_api 与 default_protocol 仍沿用预置值——这正是 ocx 式增量配置的手感（FR-PROV-001）。
   */
  resolveProviders(): Map<string, ResolvedProvider> {
    if (this.cachedProviders !== undefined) {
      return this.cachedProviders;
    }
    const merged = new Map<string, ModelProviderConfig>();
    for (const [id, entry] of Object.entries(BUILTIN_PROVIDERS)) {
      merged.set(id, entry);
    }
    for (const [id, entry] of Object.entries(this.config.model_providers ?? {})) {
      const base = merged.get(id);
      merged.set(id, base === undefined ? entry : { ...base, ...entry });
    }

    const result = new Map<string, ResolvedProvider>();
    for (const [id, provider] of merged) {
      const wireApi: WireApi = provider.wire_api ?? BUILTIN.provider.wireApi;
      result.set(id, {
        id,
        name: provider.name ?? id,
        baseUrl: provider.base_url,
        envKey: provider.env_key,
        wireApi,
        defaultProtocol: provider.default_protocol ?? BUILTIN.provider.defaultProtocol,
        httpHeaders: { ...(provider.http_headers ?? {}) },
        envHttpHeaders: { ...(provider.env_http_headers ?? {}) },
        requestMaxRetries: provider.request_max_retries ?? BUILTIN.provider.requestMaxRetries,
        streamMaxRetries: provider.stream_max_retries ?? BUILTIN.provider.streamMaxRetries,
        streamIdleTimeoutMs: provider.stream_idle_timeout_ms ?? BUILTIN.provider.streamIdleTimeoutMs,
        maxTokensDefault: provider.max_tokens_default ?? BUILTIN.provider.maxTokensDefault,
      });
    }
    this.cachedProviders = result;
    return result;
  }

  resolveProvider(providerId: string): ResolvedProvider {
    const found = this.resolveProviders().get(providerId);
    if (found === undefined) {
      throw new ConfigError('PROVIDER_NOT_FOUND', '提供商 "' + providerId + '" 未声明。已知提供商：' + [...this.resolveProviders().keys()].join(', '), {
        providerId,
      });
    }
    return found;
  }

  /** 解析模型目录。同样以预置为基底按字段覆盖，因此用户可只补 context_window。 */
  resolveModels(): Map<string, ResolvedModel> {
    if (this.cachedModels !== undefined) {
      return this.cachedModels;
    }
    const merged = new Map<string, ModelEntryConfig>();
    for (const [alias, entry] of Object.entries(BUILTIN_MODELS)) {
      merged.set(alias, entry);
    }
    for (const [alias, entry] of Object.entries(this.config.models ?? {})) {
      const base = merged.get(alias);
      merged.set(alias, base === undefined ? entry : { ...base, ...entry });
    }

    const result = new Map<string, ResolvedModel>();
    for (const [alias, entry] of merged) {
      const model = entry.model ?? alias;
      result.set(alias, {
        alias,
        providerId: entry.provider,
        model,
        displayName: entry.display_name ?? alias,
        fullName: entry.provider + '/' + model,
        contextWindow: entry.context_window,
        maxOutputTokens: entry.max_output_tokens,
        capabilities: [...(entry.capabilities ?? [])],
        protocol: entry.protocol,
        params: { ...(entry.params ?? {}) },
      });
    }
    this.cachedModels = result;
    return result;
  }

  /** 把目录别名归一为 provider/model 全名；已是全名或未登记则原样返回（FR-ROUTE-001）。 */
  normalizeModelRef(ref: string): string {
    const clean = sanitizeModelRef(ref);
    return this.findModel(clean)?.fullName ?? (clean.includes('/') ? clean : (this.resolveModels().get(clean)?.fullName ?? clean));
  }

  /** 按别名或全名查目录条目。未登记的模型允许直接引用，只是拿不到 context_window 等元数据。 */
  findModel(ref: string): ResolvedModel | undefined {
    const clean = sanitizeModelRef(ref);
    const models = this.resolveModels();

    // 1. 精确别名
    const byAlias = models.get(clean);
    if (byAlias !== undefined) return byAlias;

    // 2. 精确全名
    for (const entry of models.values()) {
      if (entry.fullName === clean) return entry;
    }

    // 3. 大小写不敏感别名
    const cleanLower = clean.toLowerCase();
    for (const entry of models.values()) {
      if (entry.alias.toLowerCase() === cleanLower) return entry;
    }

    // 4. 大小写不敏感全名
    for (const entry of models.values()) {
      if (entry.fullName.toLowerCase() === cleanLower) return entry;
    }

    // 5. 模型名后缀匹配 (例如输入 gpt-4o 匹配 openrouter/gpt-4o 或 openai/gpt-4o，或输入 openai/gpt-5-codex 匹配 alias 为 gpt-5-codex 的条目)
    for (const entry of models.values()) {
      if (
        entry.model === clean ||
        entry.model.toLowerCase() === cleanLower ||
        entry.fullName.endsWith('/' + clean) ||
        clean === `${entry.providerId}/${entry.alias}` ||
        cleanLower === `${entry.providerId.toLowerCase()}/${entry.alias.toLowerCase()}`
      ) {
        return entry;
      }
    }

    return undefined;
  }

  // ── 智能体维度 ──

  /** 已声明的智能体 id。零配置时给出唯一的默认智能体，保证 CLI 与通道都有可用目标。 */
  listAgentIds(): string[] {
    const ids = Object.keys(this.config.agents?.entries ?? {});
    return ids.length > 0 ? ids : [this.resolveDefaultAgentId()];
  }

 resolveDefaultAgentId(): string {
    return asString(this.read('default_agent', this.context())) ?? BUILTIN.defaultAgent;
  }

  /**
   * 校验智能体 id 已声明，未声明则抛 AGENT_NOT_FOUND。
   *
   * resolveAgent 与 explain 共用此断言：否则 explain 会对拼错的 id 静默返回兜底值，
   * 让人误以为该智能体存在且用的是默认模型（FR-CFG-006）。
   * entries 为空表示零配置模式，此时唯一的默认智能体总是合法，不做校验。
   */
  private assertAgentDeclared(id: string): void {
    const entries = this.config.agents?.entries ?? {};
    const known = Object.keys(entries);
    if (known.length > 0 && entries[id] === undefined) {
      throw new ConfigError('AGENT_NOT_FOUND', '智能体 "' + id + '" 未声明。已声明的智能体：' + known.join(', '), {
        agentId: id,
        known,
      });
    }
  }

  /**
   * 解析单个智能体。
   *
   * 降级链在此处一并归一化并去重，且剔除与 primary 相同的项：
   * 否则「主模型失败后重试同一个主模型」会白烧一次配额（FR-ROUTE-004）。
   */
  resolveAgent(agentId?: string): ResolvedAgent {
    const id = agentId ?? this.resolveDefaultAgentId();
    this.assertAgentDeclared(id);
    const ctx = this.context(id);

    const primary = this.normalizeModelRef(asString(this.read('model.primary', ctx)) ?? BUILTIN.defaultModel);
    const fallbacks: string[] = [];
    for (const raw of asStringArray(this.read('model.fallbacks', ctx)) ?? []) {
      const normalized = this.normalizeModelRef(raw);
      if (normalized !== primary && !fallbacks.includes(normalized)) {
        fallbacks.push(normalized);
      }
    }
    const utilityRaw = asString(this.read('utility_model', ctx));
    const name = asString(this.read('name', ctx)) ?? id;
    const workspace = asString(this.read('workspace', ctx)) ?? join(BUILTIN.workspaceRoot, id);
    const agentDir = asString(this.read('agent_dir', ctx)) ?? join(BUILTIN.agentDirRoot, id);
    const promptFile = asString(this.read('system_prompt_file', ctx));

    return {
      id,
      name,
      description: asString(this.read('description', ctx)) ?? '',
      workspace: expandHome(workspace),
      agentDir: expandHome(agentDir),
      model: { primary, fallbacks },
      utilityModel: utilityRaw === undefined ? undefined : this.normalizeModelRef(utilityRaw),
      protocol: asEnum(this.read('protocol', ctx), PROTOCOL_NAMES),
      params: asRecord(this.read('params', ctx)) ?? {},
      capabilities: asStringArray(this.read('capabilities', ctx)) ?? [],
      tools: {
        profile: asEnum(this.read('tools.profile', ctx), TOOL_PROFILE_NAMES) ?? BUILTIN.toolProfile,
        allow: asStringArray(this.read('tools.allow', ctx)) ?? [],
        deny: asStringArray(this.read('tools.deny', ctx)) ?? [],
      },
      subagentAllow: asStringArray(this.read('subagents.allow', ctx)) ?? [],
      runtime: {
        mode: asEnum(this.read('runtime.mode', ctx), RUNTIME_MODES) ?? BUILTIN.runtimeMode,
        idleTimeoutMs: asNumber(this.read('runtime.idle_timeout_ms', ctx)) ?? BUILTIN.runtimeIdleTimeoutMs,
      },
      identity: {
        emoji: asString(this.read('identity.emoji', ctx)) ?? BUILTIN.identityEmoji,
        displayName: asString(this.read('identity.display_name', ctx)) ?? name,
      },
      systemPromptFile: promptFile === undefined ? undefined : expandHome(promptFile),
      reasoningVisible: asBoolean(this.read('reasoning_visible', ctx)) ?? BUILTIN.reasoningVisible,
      limits: this.resolveLimits(),
    };
  }

  resolveAllAgents(): ResolvedAgent[] {
    return this.listAgentIds().map((id) => this.resolveAgent(id));
  }

  // ── 凭据体检（第 6 节：启动期即失败并列出变量名） ──

  /** 被任一智能体或全局默认值实际引用到的提供商 id。未被引用的提供商缺 Key 不该阻塞启动。 */
  referencedProviderIds(): Set<string> {
    const result = new Set<string>();
    const push = (ref: string | undefined): void => {
      if (ref === undefined) {
        return;
      }
      const full = this.normalizeModelRef(ref);
      const slash = full.indexOf('/');
      if (slash > 0) {
        result.add(full.slice(0, slash));
      }
    };
    push(asString(this.read('default_model', this.context())) ?? BUILTIN.defaultModel);
    for (const agent of this.resolveAllAgents()) {
      push(agent.model.primary);
      for (const item of agent.model.fallbacks) {
        push(item);
      }
      push(agent.utilityModel);
    }
    return result;
  }

  /** 列出被引用但凭据环境变量为空的提供商。 */
  missingCredentials(): Array<{ providerId: string; envKey: string }> {
    const missing: Array<{ providerId: string; envKey: string }> = [];
    for (const providerId of this.referencedProviderIds()) {
      const provider = this.resolveProviders().get(providerId);
      if (provider?.envKey === undefined) {
        continue;
      }
      const value = this.env[provider.envKey];
      if (value === undefined || value === '') {
        missing.push({ providerId, envKey: provider.envKey });
      }
    }
    return missing;
  }

  // ── 溯源（FR-CFG-006） ──

  /** 解释某个键的取值来源。与 resolve 共用 pick，因此解释结果与实际取值不可能不一致。 */
  explain(key: string, agentId?: string): ExplainResult {
    const spec = this.specFor(key);
    const effectiveAgent = spec.scope === 'agent' ? (agentId ?? this.resolveDefaultAgentId()) : agentId;
    if (effectiveAgent !== undefined) {
      this.assertAgentDeclared(effectiveAgent);
    }
    const ctx = this.context(effectiveAgent);
    const picked = pick(spec, ctx);
    return { key: spec.key, agentId: ctx.agentId, value: picked.value, winner: picked.winner, candidates: picked.candidates };
  }
}

/**
 * 把工具集裁剪展开为最终工具名清单（FR-TOOL-003）。
 * allow 非空则以 allow 为全集，否则取档位全集；deny 最后生效，始终优先。
 */
export function expandToolSelection(selection: ResolvedToolSelection): string[] {
  const base = selection.allow.length > 0 ? selection.allow : [...TOOL_PROFILES[selection.profile]];
  const denied = new Set(selection.deny);
  const result: string[] = [];
  for (const name of base) {
    if (!denied.has(name) && !result.includes(name)) {
      result.push(name);
    }
  }
  return result;
}
