import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dialog, shell } from 'electron';
import { execa } from 'execa';
import { AgentOrchestrator } from '../agent/index.js';
import { WeChatChannel } from '../channels/wechat.js';
import { ChannelManager, TelegramChannel, createChannelHost, parseCommand, HELP_TEXT, ChannelContactStore, WeChatContactStore, FeishuChannel, QQChannel, type ChannelContact, type ChannelChatMessage, type ChannelName, type WeChatContact, type WeChatChatMessage } from '../channels/index.js';
import { BUILTIN_PROVIDERS, ConfigResolver, ConfigWriter, loadConfig, resolveConfigPath, sanitizeModelRef, type ModelPatch, type ProviderPatch, type ResolvedAgent, type ResolvedProvider } from '../config/index.js';
import { describeError, type Attachment, type ProtocolName, type WireApi } from '../domain/index.js';
import { planInjection, writeInjection, type InjectionTarget } from '../inject/index.js';
import { ProviderRegistry } from '../providers/index.js';
import { parseUnifiedDiff, buildHunkPatch, type FileDiffItem } from '../tools/diff-parser.js';
import { McpManager, resolveMcpServers, type ToolModule, type ToolContext } from '../tools/index.js';
import { SqliteSessionStore } from '../storage/index.js';
import {
  ScheduleStore,
  SchedulerEngine,
  type ScheduleJobConfig,
  type ScheduleExecutionRecord,
} from '../scheduler/index.js';
import { MemoryStore, type MemoryCard } from '../memory/index.js';
import { AstSymbolIndexer } from '../tools/ast-indexer/index.js';
import { getLocalIpAddresses } from '../web/server.js';
import {
  getHostSystemInfo,
  scanLocalDisk,
  cleanLocalDisk,
  lookupIpGeo,
  type HostSystemInfo,
  type DiskScanReport,
  type DiskCleanResult,
  type IpGeoInfo,
} from '../system/index.js';
import {
  RemoteServerStore,
  RemoteClientManager,
  installRemoteDaemon,
  type RemoteServerConfig,
  type InstallProgressEvent,
  type RemoteSystemInfo,
  type RemoteExecResult,
  type RemoteProcessList,
  type RemoteProcessSignal,
  type RemoteProcessKillResult,
  type ServerBotConfig,
} from '../remote/index.js';
import { BotControlFacade } from './bot-control.js';
import { removeAgent as removeGuiAgent, upsertAgent as upsertGuiAgent, type GuiAgentInput } from './agent-operations.js';
import type {
  GuiChatInput,
  GuiGitStatus,
  GuiLogEntry,
  GuiModelInput,
  GuiPermissionConfig,
  GuiPlugin,
  GuiProject,
  GuiProjectInput,
  GuiProviderInput,
  GuiSkill,
  GuiSyncInput,
  GuiTarget,
  GuiTelegramConfig,
  GuiWeChatConfig,
  GuiFeishuConfig,
  GuiQQConfig,
  GuiImageGenInput,
  GuiImageGenResult,
  GuiEnvVarItem,
  GuiProviderTestInput,
  GuiBotInstance,
  GuiBotPlatform,
} from './shared.js';

interface GuiState {
  projects: GuiProject[];
  hiddenProviders?: string[];
  hiddenModels?: string[];
  skills?: GuiSkill[];
  plugins?: GuiPlugin[];
  permissions?: GuiPermissionConfig;
}

const DATA_DIR = join(homedir(), '.hap', 'gui');
const STATE_PATH = join(DATA_DIR, 'state.json');
const ENV_PATH = join(DATA_DIR, 'env.json');
const IMAGES_DIR = join(DATA_DIR, 'generated_images');
const BOT_CONTROL_DB_PATH = join(DATA_DIR, 'control-plane.db');
const BOT_CREDENTIALS_DIR = join(DATA_DIR, 'bot-credentials');

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR, { recursive: true });
}

function parseDotEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) {
      result[key] = val;
    }
  }
  return result;
}

function readSavedEnv(): Record<string, string> {
  ensureDataDir();
  if (!existsSync(ENV_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ENV_PATH, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSavedEnv(envMap: Record<string, string>): void {
  ensureDataDir();
  writeFileSync(ENV_PATH, JSON.stringify(envMap, null, 2) + '\n', 'utf8');
}

function loadSavedEnvIntoProcess(): void {
  // 1. 读取 ~/.hap/gui/env.json
  const saved = readSavedEnv();
  for (const [key, value] of Object.entries(saved)) {
    if (value && (!process.env[key] || process.env[key] === '')) {
      let cleanVal = String(value).trim();
      if ((cleanVal.startsWith('"') && cleanVal.endsWith('"')) || (cleanVal.startsWith("'") && cleanVal.endsWith("'"))) {
        cleanVal = cleanVal.slice(1, -1);
      }
      process.env[key] = cleanVal;
    }
  }

  // 2. 尝试读取 ~/.hap/.env
  const userDotEnv = join(homedir(), '.hap', '.env');
  if (existsSync(userDotEnv)) {
    try {
      const parsed = parseDotEnvText(readFileSync(userDotEnv, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (!process.env[k] || process.env[k] === '') {
          process.env[k] = v;
        }
      }
    } catch {
      // 容错
    }
  }

  // 3. 尝试读取当前工作区 .env
  const cwdDotEnv = join(process.cwd(), '.env');
  if (existsSync(cwdDotEnv)) {
    try {
      const parsed = parseDotEnvText(readFileSync(cwdDotEnv, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (!process.env[k] || process.env[k] === '') {
          process.env[k] = v;
        }
      }
    } catch {
      // 容错
    }
  }
}

loadSavedEnvIntoProcess();

export function maskApiKey(value?: string): string {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

const KNOWN_ENV_METADATA: Array<{ key: string; label: string; desc: string; category: 'llm' | 'search' | 'channel' | 'custom' }> = [
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek 官方 API Key', desc: '用于调用 DeepSeek-V3 / DeepSeek-R1 满血版模型', category: 'llm' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API Key (ChatGPT / DALL-E)', desc: '用于调用 GPT-4o、o1/o3-mini、DALL-E 3 高清生图等', category: 'llm' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Claude API Key', desc: '用于调用 Claude 3.5 Sonnet / Opus / Haiku 模型', category: 'llm' },
  { key: 'GEMINI_API_KEY', label: 'Google Gemini API Key', desc: '用于调用 Gemini 2.5 Flash / Pro 多模态模型', category: 'llm' },
  { key: 'ZHIPU_API_KEY', label: '智谱清言 GLM API Key', desc: '用于调用 GLM-4-Plus、GLM-4-Flash 等大模型', category: 'llm' },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter 聚合 API Key', desc: '一站式路由全球所有顶尖商业与开源大模型', category: 'llm' },
  { key: 'SILICONFLOW_API_KEY', label: '硅基流动 SiliconFlow Key', desc: '超高速 DeepSeek / Qwen / Flux 托管服务商', category: 'llm' },
  { key: 'MOONSHOT_API_KEY', label: 'Moonshot (月之暗面 Kimi) Key', desc: '用于调用超长上下文 Moonshot / Kimi 接口', category: 'llm' },
  { key: 'DASHSCOPE_API_KEY', label: '阿里百炼通义千问 (DashScope) Key', desc: '用于调用通义千问 Qwen 系列开源与商业模型', category: 'llm' },
  { key: 'MINIMAX_API_KEY', label: 'MiniMax 稀宇科技 API Key', desc: '用于调用 MiniMax abab6.5 / 语音生图大模型', category: 'llm' },
  { key: 'GROQ_API_KEY', label: 'Groq 极速推理 API Key', desc: '超高速 500+ tokens/s Llama 3 / Mixtral 推理', category: 'llm' },
  { key: 'NOUS_API_KEY', label: 'Nous Research API Key', desc: '用于调用 Hermes 3 原生指令微调大模型', category: 'llm' },
  { key: 'TAVILY_API_KEY', label: 'Tavily AI 智能搜索 API Key', desc: '专为 LLM 智能体设计的深度实时网络搜索 API', category: 'search' },
  { key: 'SERPAPI_API_KEY', label: 'SerpAPI 谷歌搜索 API Key', desc: '用于 Google / Bing / 百度全网搜索检索工具', category: 'search' },
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram 机器人 Bot Token', desc: '用于 Telegram 客户端通道双向收发消息', category: 'channel' },
  { key: 'FEISHU_APP_SECRET', label: '飞书自建应用 App Secret', desc: '用于飞书开放平台事件订阅与消息发送', category: 'channel' },
  { key: 'WECHAT_WECOM_CORP_SECRET', label: '企业微信自建应用 Corp Secret', desc: '用于企业微信自建应用推送与接收指令', category: 'channel' },
];

const DEFAULT_SKILLS: GuiSkill[] = [
  {
    id: 'code-auditor',
    name: '代码安全与质量审计',
    description: '深度分析项目代码库潜在漏洞、安全隐患与 Code Smells，输出改进建议',
    repo: 'open-skills/code-auditor',
    author: 'Hermes Community',
    stars: 1240,
    tags: ['Security', 'Audit', 'Review'],
    installed: true,
    enabled: true,
    version: '1.2.0',
  },
  {
    id: 'git-flow-expert',
    name: 'Git 工作流与分支管理',
    description: '智能生成语义化 Commit Message、自动解决合并冲突与 PR 代码比对',
    repo: 'open-skills/git-flow-expert',
    author: 'GitHub Workflows',
    stars: 980,
    tags: ['Git', 'DevOps', 'CI/CD'],
    installed: true,
    enabled: true,
    version: '2.0.1',
  },
  {
    id: 'test-suite-generator',
    name: '单元测试与集成测试生成器',
    description: '为 TypeScript/JavaScript、Python 等多语言自动生成高覆盖率 Vitest/Jest 用例',
    repo: 'open-skills/test-generator',
    author: 'TestDriven.io',
    stars: 2150,
    tags: ['Testing', 'Vitest', 'TDD'],
    installed: true,
    enabled: true,
    version: '1.5.0',
  },
  {
    id: 'react-next-architect',
    name: 'React / Next.js 架构专家',
    description: '现代前端工程脚手架设计、Server Components 优化与性能重构',
    repo: 'vercel-community/next-architect',
    author: 'Vercel Community',
    stars: 3420,
    tags: ['React', 'Next.js', 'Frontend'],
    installed: false,
    enabled: false,
    version: '3.1.0',
  },
  {
    id: 'docker-k8s-ops',
    name: 'Docker & Kubernetes 运维编排',
    description: '一键生成多阶段构建 Dockerfile、Compose 文件与 K8s 部署清单',
    repo: 'cloud-native/docker-k8s-skill',
    author: 'CloudNative Group',
    stars: 1680,
    tags: ['Docker', 'K8s', 'Ops'],
    installed: false,
    enabled: false,
    version: '1.1.4',
  },
];

const DEFAULT_PLUGINS: GuiPlugin[] = [
  {
    id: 'filesystem',
    name: '本地文件系统 (Filesystem)',
    description: '提供工作区目录遍历、文件安全读写、智能 Patch 应用与代码全文本搜索能力',
    type: 'builtin',
    category: 'system',
    enabled: true,
  },
  {
    id: 'shell-terminal',
    name: '系统终端执行器 (Shell & CLI)',
    description: '在工作区工程环境下自主运行 build、test、git 与 npm 等任意 CLI 命令',
    type: 'builtin',
    category: 'system',
    enabled: true,
  },
  {
    id: 'network-fetch',
    name: '网络检索与数据抓取 (HTTP Fetch)',
    description: '直接抓取并解析远程网页、REST API 数据与在线技术文档，转换为 Markdown',
    type: 'builtin',
    category: 'developer',
    enabled: true,
  },
  {
    id: 'github-mcp',
    name: 'GitHub 官方 MCP 插件',
    description: '通过 GitHub 协议管理 Issues、Pull Requests、分支比较与代码库检索',
    type: 'mcp',
    category: 'developer',
    enabled: true,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
  {
    id: 'sqlite-mcp',
    name: 'SQLite 数据库 MCP 插件',
    description: '提供 SQLite 本地数据库连接、Schema 结构分析、SQL 生成与自动化执行能力',
    type: 'mcp',
    category: 'database',
    enabled: true,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
  },
  {
    id: 'postgres-mcp',
    name: 'PostgreSQL 数据库 MCP 插件',
    description: '连接远程或本地 PostgreSQL 数据库，进行安全只读/读写查询与表结构反向工程',
    type: 'mcp',
    category: 'database',
    enabled: false,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
  {
    id: 'brave-search-mcp',
    name: 'Brave Search 实时联网检索',
    description: '通过 Brave 搜索引擎实时检索互联网最新技术资讯、文档与报错解决方案',
    type: 'mcp',
    category: 'search',
    enabled: false,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
  },
  {
    id: 'memory-mcp',
    name: '知识图谱持久化记忆 MCP',
    description: '基于 Graph 知识图谱模型，记录用户的项目偏好、技术架构约束与长期上下文',
    type: 'mcp',
    category: 'system',
    enabled: true,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'chrome-devtools',
    name: '浏览器自动化与 DevTools 调试',
    description: '通过 Puppeteer / Chrome 协议进行前端页面排版调试、控制台异常捕获与视觉快照',
    type: 'mcp',
    category: 'browser',
    enabled: false,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    id: 'docker-mcp',
    name: 'Docker 容器与镜像运维 MCP',
    description: '查询本地及远端 Docker 容器运行状态、镜像拉取、Compose 编排与日志排查',
    type: 'mcp',
    category: 'ops',
    enabled: false,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-docker'],
  },
];

const DEFAULT_PERMISSIONS: GuiPermissionConfig = {
  mode: 'full-access', // 默认完完全全放开权限
  allowShell: true,
  allowFsWrite: true,
  allowNetwork: true,
  allowSpawnSubagent: true,
  autoApproveTools: ['*'],
};

function readState(): GuiState {
  ensureDataDir();
  let projects: GuiProject[] = [];
  let hiddenProviders: string[] = [];
  let hiddenModels: string[] = [];
  let skills = DEFAULT_SKILLS;
  let plugins = DEFAULT_PLUGINS;
  let permissions = DEFAULT_PERMISSIONS;

  if (existsSync(STATE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as GuiState;
      projects = Array.isArray(raw.projects) ? raw.projects : [];
      hiddenProviders = Array.isArray(raw.hiddenProviders) ? raw.hiddenProviders : [];
      hiddenModels = Array.isArray(raw.hiddenModels) ? raw.hiddenModels : [];
      if (raw.skills && raw.skills.length > 0) skills = raw.skills;
      if (raw.plugins && raw.plugins.length > 0) {
        // 合并已有与新增的官方预设
        const existingIds = new Set(raw.plugins.map((p) => p.id));
        const merged = [...raw.plugins];
        for (const dp of DEFAULT_PLUGINS) {
          if (!existingIds.has(dp.id)) {
            merged.push(dp);
          }
        }
        plugins = merged;
      }
      if (raw.permissions) permissions = raw.permissions;
    } catch {}
  } else {
    // 仅在首次创建状态文件时，默认初始化当前工作区为初始工程
    const cwd = process.cwd();
    const defaultProject: GuiProject = {
      id: randomUUID(),
      name: basename(cwd) || 'CodexConnect',
      path: cwd,
      addedAt: new Date().toISOString(),
    };
    projects = [defaultProject];
    writeState({
      projects,
      hiddenProviders,
      hiddenModels,
      skills,
      plugins,
      permissions,
    });
  }

  return {
    projects,
    hiddenProviders,
    hiddenModels,
    skills,
    plugins,
    permissions,
  };
}

function writeState(state: GuiState): void {
  ensureDataDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toolsForPermissions(config: GuiPermissionConfig): ResolvedAgent['tools'] {
  if (config.mode === 'strict') {
    return {
      profile: 'minimal',
      allow: ['read_file', 'list_dir', 'search'],
      deny: ['shell', 'open_external', 'write_file', 'apply_patch', 'http_fetch', 'web_search', 'spawn_subagent'],
    };
  }

  const deny: string[] = [];
  if (!config.allowShell) deny.push('shell', 'open_external');
  if (!config.allowFsWrite) deny.push('write_file', 'apply_patch');
  if (!config.allowNetwork) deny.push('http_fetch', 'web_search');
  if (!config.allowSpawnSubagent) deny.push('spawn_subagent');

  return { profile: 'full', allow: ['*'], deny };
}

function mapTarget(target: GuiTarget): InjectionTarget {
  const map: Record<GuiTarget, InjectionTarget> = {
    codex: 'codex',
    claude: 'claude',
    gemini: 'gemini',
    grok: 'grok',
    openclaw: 'openclaw',
  };
  return map[target];
}

function targetPath(target: GuiTarget): string {
  if (target === 'codex') return join(homedir(), '.codex', 'config.toml');
  if (target === 'claude') return join(homedir(), '.claude', 'settings.json');
  if (target === 'gemini') return join(homedir(), '.gemini', 'settings.json');
  if (target === 'grok') return join(homedir(), '.grok', 'config.json');
  return join(homedir(), '.openclaw', 'settings.json');
}

function readOptionalText(path: string | undefined): string {
  if (!path || !existsSync(path)) {
    return '';
  }
  return readFileSync(path, 'utf8');
}

export class GuiService {
  private readonly logs: GuiLogEntry[] = [];
  private readonly providerHealth = new Map<string, { reachable: boolean; checkedAt: number; error?: string }>();
  private readonly botControl = new BotControlFacade({
    dbPath: BOT_CONTROL_DB_PATH,
    credentialsDir: BOT_CREDENTIALS_DIR,
  });
  private activeChatTask: {
    taskId: string;
    controller: AbortController;
    orchestrator: AgentOrchestrator;
  } | null = null;
  private mcpPlaygroundManager?: McpManager;
  private mcpPlaygroundModules?: Map<string, ToolModule>;

  constructor(
    private readonly configPath = resolveConfigPath(undefined, process.env),
  ) {}

  snapshot(): object {
    const loaded = loadConfig({ path: this.configPath });
    const resolver = new ConfigResolver(loaded, {}, process.env);
    const registry = new ProviderRegistry(resolver.resolveProviders(), { env: process.env });
    const state = readState();
    const hiddenProviders = new Set(state.hiddenProviders || []);
    const hiddenModels = new Set(state.hiddenModels || []);

    const providers = [...resolver.resolveProviders().values()]
      .filter((provider) => !hiddenProviders.has(provider.id))
      .map((provider) => {
        const health = this.providerHealth.get(provider.id);
        const fresh = health !== undefined && Date.now() - health.checkedAt <= 60_000;
        const hasCredential = registry.hasCredential(provider);
        return {
          ...provider,
          hasCredential,
          healthStatus: fresh && health.reachable ? 'ok' : hasCredential ? 'unknown' : 'missing_credentials',
          healthCheckedAt: fresh ? new Date(health.checkedAt).toISOString() : undefined,
          healthError: fresh ? health.error : undefined,
        };
      });

    const models = [...resolver.resolveModels().values()]
      .filter((model) => !hiddenModels.has(model.alias) && !hiddenProviders.has(model.providerId));

    const agents = resolver.listAgentIds().map((id) => resolver.resolveAgent(id));
    const configuredDefaultAgent = resolver.resolveDefaultAgentId();
    const defaultAgentId = agents.some((agent) => agent.id === configuredDefaultAgent)
      ? configuredDefaultAgent
      : agents[0]?.id;
    const rawAgents = loaded.config.agents?.entries ?? {};
    return {
      configPath: this.configPath,
      defaultAgentId,
      projects: state.projects,
      providers,
      models,
      skills: state.skills || DEFAULT_SKILLS,
      plugins: state.plugins || DEFAULT_PLUGINS,
      permissions: state.permissions || DEFAULT_PERMISSIONS,
      agents: agents.map((agent) => {
        const raw = rawAgents[agent.id] ?? {};
        const rawModel = raw.model;
        const rawPrimaryModel = typeof rawModel === 'string' ? rawModel : rawModel?.primary;
        const rawFallbackModels = typeof rawModel === 'object' && rawModel !== null ? rawModel.fallbacks ?? [] : [];
        const systemPromptFile = raw.system_prompt_file;
        return {
          id: agent.id,
          name: agent.name,
          displayName: raw.identity?.display_name || agent.identity?.displayName || agent.name,
          emoji: raw.identity?.emoji || agent.identity?.emoji || 'AI',
          description: raw.description ?? agent.description,
          model: rawPrimaryModel ?? '',
          resolvedModel: agent.model.primary,
          fallbackModels: rawFallbackModels,
          utilityModel: raw.utility_model ?? '',
          protocol: raw.protocol ?? '',
          workspace: raw.workspace ?? '',
          resolvedWorkspace: agent.workspace,
          toolTier: raw.tools?.profile ?? agent.tools.profile,
          allowTools: raw.tools?.allow ?? [],
          denyTools: raw.tools?.deny ?? [],
          subagents: raw.subagents?.allow ?? [],
          runtimeMode: raw.runtime?.mode ?? agent.runtime.mode,
          reasoningVisible: raw.reasoning_visible ?? agent.reasoningVisible,
          paramsJson: raw.params !== undefined ? JSON.stringify(raw.params) : '',
          systemPromptFile: systemPromptFile ?? '',
          systemPrompt: readOptionalText(systemPromptFile),
        };
      }),
      targets: this.targetStates(models.map((model) => model.fullName)),
      logs: this.logs.slice(-80),
      servers: RemoteServerStore.getInstance().list(),
      telemetry: this.usageSnapshot(resolver),
      presets: Object.keys(BUILTIN_PROVIDERS).filter((p) => !hiddenProviders.has(p)),
    };
  }

  private usageSnapshot(resolver: ConfigResolver): object {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    const byServer = new Map<string, { serverId: string; totalTokens: number; calls: number }>();
    const byAgent = new Map<string, { agentId: string; totalTokens: number; calls: number }>();

    for (const agentId of resolver.listAgentIds()) {
      const agent = resolver.resolveAgent(agentId);
      const store = new SqliteSessionStore(join(agent.agentDir, 'sessions.db'));
      try {
        const result = store.queryUsage?.({ since: since.toISOString() });
        if (result === undefined) continue;
        totals.promptTokens += result.totals.promptTokens;
        totals.completionTokens += result.totals.completionTokens;
        totals.totalTokens += result.totals.totalTokens;
        totals.calls += result.totals.calls;
        for (const item of result.byServer) {
          const existing = byServer.get(item.serverId) ?? { serverId: item.serverId, totalTokens: 0, calls: 0 };
          existing.totalTokens += item.totalTokens;
          existing.calls += item.calls;
          byServer.set(item.serverId, existing);
        }
        for (const item of result.byAgent) {
          const existing = byAgent.get(item.agentId) ?? { agentId: item.agentId, totalTokens: 0, calls: 0 };
          existing.totalTokens += item.totalTokens;
          existing.calls += item.calls;
          byAgent.set(item.agentId, existing);
        }
      } finally {
        store.close();
      }
    }

    return {
      status: 'ok',
      since: since.toISOString(),
      totals,
      byServer: [...byServer.values()].sort((left, right) => right.totalTokens - left.totalTokens),
      byAgent: [...byAgent.values()].sort((left, right) => right.totalTokens - left.totalTokens),
    };
  }

  async importProject(): Promise<GuiProject | undefined> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return undefined;
    const state = readState();
    const existing = state.projects.find((project) => project.path === path);
    if (existing !== undefined) return existing;
    const project: GuiProject = { id: randomUUID(), name: basename(path), path, addedAt: new Date().toISOString() };
    state.projects.unshift(project);
    writeState(state);
    this.info('已导入项目：' + project.name);
    return project;
  }

  addProject(input: GuiProjectInput): GuiProject {
    const path = input.path.trim();
    if (!path) throw new Error('项目路径不能为空');
    const state = readState();
    const existing = state.projects.find((project) => project.path === path);
    if (existing !== undefined) return existing;
    const project: GuiProject = {
      id: randomUUID(),
      name: input.name?.trim() || basename(path),
      path,
      addedAt: new Date().toISOString(),
    };
    state.projects.unshift(project);
    writeState(state);
    this.info('已添加项目：' + project.name);
    return project;
  }

  removeProject(id: string): object {
    const state = readState();
    const idNorm = id?.trim().toLowerCase().replace(/\\/g, '/');
    state.projects = state.projects.filter((project) => {
      const pIdNorm = project.id?.trim().toLowerCase();
      const pPathNorm = project.path?.trim().toLowerCase().replace(/\\/g, '/');
      return pIdNorm !== idNorm && pPathNorm !== idNorm && project.id !== id && project.path !== id;
    });
    writeState(state);
    this.info('已移除项目：' + id);
    return { ok: true };
  }

  batchRemoveProjects(ids: string[]): object {
    const state = readState();
    const idNormSet = new Set(
      (ids || []).map((i) => i?.trim().toLowerCase().replace(/\\/g, '/'))
    );
    state.projects = state.projects.filter((project) => {
      const pIdNorm = project.id?.trim().toLowerCase();
      const pPathNorm = project.path?.trim().toLowerCase().replace(/\\/g, '/');
      return !idNormSet.has(pIdNorm) && !idNormSet.has(pPathNorm) && !ids.includes(project.id) && !ids.includes(project.path);
    });
    writeState(state);
    this.info(`已批量移除 ${ids.length} 个项目`);
    return { ok: true, count: ids.length };
  }

  async openInVsCode(targetPath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await execa('code', [targetPath]);
      this.info('已在 VS Code 中打开：' + targetPath);
      return { ok: true };
    } catch (codeErr) {
      try {
        const uri = `vscode://file/${targetPath.replace(/\\/g, '/')}`;
        await shell.openExternal(uri);
        this.info('已通过 vscode:// URI 打开：' + targetPath);
        return { ok: true };
      } catch (uriErr) {
        try {
          await shell.openPath(targetPath);
          this.info('已通过系统默认方式打开：' + targetPath);
          return { ok: true };
        } catch (finalErr) {
          const errMsg = describeError(finalErr);
          this.error('打开路径失败：' + errMsg);
          return { ok: false, error: errMsg };
        }
      }
    }
  }

  async openInExplorer(targetPath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await shell.openPath(targetPath);
      this.info('已在文件资源管理器中打开：' + targetPath);
      return { ok: true };
    } catch (err) {
      const errMsg = describeError(err);
      this.error('打开资源管理器失败：' + errMsg);
      return { ok: false, error: errMsg };
    }
  }

  async openInTerminal(targetPath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (process.platform === 'win32') {
        await execa('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', `cd '${targetPath}'`]);
      } else if (process.platform === 'darwin') {
        await execa('open', ['-a', 'Terminal', targetPath]);
      } else {
        await execa('x-terminal-emulator', ['--working-directory', targetPath]);
      }
      this.info('已在终端中打开项目目录：' + targetPath);
      return { ok: true };
    } catch (err) {
      const errMsg = describeError(err);
      this.error('打开终端失败：' + errMsg);
      return { ok: false, error: errMsg };
    }
  }

  upsertProvider(input: GuiProviderInput): object {
    const id = input.id.trim();
    if (!id) throw new Error('服务商 ID 不能为空');
    const baseUrl = input.baseUrl.trim();
    if (!baseUrl) throw new Error('Base URL 不能为空');

    const envKey = input.envKey?.trim() || `${id.toUpperCase()}_API_KEY`;

    const resolver = this.resolver();
    const existing = resolver.resolveProviders().get(id);
    const oldEnvKey = existing?.envKey;

    if (input.apiKey && input.apiKey.trim()) {
      let trimmedKey = input.apiKey.trim();
      if ((trimmedKey.startsWith('"') && trimmedKey.endsWith('"')) || (trimmedKey.startsWith("'") && trimmedKey.endsWith("'"))) {
        trimmedKey = trimmedKey.slice(1, -1).trim();
      }
      if (trimmedKey.startsWith('Bearer ')) {
        trimmedKey = trimmedKey.slice(7).trim();
      }
      process.env[envKey] = trimmedKey;
      const saved = readSavedEnv();
      saved[envKey] = trimmedKey;
      writeSavedEnv(saved);
    }

    const patch: ProviderPatch = {
      base_url: baseUrl,
      env_key: envKey,
      wire_api: input.wireApi,
      default_protocol: input.protocol,
    };
    if (input.name && input.name.trim()) patch.name = input.name.trim();

    const writer = new ConfigWriter(this.configPath);
    writer.upsertProvider(id, patch);

    const state = readState();
    if (state.hiddenProviders?.includes(id)) {
      state.hiddenProviders = state.hiddenProviders.filter((p) => p !== id);
      writeState(state);
    }

    this.info('已保存服务商：' + id);
    return { ok: true };
  }

  removeProvider(id: string): object {
    const state = readState();
    state.hiddenProviders = Array.from(new Set([...(state.hiddenProviders || []), id]));
    writeState(state);

    const writer = new ConfigWriter(this.configPath);
    try {
      writer.removeProvider(id);
    } catch {
      // 允许预置项不存在于 config.toml 中
    }
    this.info('已删除服务商：' + id);
    return { ok: true };
  }

  batchRemoveProviders(ids: string[]): object {
    const state = readState();
    state.hiddenProviders = Array.from(new Set([...(state.hiddenProviders || []), ...ids]));
    writeState(state);

    const writer = new ConfigWriter(this.configPath);
    for (const id of ids) {
      try {
        writer.removeProvider(id);
      } catch {
        // 忽略
      }
    }
    this.info(`已批量删除 ${ids.length} 个服务商`);
    return { ok: true, count: ids.length };
  }

  upsertModel(input: GuiModelInput): object {
    const alias = input.alias.trim();
    if (!alias) throw new Error('模型别名不能为空');
    const provider = input.provider.trim();
    if (!provider) throw new Error('所属服务商不能为空');
    const model = input.model.trim();
    if (!model) throw new Error('模型真实名称不能为空');

    const patch: ModelPatch = {
      provider,
      model,
      context_window: input.contextWindow,
      max_output_tokens: input.maxOutputTokens,
      protocol: input.protocol,
    };
    const writer = new ConfigWriter(this.configPath);
    writer.upsertModel(alias, patch);

    const state = readState();
    if (state.hiddenModels?.includes(alias)) {
      state.hiddenModels = state.hiddenModels.filter((m) => m !== alias);
      writeState(state);
    }

    this.info('已保存模型：' + alias);
    return { ok: true };
  }

  removeModel(alias: string): object {
    const state = readState();
    state.hiddenModels = Array.from(new Set([...(state.hiddenModels || []), alias]));
    writeState(state);

    const writer = new ConfigWriter(this.configPath);
    try {
      writer.removeModel(alias);
    } catch {
      // 允许预置项不存在于 config.toml 中
    }
    this.info('已删除模型：' + alias);
    return { ok: true };
  }

  batchRemoveModels(aliases: string[]): object {
    const state = readState();
    state.hiddenModels = Array.from(new Set([...(state.hiddenModels || []), ...aliases]));
    writeState(state);

    const writer = new ConfigWriter(this.configPath);
    for (const alias of aliases) {
      try {
        writer.removeModel(alias);
      } catch {
        // 忽略
      }
    }
    this.info(`已批量删除 ${aliases.length} 个模型`);
    return { ok: true, count: aliases.length };
  }

  upsertAgent(input: GuiAgentInput): object {
    const result = upsertGuiAgent(this.configPath, input);
    const id = input.id.trim();
    this.info('已更新智能体配置：' + id);
    return result;
  }

  removeAgent(rawId: string): object {
    const id = rawId.trim();
    const result = removeGuiAgent(this.configPath, id);
    this.info('已删除智能体配置：' + id);
    return result;
  }

  getEnvVars(): { list: GuiEnvVarItem[]; totalSet: number } {
    const saved = readSavedEnv();
    const allMerged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && v.trim() !== '') {
        allMerged[k] = v;
      }
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v && v.trim() !== '') {
        allMerged[k] = v;
      }
    }

    const items: GuiEnvVarItem[] = [];
    const handledKeys = new Set<string>();

    for (const meta of KNOWN_ENV_METADATA) {
      handledKeys.add(meta.key);
      const val = allMerged[meta.key] || '';
      const isSet = Boolean(val && val.trim() !== '');
      items.push({
        key: meta.key,
        label: meta.label,
        desc: meta.desc,
        value: val,
        isSet,
        category: meta.category,
      });
    }

    // 追加其他动态发现的 API Key 或自定义变量
    for (const [key, value] of Object.entries(allMerged)) {
      if (handledKeys.has(key)) continue;
      if (
        key.endsWith('_API_KEY') ||
        key.endsWith('_TOKEN') ||
        key.endsWith('_SECRET') ||
        key.startsWith('HAP_') ||
        saved[key] !== undefined
      ) {
        items.push({
          key,
          label: `自定义环境变量 (${key})`,
          desc: '用户自定义配置的环境变量',
          value,
          isSet: Boolean(value && value.trim() !== ''),
          category: 'custom',
        });
      }
    }

    const totalSet = items.filter((item) => item.isSet).length;
    return { list: items, totalSet };
  }

  saveEnvVar(input: { key: string; value: string }): { ok: boolean; key: string } {
    const key = input.key.trim();
    if (!key) throw new Error('环境变量名不能为空');
    let value = input.value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (value.startsWith('Bearer ')) {
      value = value.slice(7).trim();
    }

    process.env[key] = value;
    const saved = readSavedEnv();
    saved[key] = value;
    writeSavedEnv(saved);
    this.info(`已更新环境变量：${key}`);
    return { ok: true, key };
  }

  deleteEnvVar(key: string): { ok: boolean } {
    const trimmed = key.trim();
    delete process.env[trimmed];
    const saved = readSavedEnv();
    delete saved[trimmed];
    writeSavedEnv(saved);
    this.info(`已移除环境变量：${trimmed}`);
    return { ok: true };
  }

  batchSaveEnvVars(entries: Record<string, string>): { ok: boolean; count: number } {
    const saved = readSavedEnv();
    let count = 0;
    for (const [k, v] of Object.entries(entries)) {
      const key = k.trim();
      if (!key) continue;
      let val = String(v).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim();
      }
      if (val.startsWith('Bearer ')) {
        val = val.slice(7).trim();
      }
      process.env[key] = val;
      saved[key] = val;
      count++;
    }
    writeSavedEnv(saved);
    this.info(`批量保存了 ${count} 项环境变量`);
    return { ok: true, count };
  }

  getProviderApiKey(providerId: string): { envKey: string; isSet: boolean; maskedValue: string; value: string } {
    const resolver = this.resolver();
    const existing = resolver.resolveProviders().get(providerId);
    const envKey = existing?.envKey || `${providerId.toUpperCase()}_API_KEY`;
    const saved = readSavedEnv();
    const rawVal = process.env[envKey] || saved[envKey] || (existing?.envKey ? process.env[existing.envKey] : '') || process.env[`${providerId.toUpperCase()}_API_KEY`] || '';
    const isSet = Boolean(rawVal && rawVal.trim() !== '');
    return {
      envKey,
      isSet,
      maskedValue: isSet ? maskApiKey(rawVal) : '',
      value: rawVal,
    };
  }

  async testProvider(idOrConfig: string | GuiProviderTestInput): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      if (typeof idOrConfig === 'string') {
        const id = idOrConfig;
        const resolver = this.resolver();
        const registry = new ProviderRegistry(resolver.resolveProviders(), { env: process.env });
        const result = await registry.check(id, controller.signal);
        this.providerHealth.set(id, { reachable: result.reachable, checkedAt: Date.now(), ...(result.error === undefined ? {} : { error: result.error }) });
        if (result.reachable) {
          this.info(`测试服务商 ${id}：可达`);
        } else {
          this.error(`测试服务商 ${id}：${result.error ?? '连接失败'}`);
        }
        return { ...result };
      }

      const config = idOrConfig;
      const id = config.id?.trim() || 'custom';
      const baseUrl = config.baseUrl?.trim() || '';
      const testModel = config.model?.trim() || '';
      if (!baseUrl) {
        return { providerId: id, reachable: false, error: '未配置 Base URL' };
      }
      if (!testModel) {
        return { providerId: id, reachable: false, error: '请先指定要测试的模型 ID' };
      }

      const resolver = this.resolver();
      const existing = resolver.resolveProviders().get(id);
      const envKey = config.envKey?.trim() || existing?.envKey || `${id.toUpperCase()}_API_KEY`;
      const saved = readSavedEnv();
      const apiKey = config.apiKey?.trim() || (existing?.envKey ? process.env[existing.envKey] || saved[existing.envKey] : undefined) || process.env[envKey] || saved[envKey] || process.env[`${id.toUpperCase()}_API_KEY`];
      const wireApi = (config.wireApi || existing?.wireApi || 'chat') as WireApi;
      const defaultProtocol = (config.protocol || existing?.defaultProtocol || 'openai-tools') as ProtocolName;

      const tempProvider: ResolvedProvider = {
        id,
        name: id,
        baseUrl,
        envKey: apiKey ? envKey : undefined,
        wireApi,
        defaultProtocol,
        httpHeaders: existing?.httpHeaders || {},
        envHttpHeaders: existing?.envHttpHeaders || {},
        requestMaxRetries: 1,
        streamMaxRetries: 1,
        streamIdleTimeoutMs: 10_000,
        maxTokensDefault: 4096,
      };

      const tempEnv: Record<string, string> = { ...process.env as Record<string, string> };
      if (apiKey) {
        tempEnv[envKey] = apiKey;
      }

      const tempMap = new Map<string, ResolvedProvider>([[id, tempProvider]]);
      const registry = new ProviderRegistry(tempMap, { env: tempEnv });
      const started = Date.now();
      let received = false;
      for await (const event of registry.client(id).send({ model: testModel, messages: [{ role: 'user', content: 'Reply with OK.' }], params: {}, maxTokens: 16 }, controller.signal)) {
        if (event.type === 'text_delta' || event.type === 'finish') received = true;
      }
      const result = { providerId: id, reachable: received, handshakeMs: Date.now() - started, models: [testModel], ...(received ? {} : { error: '模型未返回有效响应' }) };
      this.providerHealth.set(id, { reachable: result.reachable, checkedAt: Date.now(), ...(result.error === undefined ? {} : { error: result.error }) });
      if (result.reachable) {
        this.info(`测试服务商 ${id} (实时动态参数)：可达`);
      } else {
        this.error(`测试服务商 ${id} (实时动态参数)：${result.error ?? '连接失败'}`);
      }
      return { ...result };
    } catch (err) {
      const msg = describeError(err);
      const isTimeout = msg.includes('aborted') || msg.includes('timeout') || controller.signal.aborted;
      const errorText = isTimeout ? '网络连接超时 (10s)，未能收到端点响应' : msg;
      return {
        providerId: typeof idOrConfig === 'string' ? idOrConfig : idOrConfig.id,
        reachable: false,
        error: errorText,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async generateImage(input: GuiImageGenInput): Promise<GuiImageGenResult> {
    const prompt = input.prompt?.trim();
    if (!prompt) {
      return { ok: false, prompt: '', width: 1024, height: 1024, engineUsed: '', error: '提示词 (Prompt) 不能为空' };
    }

    ensureDataDir();
    const state = readState();
    const workspace = input.workspace || (state.projects[0]?.path) || DATA_DIR;
    const targetDir = existsSync(workspace) ? join(workspace, 'generated_images') : IMAGES_DIR;
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const timestamp = Date.now();
    const fileName = (input.outputFileName || `ai_image_${timestamp}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const localFilePath = resolvePath(targetDir, fileName);

    let width = 1024;
    let height = 1024;
    if (input.size === '512x512') { width = 512; height = 512; }
    else if (input.size === '1024x1792' || input.aspectRatio === '9:16') { width = 1024; height = 1792; }
    else if (input.size === '1792x1024' || input.aspectRatio === '16:9') { width = 1792; height = 1024; }
    else if (input.size === '1024x768' || input.aspectRatio === '4:3') { width = 1024; height = 768; }
    else if (input.size === '768x1024' || input.aspectRatio === '3:4') { width = 768; height = 1024; }

    const resolver = this.resolver();
    const allProviders = resolver.resolveProviders();
    const savedEnv = readSavedEnv();

    // 确定使用的服务商与模型
    const providerId = input.providerId?.trim() || '';
    let model = input.model?.trim() || '';
    let baseUrl = input.customBaseUrl?.trim() || '';
    let apiKey = input.customApiKey?.trim() || '';

    if (providerId && providerId !== 'pollinations' && providerId !== 'custom' && providerId !== 'auto') {
      const p = allProviders.get(providerId);
      if (p) {
        if (!baseUrl) baseUrl = p.baseUrl;
        if (!apiKey) {
          apiKey = (p.envKey ? process.env[p.envKey] || savedEnv[p.envKey] : undefined) || process.env[`${providerId.toUpperCase()}_API_KEY`] || '';
        }
      }
    }

    // 兜底自动检测凭据
    if (!baseUrl && !apiKey) {
      if (model.startsWith('dall-e') || input.engine === 'dalle3') {
        baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        apiKey = process.env.OPENAI_API_KEY || savedEnv['OPENAI_API_KEY'] || '';
      } else if (model.includes('FLUX') || model.includes('stabilityai') || providerId === 'siliconflow') {
        baseUrl = process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';
        apiKey = process.env.SILICONFLOW_API_KEY || savedEnv['SILICONFLOW_API_KEY'] || '';
      } else if (model.startsWith('cogview') || providerId === 'zhipu') {
        baseUrl = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
        apiKey = process.env.ZHIPU_API_KEY || savedEnv['ZHIPU_API_KEY'] || '';
      }
    }

    let usedEngine = '';

    // 方案 A: 走 OpenAI 兼容标准生图接口 (POST /v1/images/generations)
    // 支持 OpenAI DALL-E 3/2, 硅基流动 Flux / SD3, 智谱 CogView, 通义万相, OneAPI/NewAPI 等
    if (baseUrl && apiKey && providerId !== 'pollinations') {
      usedEngine = `${providerId || 'AI 服务商'} (${model || 'dall-e-3'})`;
      try {
        const cleanBase = baseUrl.replace(/\/+$/, '');
        const endpoint = cleanBase.endsWith('/v1') ? `${cleanBase}/images/generations` : `${cleanBase}/v1/images/generations`;

        const sizeStr = input.size === '1024x1792' ? '1024x1792' : input.size === '1792x1024' ? '1792x1024' : '1024x1024';
        const styleDesc = input.style ? `${input.style} style, ` : '';
        const fullPrompt = `${prompt}${styleDesc ? ` (${styleDesc.trim()})` : ''}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 40000);

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            prompt: fullPrompt,
            model: model || 'dall-e-3',
            n: 1,
            size: sizeStr,
            style: input.style === 'natural' ? 'natural' : 'vivid',
            response_format: 'b64_json',
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`服务商接口返回 HTTP ${res.status}: ${errText.slice(0, 160)}`);
        }

        const data = await res.json() as { data?: Array<{ url?: string; b64_json?: string }> };
        if (data.data?.[0]?.b64_json) {
          const buf = Buffer.from(data.data[0].b64_json, 'base64');
          writeFileSync(localFilePath, buf);
          const normPath = localFilePath.replace(/\\/g, '/');
          this.info(`已成功通过 ${usedEngine} 生成图像：${fileName}`);
          return {
            ok: true,
            imageUrl: `file:///${normPath}`,
            localFilePath,
            localUri: `file:///${normPath}`,
            prompt,
            width,
            height,
            engineUsed: usedEngine,
          };
        } else if (data.data?.[0]?.url) {
          const downloadUrl = data.data[0].url;
          try {
            const dlController = new AbortController();
            const dlTimeout = setTimeout(() => dlController.abort(), 25000);
            const imgRes = await fetch(downloadUrl, { signal: dlController.signal }).finally(() => clearTimeout(dlTimeout));
            if (imgRes.ok) {
              const arrayBuf = await imgRes.arrayBuffer();
              writeFileSync(localFilePath, Buffer.from(arrayBuf));
            }
          } catch {
            // 允许使用直链
          }
          const normPath = localFilePath.replace(/\\/g, '/');
          const finalUri = existsSync(localFilePath) ? `file:///${normPath}` : downloadUrl;
          return {
            ok: true,
            imageUrl: finalUri,
            localFilePath: existsSync(localFilePath) ? localFilePath : undefined,
            localUri: finalUri,
            prompt,
            width,
            height,
            engineUsed: usedEngine,
          };
        } else {
          throw new Error('服务商响应数据未包含有效图像 (缺少 url 或 b64_json)');
        }
      } catch (provErr) {
        const errorMsg = describeError(provErr);
        this.error(`使用 ${usedEngine} 生图失败：${errorMsg}`);
        if (providerId !== 'auto' && providerId !== '') {
          return {
            ok: false,
            prompt,
            width,
            height,
            engineUsed: usedEngine,
            error: `${usedEngine} 生图失败：${errorMsg}。请检查服务商 API Key、Base URL 是否支持生图接口，或切换为免 Key 极速引擎。`,
          };
        }
      }
    }

    // 方案 B: Pollinations AI (免 Key Flux / Turbo / SDXL 极速引擎，带严谨超时防护)
    const pollinationsModel = (model === 'turbo' || model === 'sdxl') ? model : 'flux';
    usedEngine = `Pollinations AI (${pollinationsModel})`;
    const styleDesc = input.style ? `${input.style} style, ` : '';
    const encodedPrompt = encodeURIComponent(`${prompt}, ${styleDesc}high quality, masterpiece, detailed, 8k resolution`);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=${pollinationsModel}&nologo=true&seed=${timestamp % 100000}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const imgRes = await fetch(imageUrl, { method: 'GET', signal: controller.signal }).finally(() => clearTimeout(timeoutId));
      if (imgRes.ok) {
        const arrayBuf = await imgRes.arrayBuffer();
        writeFileSync(localFilePath, Buffer.from(arrayBuf));
        this.info(`Pollinations 图像已下载并持久化至：${localFilePath}`);
      } else {
        throw new Error(`HTTP ${imgRes.status} ${imgRes.statusText}`);
      }
    } catch (saveErr) {
      const errMsg = describeError(saveErr);
      this.error(`Pollinations 图像获取失败：${errMsg}`);
      return {
        ok: false,
        prompt,
        width,
        height,
        engineUsed: usedEngine,
        error: `免 Key 生图引擎连接失败或超时（${errMsg}）。通常因国际网络波动，建议在模型下拉框中选择已配置的 AI 服务商（如 OpenAI / SiliconFlow / 智谱）并配置对应 API Key。`,
      };
    }

    const normPath = localFilePath.replace(/\\/g, '/');
    const localUri = existsSync(localFilePath) ? `file:///${normPath}` : imageUrl;

    return {
      ok: true,
      imageUrl: localUri,
      localFilePath: existsSync(localFilePath) ? localFilePath : undefined,
      localUri,
      prompt,
      width,
      height,
      engineUsed: usedEngine,
    };
  }

  async fetchProviderModels(providerId: string, customOptions?: { baseUrl?: string; apiKey?: string; wireApi?: string; protocol?: string }): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const resolver = this.resolver();
      const existing = resolver.resolveProviders().get(providerId);

      const baseUrl = customOptions?.baseUrl || existing?.baseUrl;
      const envKey = existing?.envKey || `${providerId.toUpperCase()}_API_KEY`;
      const saved = readSavedEnv();
      const apiKey = customOptions?.apiKey || (existing?.envKey ? process.env[existing.envKey] || saved[existing.envKey] : undefined) || process.env[envKey] || saved[envKey] || process.env[`${providerId.toUpperCase()}_API_KEY`];

      if (!baseUrl) return { ok: false, models: [], error: '未配置 Base URL' };

      const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
      const modelsEndpoint = cleanBaseUrl.endsWith('/v1') ? `${cleanBaseUrl}/models` : `${cleanBaseUrl}/v1/models`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        let cleanKey = apiKey.trim();
        if ((cleanKey.startsWith('"') && cleanKey.endsWith('"')) || (cleanKey.startsWith("'") && cleanKey.endsWith("'"))) {
          cleanKey = cleanKey.slice(1, -1).trim();
        }
        if (cleanKey.startsWith('Bearer ')) {
          cleanKey = cleanKey.slice(7).trim();
        }
        headers['Authorization'] = `Bearer ${cleanKey}`;
      }

      if (providerId === 'anthropic' || cleanBaseUrl.includes('anthropic')) {
        if (apiKey) headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }

      const res = await fetch(modelsEndpoint, { headers, method: 'GET', signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, models: [], error: `远端返回 HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}` };
      }

      const json = await res.json() as { data?: Array<{ id?: string; name?: string }> | Record<string, unknown> };
      if (json.data && Array.isArray(json.data)) {
        const list = json.data.map((item) => item.id || item.name).filter((x): x is string => Boolean(x));
        this.info(`成功从 ${providerId} 拉取到 ${list.length} 个在线模型`);
        return { ok: true, models: list };
      } else if (Array.isArray(json)) {
        const list = json.map((item) => (typeof item === 'string' ? item : item.id || item.name)).filter((x): x is string => Boolean(x));
        return { ok: true, models: list };
      }
      return { ok: false, models: [], error: '响应格式中未包含标准的 models 数组列表' };
    } catch (err) {
      const msg = describeError(err);
      const isTimeout = msg.includes('aborted') || msg.includes('timeout') || controller.signal.aborted;
      const errorText = isTimeout ? '请求远端模型列表超时 (12s)，请检查服务商地址是否可达或网络防火墙状态' : msg;
      this.error(`拉取 ${providerId} 模型失败：${errorText}`);
      return { ok: false, models: [], error: errorText };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==========================================================================
  // Skill 市场服务 (关联 GitHub 开源市场)
  // ==========================================================================

  listSkills(): GuiSkill[] {
    const state = readState();
    return state.skills || DEFAULT_SKILLS;
  }

  installSkill(repoUrl: string): GuiSkill {
    const cleanRepo = repoUrl.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    if (!cleanRepo) throw new Error('GitHub 仓库地址不能为空');

    const state = readState();
    const skills = state.skills || DEFAULT_SKILLS;
    const name = cleanRepo.split('/').pop() || cleanRepo;
    const id = cleanRepo.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    const existing = skills.find((s) => s.id === id || s.repo.toLowerCase() === cleanRepo.toLowerCase());
    if (existing) {
      existing.installed = true;
      existing.enabled = true;
      writeState(state);
      this.info(`已更新并启用 Skill: ${existing.name}`);
      return existing;
    }

    const newSkill: GuiSkill = {
      id,
      name: name.replace(/[-_]/g, ' '),
      description: `从 GitHub (${cleanRepo}) 安装的技能扩展模块`,
      repo: cleanRepo,
      author: cleanRepo.split('/')[0] || 'GitHub',
      stars: 100,
      tags: ['Community', 'GitHub'],
      installed: true,
      enabled: true,
      version: '1.0.0',
    };
    skills.unshift(newSkill);
    state.skills = skills;
    writeState(state);
    this.info(`已从 GitHub 成功安装 Skill: ${newSkill.name} (${cleanRepo})`);
    return newSkill;
  }

  toggleSkill(id: string, enabled: boolean): object {
    const state = readState();
    const skill = (state.skills || []).find((s) => s.id === id);
    if (skill) {
      skill.enabled = enabled;
      writeState(state);
      this.info(`已${enabled ? '启用' : '禁用'} Skill: ${skill.name}`);
    }
    return { ok: true };
  }

  uninstallSkill(id: string): object {
    const state = readState();
    state.skills = (state.skills || []).filter((s) => s.id !== id);
    writeState(state);
    this.info(`已卸载 Skill: ${id}`);
    return { ok: true };
  }

  // ==========================================================================
  // 插件市场服务 (MCP / Builtin Plugins)
  // ==========================================================================

  listPlugins(): GuiPlugin[] {
    const state = readState();
    return state.plugins || DEFAULT_PLUGINS;
  }

  togglePlugin(id: string, enabled: boolean): object {
    const state = readState();
    const plugin = (state.plugins || []).find((p) => p.id === id);
    if (plugin) {
      plugin.enabled = enabled;
      writeState(state);
      this.info(`已${enabled ? '启用' : '停用'} 插件: ${plugin.name}`);
    }
    return { ok: true };
  }

  upsertPlugin(plugin: GuiPlugin): object {
    const state = readState();
    const plugins = state.plugins || DEFAULT_PLUGINS;
    const idx = plugins.findIndex((p) => p.id === plugin.id);
    if (idx >= 0) {
      plugins[idx] = plugin;
    } else {
      plugins.push(plugin);
    }
    state.plugins = plugins;
    writeState(state);
    this.info(`已保存插件配置: ${plugin.name}`);
    return { ok: true };
  }

  // ==========================================================================
  // 权限控制体系 (全放开权限 / 确认模式)
  // ==========================================================================

  getPermissions(): GuiPermissionConfig {
    const state = readState();
    return state.permissions || DEFAULT_PERMISSIONS;
  }

  updatePermissions(config: GuiPermissionConfig): object {
    const state = readState();
    state.permissions = config;
    writeState(state);
    this.info(`已更新权限策略：${config.mode === 'full-access' ? '完完全全放开权限（全自主执行）' : config.mode}`);
    return { ok: true };
  }

  async getGitStatus(projectPath: string): Promise<GuiGitStatus> {
    if (!projectPath || !existsSync(projectPath)) {
      return {
        isRepo: false,
        branch: '',
        changedFiles: [],
        uncommittedCount: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        recentCommits: [],
      } satisfies GuiGitStatus;
    }

    try {
      await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
    } catch {
      return {
        isRepo: false,
        branch: '',
        changedFiles: [],
        uncommittedCount: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        recentCommits: [],
      };
    }

    let branch = 'main';
    try {
      const bRes = await execa('git', ['branch', '--show-current'], { cwd: projectPath });
      branch = bRes.stdout.trim() || 'HEAD';
    } catch {}

    let remoteUrl: string | undefined;
    try {
      const rRes = await execa('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
      remoteUrl = rRes.stdout.trim() || undefined;
    } catch {}

    // 解析 numstat 获取每个文件的增删行数
    const numstatMap = new Map<string, { additions: number; deletions: number }>();
    try {
      const numstatRes = await execa('git', ['diff', 'HEAD', '--numstat'], { cwd: projectPath });
      const numstatLines = numstatRes.stdout.split('\n').filter(Boolean);
      for (const line of numstatLines) {
        const parts = line.split('\t');
        if (parts.length >= 3 && parts[2] !== undefined) {
          const adds = Number(parts[0]) || 0;
          const dels = Number(parts[1]) || 0;
          const file = parts[2].trim();
          numstatMap.set(file, { additions: adds, deletions: dels });
        }
      }
    } catch {
      try {
        const fallbackNumstat = await execa('git', ['diff', '--numstat'], { cwd: projectPath });
        const numstatLines = fallbackNumstat.stdout.split('\n').filter(Boolean);
        for (const line of numstatLines) {
          const parts = line.split('\t');
          if (parts.length >= 3 && parts[2] !== undefined) {
            const adds = Number(parts[0]) || 0;
            const dels = Number(parts[1]) || 0;
            const file = parts[2].trim();
            numstatMap.set(file, { additions: adds, deletions: dels });
          }
        }
      } catch {}
    }

    const changedFiles: Array<{ status: string; file: string; additions: number; deletions: number }> = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    try {
      const sRes = await execa('git', ['status', '--porcelain'], { cwd: projectPath });
      const lines = sRes.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      for (const line of lines) {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3).trim();

        let adds = 0;
        let dels = 0;

        if (numstatMap.has(file)) {
          const stat = numstatMap.get(file)!;
          adds = stat.additions;
          dels = stat.deletions;
        } else if (status.includes('?') || status.includes('A')) {
          // untracked 或新添加文件计算实际行数
          const fullPath = join(projectPath, file);
          if (existsSync(fullPath)) {
            try {
              const fileContent = readFileSync(fullPath, 'utf8');
              adds = fileContent.split('\n').length;
            } catch {}
          }
        }

        totalAdditions += adds;
        totalDeletions += dels;

        changedFiles.push({
          status,
          file,
          additions: adds,
          deletions: dels,
        });
      }
    } catch {}

    const recentCommits: Array<{ hash: string; message: string }> = [];
    try {
      const logRes = await execa('git', ['log', '-n', '5', '--oneline'], { cwd: projectPath });
      const lines = logRes.stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
          recentCommits.push({
            hash: line.slice(0, spaceIdx),
            message: line.slice(spaceIdx + 1),
          });
        }
      }
    } catch {}

    return {
      isRepo: true,
      branch,
      remoteUrl,
      changedFiles,
      uncommittedCount: changedFiles.length,
      totalAdditions,
      totalDeletions,
      recentCommits,
    };
  }

  async gitCommit(projectPath: string, message: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    if (!message || !message.trim()) throw new Error('Commit message 不能为空');

    await execa('git', ['add', '-A'], { cwd: projectPath });
    const res = await execa('git', ['commit', '-m', message.trim()], { cwd: projectPath });
    this.info(`Git 提交成功 [${projectPath}]: ${message.trim()}`);
    return { ok: true, summary: res.stdout || '提交成功' };
  }

  async gitPush(projectPath: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    const res = await execa('git', ['push'], { cwd: projectPath });
    this.info(`Git 推送成功 [${projectPath}]`);
    return { ok: true, summary: res.stdout || res.stderr || '推送成功' };
  }

  async gitPull(projectPath: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    const res = await execa('git', ['pull'], { cwd: projectPath });
    this.info(`Git 拉取成功 [${projectPath}]`);
    return { ok: true, summary: res.stdout || res.stderr || '拉取完成' };
  }

  async gitInit(projectPath: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    const res = await execa('git', ['init'], { cwd: projectPath });
    this.info(`Git 初始化成功 [${projectPath}]`);
    return { ok: true, summary: res.stdout || '初始化成功' };
  }

  async gitDiff(projectPath: string, file?: string): Promise<{ ok: boolean; diff: string }> {
    if (!projectPath || !existsSync(projectPath)) {
      throw new Error('未指定有效项目路径');
    }

    try {
      const args = ['diff'];
      if (file && file.trim()) {
        args.push('HEAD', '--', file.trim());
      } else {
        args.push('HEAD');
      }

      try {
        const res = await execa('git', args, { cwd: projectPath });
        if (res.stdout.trim()) {
          return { ok: true, diff: res.stdout };
        }
      } catch {
        const fallbackRes = await execa('git', file ? ['diff', '--', file.trim()] : ['diff'], { cwd: projectPath });
        if (fallbackRes.stdout.trim()) {
          return { ok: true, diff: fallbackRes.stdout };
        }
      }

      if (file && file.trim()) {
        const fullFilePath = join(projectPath, file.trim());
        if (existsSync(fullFilePath)) {
          const content = readFileSync(fullFilePath, 'utf8');
          const lines = content.split('\n').map((l) => `+ ${l}`).join('\n');
          return {
            ok: true,
            diff: `--- /dev/null\n+++ b/${file.trim()}\n@@ -0,0 +1,${content.split('\n').length} @@\n${lines}`,
          };
        }
      }

      return { ok: true, diff: '（当前文件暂无变更差异代码）' };
    } catch (error) {
      return { ok: false, diff: describeError(error) };
    }
  }

  async getVisualDiff(projectPath: string, file?: string): Promise<{ ok: boolean; files: FileDiffItem[]; rawDiff: string }> {
    const rawRes = await this.gitDiff(projectPath, file);
    const rawDiff = rawRes.diff || '';
    const files = parseUnifiedDiff(rawDiff);
    return { ok: true, files, rawDiff };
  }

  async revertFileDiff(projectPath: string, file: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !file) throw new Error('参数缺失');
    try {
      await execa('git', ['checkout', 'HEAD', '--', file], { cwd: projectPath });
      this.info(`已回滚文件变更: ${file}`);
      return { ok: true, message: `已成功还原 ${file}` };
    } catch {
      try {
        await execa('git', ['checkout', '--', file], { cwd: projectPath });
        this.info(`已回滚文件变更: ${file}`);
        return { ok: true, message: `已成功还原 ${file}` };
      } catch (err) {
        throw new Error(`回滚失败: ${describeError(err)}`);
      }
    }
  }

  async stageFileDiff(projectPath: string, file: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !file) throw new Error('参数缺失');
    await execa('git', ['add', file], { cwd: projectPath });
    this.info(`已暂存文件: ${file}`);
    return { ok: true, message: `已成功暂存 ${file}` };
  }

  async stageHunk(projectPath: string, file: string, patch: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !patch) throw new Error('参数缺失：项目路径或 Diff 补丁内容为空');
    try {
      await execa('git', ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], {
        cwd: projectPath,
        input: patch,
      });
      this.info(`已成功暂存代码块: ${file}`);
      return { ok: true, message: `已成功暂存 ${file} 该代码块` };
    } catch {
      try {
        await execa('git', ['apply', '--cached', '--whitespace=nowarn', '-'], {
          cwd: projectPath,
          input: patch,
        });
        this.info(`已成功暂存代码块: ${file}`);
        return { ok: true, message: `已成功暂存 ${file} 该代码块` };
      } catch (err) {
        throw new Error(`暂存代码块失败: ${describeError(err)}`);
      }
    }
  }

  async revertHunk(projectPath: string, file: string, patch: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !patch) throw new Error('参数缺失：项目路径或 Diff 补丁内容为空');
    try {
      await execa('git', ['apply', '--reverse', '--unidiff-zero', '--whitespace=nowarn', '-'], {
        cwd: projectPath,
        input: patch,
      });
      this.info(`已成功还原代码块: ${file}`);
      return { ok: true, message: `已成功还原 ${file} 该代码块` };
    } catch {
      try {
        await execa('git', ['apply', '--reverse', '--whitespace=nowarn', '-'], {
          cwd: projectPath,
          input: patch,
        });
        this.info(`已成功还原代码块: ${file}`);
        return { ok: true, message: `已成功还原 ${file} 该代码块` };
      } catch (err) {
        throw new Error(`还原代码块失败: ${describeError(err)}`);
      }
    }
  }

  listSchedules(): ScheduleJobConfig[] {
    return ScheduleStore.getInstance().listJobs();
  }

  upsertSchedule(input: Partial<ScheduleJobConfig> & { name: string; cron: string; prompt: string }): ScheduleJobConfig {
    const job = ScheduleStore.getInstance().upsertJob(input);
    this.info(`定时任务已保存: ${job.name} (${job.cron})`);
    return job;
  }

  removeSchedule(id: string): { ok: boolean } {
    const ok = ScheduleStore.getInstance().removeJob(id);
    this.info(`已删除定时任务: ${id}`);
    return { ok };
  }

  toggleSchedule(id: string, enabled?: boolean): ScheduleJobConfig | undefined {
    const job = ScheduleStore.getInstance().toggleJob(id, enabled);
    this.info(`定时任务 [${job?.name}] 状态: ${job?.enabled ? '启用' : '暂停'}`);
    return job;
  }

  async runScheduleNow(id: string): Promise<ScheduleExecutionRecord> {
    const engine = SchedulerEngine.getInstance({
      configPath: this.configPath,
      log: (line) => this.info(line),
    });
    return engine.runJobNow(id);
  }

  getScheduleHistory(scheduleId?: string): ScheduleExecutionRecord[] {
    return ScheduleStore.getInstance().getHistory(scheduleId);
  }

  // 长期记忆管理
  listMemories(category?: string): MemoryCard[] {
    return MemoryStore.getInstance().listMemories(category);
  }

  async addMemory(input: {
    category: MemoryCard['category'];
    title: string;
    content: string;
    tags?: string[];
    workspace?: string;
  }): Promise<MemoryCard> {
    const card = await MemoryStore.getInstance().addMemory(input);
    this.info(`已存入长期记忆: [${card.category}] ${card.title}`);
    return card;
  }

  async searchMemories(query: string, limit: number = 5) {
    return MemoryStore.getInstance().searchMemories({ text: query, limit });
  }

  removeMemory(id: string): { ok: boolean } {
    const ok = MemoryStore.getInstance().removeMemory(id);
    this.info(`已删除长期记忆: ${id}`);
    return { ok };
  }

  // 代码符号 AST 分析
  findDefinition(symbol: string, workspace?: string) {
    const ws = workspace || process.cwd();
    return AstSymbolIndexer.getInstance().findDefinition(symbol, ws);
  }

  findReferences(symbol: string, workspace?: string) {
    const ws = workspace || process.cwd();
    return AstSymbolIndexer.getInstance().findReferences(symbol, ws);
  }

  listSymbols(file: string) {
    return AstSymbolIndexer.getInstance().parseFileSymbols(file);
  }

  // Web 工作台信息
  getWebInfo() {
    return {
      ips: getLocalIpAddresses(),
      defaultPort: 3000,
    };
  }

  // 宿主主机实时状态
  getHostSysInfo(): HostSystemInfo {
    return getHostSystemInfo();
  }

  syncTarget(input: GuiSyncInput): object {
    const resolver = this.resolver();
    const model = [...resolver.resolveModels().values()].find((item) => item.fullName === input.model || item.alias === input.model);
    if (model === undefined) throw new Error('找不到模型：' + input.model);
    const provider = resolver.resolveProviders().get(model.providerId);
    if (provider === undefined) throw new Error('找不到服务商：' + model.providerId);
    const plan = planInjection({ target: mapTarget(input.target), model, provider, env: process.env });
    if (input.write) writeInjection(plan);
    this.info((input.write ? '已同步 ' : '已预览 ') + input.target + ' → ' + model.fullName);
    return plan;
  }

  async chat(input: GuiChatInput, onStream?: (event: Record<string, unknown>) => void): Promise<object> {
    const rawInput = input.input.trim();
    const resolver = this.resolver();
    const availableModels = [...resolver.resolveModels().values()];
    const providers = resolver.resolveProviders();

    let targetModel = input.model?.trim();
    if (targetModel) {
      if (!targetModel.includes('/')) {
        const found = availableModels.find(
          (m) => m.alias === targetModel || m.model === targetModel || m.fullName.endsWith('/' + targetModel)
        );
        if (found) {
          targetModel = found.fullName;
        } else {
          const readyProvider = [...providers.values()].find((p) => p.envKey !== undefined && Boolean(process.env[p.envKey])) || [...providers.values()][0];
          const providerId = readyProvider ? readyProvider.id : 'openai';
          targetModel = `${providerId}/${targetModel}`;
        }
      }
    }

    // 优先拦截斜杠系统指令，由本地引擎极速响应，无需调用远端大模型
    const command = parseCommand(rawInput);
    if (command.kind !== 'prompt') {
      const projectPath = input.projectPath?.trim() || process.cwd();
      let reply = '';

      switch (command.kind) {
        case 'models': {
          const readyModels: Array<{ alias: string; fullName: string; isCur: boolean; providerName: string }> = [];
          const otherModels: Array<{ alias: string; fullName: string; isCur: boolean; providerName: string }> = [];

          for (const m of availableModels) {
            const isCur = targetModel === m.fullName || targetModel === m.alias;
            const p = providers.get(m.providerId);
            const providerName = p?.name || m.providerId;
            const hasEnv = p !== undefined && p.envKey !== undefined && Boolean(process.env[p.envKey]);
            const isCustom = p !== undefined && BUILTIN_PROVIDERS[p.id] === undefined;
            const isConfigured = hasEnv || isCustom;

            if (isConfigured || isCur) {
              readyModels.push({ alias: m.alias, fullName: m.fullName, isCur, providerName });
            } else {
              otherModels.push({ alias: m.alias, fullName: m.fullName, isCur, providerName });
            }
          }

          const readyList = readyModels.map((m) => {
            return `${m.isCur ? '[当前] ' : '· '}**${m.alias}** (\`${m.fullName}\`)${m.isCur ? ' **[当前生效]**' : ''}`;
          }).join('\n');

          const otherSummary = otherModels.slice(0, 8).map((m) => `\`${m.alias}\``).join('、');

          const sections = [
            '**模型目录与状态**：',
            '',
            '**已配置就绪（可直接使用）**：',
            readyList || '· 暂无已配置 Key 的服务商模型',
          ];

          if (otherModels.length > 0) {
            sections.push(
              '',
              `**更多内置预设模型 (${otherModels.length} 个)**：`,
              otherSummary + (otherModels.length > 8 ? ' 等...' : ''),
              '*(需在左侧【模型服务商】填入对应 API Key 启用)*'
            );
          }

          sections.push('', '*提示：可在顶部模型下拉框直接选择，或发送 `/model <别名>` 切换。*');
          reply = sections.join('\n');
          break;
        }
        case 'model': {
          if (!command.modelName) {
            reply = `当前生效模型：\`${targetModel || '未配置'}\`\n\n切换指令：\n· \`/model <模型别名>\`（例如 /model gpt-4o）\n· \`/models\` 查看所有可用模型`;
          } else {
            const rawRef = command.modelName.trim();
            const targetRef = sanitizeModelRef(rawRef);
            const targetLower = targetRef.toLowerCase();
            const found = availableModels.find(
              (m) =>
                m.alias === targetRef ||
                m.fullName === targetRef ||
                m.model === targetRef ||
                m.alias.toLowerCase() === targetLower ||
                m.fullName.toLowerCase() === targetLower ||
                m.fullName.endsWith('/' + targetRef)
            );
            reply = `[OK] 已将当前生效模型指定为：\`${found ? found.alias + ' (' + found.fullName + ')' : targetRef}\``;
          }
          break;
        }
        case 'projects': {
          const state = readState();
          const list = state.projects.map((p: GuiProject, idx: number) => {
            const isCur = projectPath.toLowerCase() === p.path.toLowerCase();
            return `${isCur ? '[当前] ' : ''}[${idx + 1}] **${p.name}**\n   \`${p.path}\`${isCur ? ' *(当前绑定)*' : ''}`;
          }).join('\n\n');
          reply = ['**已导入工程工作区列表**：', '', list || '暂无导入项目'].join('\n');
          break;
        }
        case 'project': {
          reply = `当前工作区工程：\`${projectPath}\`\n\n*提示：如需切换工作区，请在左侧 Projects 树中直接点击目标工程。*`;
          break;
        }
        case 'git': {
          const gitStat = await this.getGitStatus(projectPath);
          if (!gitStat.isRepo) {
            reply = `[WARN] 当前工作区不是 Git 仓库：\`${projectPath}\``;
          } else {
            const files = gitStat.changedFiles.map((f) => `· \`[${f.status || 'M'}]\` ${f.file} (+${f.additions || 0}/-${f.deletions || 0})`).join('\n');
            reply = [
              `**Git 状态**（分支：\`${gitStat.branch}\`）`,
              `工作区：\`${projectPath}\``,
              gitStat.remoteUrl ? `远程源：\`${gitStat.remoteUrl}\`` : '',
              `未提交变更：**${gitStat.uncommittedCount}** 个文件（+${gitStat.totalAdditions} / -${gitStat.totalDeletions} 行）`,
              files ? '\n' + files : '\n*(工作区干净，无未提交修改)*',
            ].filter(Boolean).join('\n');
          }
          break;
        }
        case 'diff': {
          const diffRes = await this.gitDiff(projectPath, command.file);
          if (diffRes.ok) {
            const snippet = diffRes.diff.length > 3500 ? diffRes.diff.slice(0, 3450) + '\n...（内容过长已截断）' : diffRes.diff;
            reply = `**代码变更 Diff**（${command.file ? '文件: `' + command.file + '`' : '全部变更'}）：\n\`\`\`diff\n${snippet}\n\`\`\``;
          } else {
            reply = `[FAIL] 提取 Diff 失败：${diffRes.diff}`;
          }
          break;
        }
        case 'commit': {
          try {
            const res = await this.gitCommit(projectPath, command.message || 'chore: update project by hap');
            reply = `[OK] **Git 提交成功！**\n\`\`\`\n${res.summary}\n\`\`\``;
          } catch (err) {
            reply = `[FAIL] Git 提交失败：${describeError(err)}`;
          }
          break;
        }
        case 'push': {
          try {
            const res = await this.gitPush(projectPath);
            reply = `[OK] **Git 推送成功！**\n\`\`\`\n${res.summary}\n\`\`\``;
          } catch (err) {
            reply = `[FAIL] Git 推送失败：${describeError(err)}`;
          }
          break;
        }
        case 'sh': {
          if (!command.command || !command.command.trim()) {
            reply = '用法：`/sh <命令>`\n例如：`/sh npm test`';
            break;
          }
          try {
            const res = await execa(command.command, { cwd: projectPath, shell: true, timeout: 30000 });
            const out = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim() || '（命令执行完毕，无输出）';
            reply = `**Shell 执行完成**：\n\`\`\`bash\n${out}\n\`\`\``;
          } catch (err) {
            reply = `[FAIL] 命令执行异常：\n\`\`\`\n${describeError(err)}\n\`\`\``;
          }
          break;
        }
        case 'skills': {
          const skills = readState().skills || [];
          reply = `**已加载 Skills 技能清单 (${skills.length})**：\n\n` + (skills.length > 0 ? skills.map((s: GuiSkill) => `· **${s.name}** (${s.enabled ? '已启用' : '已停用'})\n  ${s.description || '无描述'}`).join('\n') : '尚未安装任何技能');
          break;
        }
        case 'plugins': {
          const plugins = readState().plugins || [];
          reply = `**已加载 MCP 插件与服务 (${plugins.length})**：\n\n` + (plugins.length > 0 ? plugins.map((p: GuiPlugin) => `· **${p.name}** (${p.enabled ? '已连接' : '已停用'})\n  ${p.description || '无描述'}`).join('\n') : '尚未注册任何 MCP 插件');
          break;
        }
        case 'help': {
          reply = HELP_TEXT;
          break;
        }
        default:
          reply = HELP_TEXT;
          break;
      }

      return {
        outcome: {
          taskId: 'local_cmd_' + Date.now(),
          text: reply,
          iterations: 0,
          model: 'local-command-engine',
        },
        events: [],
      };
    }

    const orchestrator = new AgentOrchestrator({ configPath: this.configPath, historyLimit: 20 });
    const events: Array<Record<string, unknown>> = [];
    const chatController = new AbortController();
    const taskId = randomUUID();
    this.activeChatTask = { taskId, controller: chatController, orchestrator };
    try {
      const permissions = this.getPermissions();
      const projectPath = input.projectPath?.trim();
      const prefix = projectPath === undefined || projectPath === '' ? '' : '项目路径：' + projectPath + '\n\n';

      // 提取并落地多模态附件（图片、代码文档等）
      const attachments: Attachment[] = [];
      if (Array.isArray(input.attachments) && input.attachments.length > 0) {
        const attachDir = join(DATA_DIR, 'attachments');
        mkdirSync(attachDir, { recursive: true });

        for (const item of input.attachments) {
          if (item.path && existsSync(item.path)) {
            const att: Attachment = {
              kind: item.kind || 'image',
              path: item.path,
            };
            if (item.fileName !== undefined) att.fileName = item.fileName;
            if (item.mimeType !== undefined) att.mimeType = item.mimeType;
            if (item.bytes !== undefined) att.bytes = item.bytes;
            attachments.push(att);
          } else if (item.dataUrl) {
            const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match && match[1] && match[2]) {
              const mimeType = match[1] || item.mimeType || 'image/png';
              const base64Data = match[2];
              const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg' :
                          mimeType.includes('png') ? '.png' :
                          mimeType.includes('gif') ? '.gif' :
                          mimeType.includes('webp') ? '.webp' :
                          mimeType.includes('json') ? '.json' :
                          mimeType.includes('markdown') || mimeType.includes('md') ? '.md' :
                          mimeType.includes('text') ? '.txt' : '.bin';
              const safeName = (item.fileName || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
              const fileName = `${Date.now()}_${randomUUID().slice(0, 8)}_${safeName.endsWith(ext) ? safeName : safeName + ext}`;
              const filePath = join(attachDir, fileName);
              writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
              const att: Attachment = {
                kind: item.kind || 'image',
                path: filePath,
                fileName: item.fileName || fileName,
                mimeType,
                bytes: item.bytes ?? Buffer.byteLength(base64Data, 'base64'),
              };
              attachments.push(att);
            }
          }
        }
      }

      const request: Parameters<AgentOrchestrator['runTask']>[0] = {
        input: prefix + input.input,
        sessionKey: input.sessionKey ?? 'gui:default',
        tools: toolsForPermissions(permissions),
        signal: chatController.signal,
        onEvent: (event) => {
          const evRecord = event as unknown as Record<string, unknown>;
          events.push(evRecord);
          if (onStream) {
            try {
              onStream(evRecord);
            } catch {
              // ignore stream error
            }
          }
        },
      };
      if (attachments.length > 0) {
        request.attachments = attachments;
      }
      if (input.agentId !== undefined && input.agentId !== '') {
        const requestedAgent = input.agentId.trim();
        if (resolver.listAgentIds().includes(requestedAgent)) {
          request.agentId = requestedAgent;
        } else {
          const configuredDefault = resolver.resolveDefaultAgentId();
          request.agentId = resolver.listAgentIds().includes(configuredDefault)
            ? configuredDefault
            : resolver.listAgentIds()[0];
          this.error(`聊天请求指定的智能体 ${requestedAgent} 不存在，已回退到 ${request.agentId}`);
        }
      }
      if (targetModel !== undefined && targetModel !== '') {
        request.model = targetModel;
      }
      if (projectPath !== undefined && projectPath !== '') {
        request.workspace = projectPath;
      }
      let outcome: any;
      try {
        outcome = await orchestrator.runTask(request);
        this.info('聊天完成：' + outcome.taskId);
        if (chatController.signal.aborted || outcome.finishReason === 'abort') {
          outcome = {
            taskId,
            text: (outcome?.text ? outcome.text + '\n\n' : '') + '*(⏹️ 用户已手动中断本次生成)*',
            finishReason: 'abort',
            iterations: outcome?.iterations ?? 0,
            model: targetModel || 'default',
          };
        } else if (outcome.status === 'failed' || outcome.finishReason === 'error' || (!outcome.text && outcome.error)) {
          const reason = outcome.error || '大模型接口未返回有效回复';
          outcome.text = `⚠️ **智能体回复提示：**\n\n\`${reason}\`\n\n> 💡 **解决建议：**\n> 1. 请前往左侧导航 **【⚙️ 设置中心 -> AI 服务商与模型】**，检查对应服务商的 **API 基础地址 (Base URL)** 与 **API Key** 是否填写正确；\n> 2. 点击服务商卡片上的 **【连通测试】** 验证网络与 Key 有效性；\n> 3. 您也可以点击顶部模型下拉框，切换到其它已就绪的模型（如 DeepSeek、OpenAI 或本地免费的 Ollama）。\n> 4. 支持本地斜杠系统指令，例如发送 \`/models\` 查看所有已配置模型。\n`;
        }
      } catch (taskErr) {
        if (chatController.signal.aborted) {
          outcome = {
            taskId,
            text: '*(⏹️ 用户已手动中断本次生成)*',
            finishReason: 'abort',
            iterations: 0,
            model: targetModel || 'default',
          };
        } else {
          const errMsg = describeError(taskErr);
          this.error('智能体对话执行异常：' + errMsg);
          outcome = {
            taskId: 'err_' + Date.now(),
            text: `⚠️ **智能体回复提示：**\n\n\`${errMsg}\`\n\n> 💡 **解决建议：**\n> 1. 请前往左侧导航 **【⚙️ 设置中心 -> AI 服务商与模型】**，检查对应服务商的 **API 基础地址 (Base URL)** 与 **API Key** 是否填写正确；\n> 2. 点击服务商卡片上的 **【连通测试】** 验证连通性；\n> 3. 您也可以点击顶部模型下拉框，切换到其它已就绪的模型直接对话。\n> 4. 支持本地斜杠系统指令（如 \`/models\`、\`/help\`）。\n`,
            iterations: 0,
            model: targetModel || 'default',
          };
        }
      }
      return { outcome, events };
    } finally {
      if (this.activeChatTask?.taskId === taskId) {
        this.activeChatTask = null;
      }
      await orchestrator.close();
    }
  }

  abortChat(): { ok: boolean; message: string } {
    if (!this.activeChatTask) {
      return { ok: false, message: '当前没有正在执行的生成任务' };
    }
    try {
      this.activeChatTask.controller.abort();
      this.activeChatTask.orchestrator.abort(this.activeChatTask.taskId);
      this.info(`已接收中断指令，已成功中止任务: ${this.activeChatTask.taskId}`);
      this.activeChatTask = null;
      return { ok: true, message: '已成功中止对话生成' };
    } catch (err) {
      return { ok: false, message: `中止生成失败: ${describeError(err)}` };
    }
  }

  async listMcpPlaygroundTools(refresh = false): Promise<{
    tools: Array<{
      name: string;
      rawName: string;
      description: string;
      parameters: Record<string, unknown>;
      source: string;
    }>;
    failures: Array<{ serverId: string; message: string }>;
    serverCount: number;
  }> {
    if (refresh || !this.mcpPlaygroundManager) {
      if (this.mcpPlaygroundManager) {
        await this.mcpPlaygroundManager.close().catch(() => {});
      }
      const loaded = loadConfig({ path: this.configPath });
      const specs = resolveMcpServers(loaded.config);
      this.mcpPlaygroundManager = new McpManager(specs, process.env);
      const res = await this.mcpPlaygroundManager.listAll();
      this.mcpPlaygroundModules = new Map(res.modules.map((m) => [m.definition.name, m]));
      return {
        tools: res.modules.map((m) => ({
          name: m.definition.name,
          rawName: m.renamedFrom || m.definition.name,
          description: m.definition.description,
          parameters: m.definition.parameters,
          source: m.definition.source,
        })),
        failures: res.failures,
        serverCount: specs.length,
      };
    }

    const loaded = loadConfig({ path: this.configPath });
    const specs = resolveMcpServers(loaded.config);
    const tools = [...(this.mcpPlaygroundModules?.values() || [])].map((m) => ({
      name: m.definition.name,
      rawName: m.renamedFrom || m.definition.name,
      description: m.definition.description,
      parameters: m.definition.parameters,
      source: m.definition.source,
    }));
    return {
      tools,
      failures: [],
      serverCount: specs.length,
    };
  }

  async callMcpPlaygroundTool(payload: { toolName: string; args: Record<string, unknown> }): Promise<{
    ok: boolean;
    output: string;
    durationMs: number;
    isError?: boolean;
  }> {
    if (!payload.toolName) throw new Error('未指定工具名称');
    if (!this.mcpPlaygroundModules || !this.mcpPlaygroundModules.has(payload.toolName)) {
      await this.listMcpPlaygroundTools(true);
    }
    const module = this.mcpPlaygroundModules?.get(payload.toolName);
    if (!module) {
      throw new Error(`找不到 MCP 工具: ${payload.toolName}`);
    }

    const resolver = this.resolver();
    const agentIds = resolver.listAgentIds();
    const defaultAgent = resolver.resolveAgent(agentIds[0] ?? 'default');

    const ctx: ToolContext = {
      agent: defaultAgent,
      paths: resolver.resolvePaths(),
      taskId: 'mcp_playground_' + Date.now(),
      signal: new AbortController().signal,
      depth: 0,
      env: process.env,
    };

    const start = Date.now();
    try {
      const output = await module.handler(payload.args || {}, ctx);
      const durationMs = Date.now() - start;
      const res: { ok: boolean; output: string; durationMs: number; isError?: boolean } = {
        ok: !output.isError,
        output: output.content,
        durationMs,
      };
      if (output.isError) res.isError = true;
      return res;
    } catch (err) {
      const durationMs = Date.now() - start;
      return {
        ok: false,
        output: describeError(err),
        durationMs,
        isError: true,
      };
    }
  }

  private telegramManager: ChannelManager | TelegramChannel | undefined;
  private telegramManagers: TelegramChannel[] = [];
  private telegramRunning = false;
  private telegramBotInfo: { username: string; name: string } | undefined;

  async getTelegramConfig(): Promise<GuiTelegramConfig> {
    const resolver = this.resolver();
    const channels = resolver.resolveChannels();
    const tg = channels.telegram;
    const envToken = process.env.TELEGRAM_BOT_TOKEN || (tg.tokenEnv ? process.env[tg.tokenEnv] || '' : '');
    
    const declaredAgents = resolver.listAgentIds();
    const defaultAgentId = (tg.defaultAgent && declaredAgents.includes(tg.defaultAgent))
      ? tg.defaultAgent
      : (declaredAgents[0] || tg.defaultAgent || 'ops');
    
    let agentWorkspace: string | undefined;
    try {
      agentWorkspace = resolver.resolveAgent(defaultAgentId)?.workspace;
    } catch {}

    return {
      enabled: !!tg.enabled,
      token: envToken,
      mode: tg.mode || 'polling',
      defaultAgent: defaultAgentId,
      workspace: agentWorkspace,
      running: this.telegramRunning,
      botUsername: this.telegramBotInfo?.username,
      botName: this.telegramBotInfo?.name,
    };
  }

  async saveTelegramConfig(config: Partial<GuiTelegramConfig>): Promise<GuiTelegramConfig> {
    if (config.token !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = config.token.trim();
      const env = readSavedEnv();
      env.TELEGRAM_BOT_TOKEN = config.token.trim();
      writeSavedEnv(env);
    }

    const writer = new ConfigWriter(this.configPath);
    const { config: hapConfig, exists, raw } = writer.read();
    if (!hapConfig.channels) hapConfig.channels = {};
    if (!hapConfig.channels.telegram) hapConfig.channels.telegram = {};

    if (config.enabled !== undefined) hapConfig.channels.telegram.enabled = config.enabled;
    if (config.mode !== undefined) hapConfig.channels.telegram.mode = config.mode;
    if (config.defaultAgent !== undefined) hapConfig.channels.telegram.default_agent = config.defaultAgent;
    hapConfig.channels.telegram.token_env = 'TELEGRAM_BOT_TOKEN';

    if (config.workspace !== undefined && config.workspace.trim()) {
      if (!hapConfig.agents) hapConfig.agents = {};
      if (!hapConfig.agents.entries) hapConfig.agents.entries = {};
      const agentKey = config.defaultAgent || hapConfig.channels.telegram.default_agent || 'ops';
      if (!hapConfig.agents.entries[agentKey]) hapConfig.agents.entries[agentKey] = {};
      hapConfig.agents.entries[agentKey].workspace = config.workspace.trim();
    }

    // @ts-expect-error private commit
    writer.commit(hapConfig, exists, raw, '更新 Telegram 配置');
    this.info('Telegram 通道配置已保存');
    return this.getTelegramConfig();
  }

  async testTelegramBot(token?: string): Promise<{ ok: boolean; username?: string; name?: string; error?: string }> {
    const t = token?.trim() || process.env.TELEGRAM_BOT_TOKEN;
    if (!t) {
      return { ok: false, error: '未提供 Bot Token' };
    }

    try {
      const resp = await fetch(`https://api.telegram.org/bot${t}/getMe`);
      const data = (await resp.json()) as { ok: boolean; result?: { username: string; first_name: string }; description?: string };
      if (data.ok && data.result) {
        this.telegramBotInfo = { username: data.result.username, name: data.result.first_name };
        return { ok: true, username: data.result.username, name: data.result.first_name };
      }
      return { ok: false, error: data.description || 'Token 无效或无法连接 Telegram 官方接口' };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  async startTelegramService(): Promise<{ ok: boolean; message: string; botUsername?: string | undefined }> {
    if (this.telegramRunning) {
      return { ok: true, message: 'Telegram 机器人正在运行中', botUsername: this.telegramBotInfo?.username };
    }

    const runtimeBots = this.botControl.runtimeBots('telegram');
    if (runtimeBots.length > 0) {
      const orchestrator = new AgentOrchestrator({ configPath: this.configPath });
      await orchestrator.loadMcpTools();
      const baseChannels = orchestrator.config.resolveChannels();
      const limits = orchestrator.config.resolveLimits();
      const paths = orchestrator.resolvedPaths;
      const host = createChannelHost(orchestrator);
      const managers: TelegramChannel[] = [];
      for (const runtime of runtimeBots) {
        const tokenEnv = `HAP_BOT_${runtime.account.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
        const manager = new TelegramChannel({
          host,
          channels: {
            ...baseChannels,
            telegram: {
              ...baseChannels.telegram,
              enabled: true,
              tokenEnv,
              mode: 'polling',
              defaultAgent: runtime.account.defaultAgentId,
            },
          },
          limits,
          paths,
          env: { ...process.env, [tokenEnv]: runtime.credentials.token },
          log: (line) => this.info(`[Telegram:${runtime.account.id}] ${line}`),
          control: { botAccountId: runtime.account.id, authorization: runtime.authorization },
        });
        await manager.start();
        managers.push(manager);
      }
      this.telegramManagers = managers;
      this.telegramRunning = true;
      this.info(`Telegram 多机器人服务已启动：${managers.length} 个 Bot`);
      return {
        ok: true,
        message: `Telegram 多机器人服务已启动：${managers.length} 个 Bot 正在监听消息。`,
      };
    }

    const config = await this.getTelegramConfig();
    if (!config.token) {
      throw new Error('未配置 TELEGRAM_BOT_TOKEN，请先填写 Bot Token');
    }

    const test = await this.testTelegramBot(config.token);
    if (!test.ok) {
      throw new Error(`Telegram 机器人凭据校验失败：${test.error}`);
    }

    await this.saveTelegramConfig({ enabled: true });

    const orchestrator = new AgentOrchestrator({ configPath: this.configPath });
    await orchestrator.loadMcpTools();

    const manager = new TelegramChannel({
      host: createChannelHost(orchestrator),
      channels: orchestrator.config.resolveChannels(),
      limits: orchestrator.config.resolveLimits(),
      paths: orchestrator.resolvedPaths,
      env: process.env,
      log: (line) => this.info(`[Telegram] ${line}`),
    });

    await manager.start();
    this.telegramManager = manager;
    this.telegramManagers = [manager];
    this.telegramRunning = true;
    this.info(`Telegram 机器人服务已成功启动：@${test.username}`);

    return {
      ok: true,
      message: `Telegram 机器人 @${test.username} 启动成功，正在监听消息！`,
      botUsername: test.username,
    };
  }

  async stopTelegramService(): Promise<{ ok: boolean; message: string }> {
    if (!this.telegramRunning || (this.telegramManager === undefined && this.telegramManagers.length === 0)) {
      this.telegramRunning = false;
      return { ok: true, message: 'Telegram 机器人未处于运行状态' };
    }

    try {
      for (const manager of [...this.telegramManagers].reverse()) {
        await manager.stop();
      }
      if (this.telegramManagers.length === 0) {
        await this.telegramManager?.stop();
      }
      this.telegramManager = undefined;
      this.telegramManagers = [];
      this.telegramRunning = false;
      this.info('Telegram 机器人服务已停止');
      return { ok: true, message: 'Telegram 机器人服务已成功停止' };
    } catch (err) {
      this.telegramRunning = false;
      throw new Error(`停止 Telegram 机器人失败：${describeError(err)}`);
    }
  }

  private wechatManager: WeChatChannel | undefined;
  private wechatRunning = false;
  private wechatStatus: 'idle' | 'waiting_qr' | 'connected' | 'error' = 'idle';
  private wechatQrCode: string | undefined;
  private wechatLoginUser: string | undefined;
  private wechatError: string | undefined;

  async getWeChatConfig(): Promise<GuiWeChatConfig> {
    const resolver = this.resolver();
    const channels = resolver.resolveChannels();
    const wx = channels.wechat;
    
    const declaredAgents = resolver.listAgentIds();
    const defaultAgentId = (wx.defaultAgent && declaredAgents.includes(wx.defaultAgent))
      ? wx.defaultAgent
      : (declaredAgents[0] || wx.defaultAgent || 'ops');
    
    let agentWorkspace: string | undefined;
    try {
      agentWorkspace = resolver.resolveAgent(defaultAgentId)?.workspace;
    } catch {}

    return {
      enabled: !!wx.enabled,
      mode: wx.mode || 'personal',
      defaultAgent: defaultAgentId,
      workspace: agentWorkspace,
      running: this.wechatRunning,
      status: this.wechatStatus,
      qrCodeText: this.wechatStatus === 'error' ? undefined : this.wechatManager?.qrCodeText ?? this.wechatQrCode,
      loginUser: this.wechatLoginUser,
      error: this.wechatError,
      wecomCorpId: wx.wecom?.corpId,
      wecomAgentId: wx.wecom?.agentId,
      wecomSecret: wx.wecom?.corpSecretEnv ? process.env[wx.wecom.corpSecretEnv] || '' : '',
      wecomWebhookUrl: wx.wecom?.webhookUrlEnv ? process.env[wx.wecom.webhookUrlEnv] || '' : '',
    };
  }

  async saveWeChatConfig(config: Partial<GuiWeChatConfig>): Promise<GuiWeChatConfig> {
    if (config.wecomSecret !== undefined && config.wecomSecret.trim()) {
      process.env.WECHAT_WECOM_CORP_SECRET = config.wecomSecret.trim();
      const env = readSavedEnv();
      env.WECHAT_WECOM_CORP_SECRET = config.wecomSecret.trim();
      writeSavedEnv(env);
    }
    if (config.wecomWebhookUrl !== undefined && config.wecomWebhookUrl.trim()) {
      process.env.WECHAT_WECOM_WEBHOOK_URL = config.wecomWebhookUrl.trim();
      const env = readSavedEnv();
      env.WECHAT_WECOM_WEBHOOK_URL = config.wecomWebhookUrl.trim();
      writeSavedEnv(env);
    }

    const writer = new ConfigWriter(this.configPath);
    const { config: hapConfig, exists, raw } = writer.read();
    if (!hapConfig.channels) hapConfig.channels = {};
    if (!hapConfig.channels.wechat) hapConfig.channels.wechat = {};

    if (config.enabled !== undefined) hapConfig.channels.wechat.enabled = config.enabled;
    if (config.mode !== undefined) hapConfig.channels.wechat.mode = config.mode;
    if (config.defaultAgent !== undefined) hapConfig.channels.wechat.default_agent = config.defaultAgent;

    if (config.mode === 'ilink_bot') {
      if (!hapConfig.channels.wechat.personal) hapConfig.channels.wechat.personal = {};
      hapConfig.channels.wechat.personal.puppet = 'ilink';
    }

    if (config.mode === 'wecom') {
      if (!hapConfig.channels.wechat.wecom) hapConfig.channels.wechat.wecom = {};
      if (config.wecomCorpId !== undefined) hapConfig.channels.wechat.wecom.corp_id = config.wecomCorpId;
      if (config.wecomAgentId !== undefined) hapConfig.channels.wechat.wecom.agent_id = config.wecomAgentId;
      hapConfig.channels.wechat.wecom.corp_secret_env = 'WECHAT_WECOM_CORP_SECRET';
      hapConfig.channels.wechat.wecom.webhook_url_env = 'WECHAT_WECOM_WEBHOOK_URL';
    }

    if (config.workspace !== undefined && config.workspace.trim()) {
      if (!hapConfig.agents) hapConfig.agents = {};
      if (!hapConfig.agents.entries) hapConfig.agents.entries = {};
      const agentKey = config.defaultAgent || hapConfig.channels.wechat.default_agent || 'ops';
      if (!hapConfig.agents.entries[agentKey]) hapConfig.agents.entries[agentKey] = {};
      hapConfig.agents.entries[agentKey].workspace = config.workspace.trim();
    }

    // @ts-expect-error private commit
    writer.commit(hapConfig, exists, raw, '更新微信/企业微信配置');
    this.info('微信通道配置已保存');
    return this.getWeChatConfig();
  }

  private async fetchRealWeChatUuid(): Promise<string | undefined> {
    try {
      const url = `https://login.wx.qq.com/jslogin?appid=wx782c26e4c19acffb&fun=new&lang=zh_CN&_=${Date.now()}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await res.text();
      const match = text.match(/window\.QRLogin\.uuid\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        return match[1];
      }
    } catch (e) {
      this.error('获取微信官方登录 UUID 失败: ' + describeError(e));
    }
    return undefined;
  }

  async refreshWeChatQr(): Promise<{ ok: boolean; qrCodeText?: string | undefined }> {
    await this.stopWeChatService();
    await this.startWeChatService();
    return { ok: true, qrCodeText: (await this.getWeChatConfig()).qrCodeText };
  }

  async confirmWeChatLogin(): Promise<{ ok: boolean; status: string; user?: string | undefined }> {
    const user = this.wechatManager?.currentUser;
    if (!user) return { ok: false, status: this.wechatStatus };
    this.wechatStatus = 'connected';
    this.wechatLoginUser = user.name;
    return { ok: true, status: 'connected', user: user.name };
  }

  async startWeChatService(): Promise<{ ok: boolean; message: string; user?: string | undefined }> {
    if (this.wechatRunning) {
      return { ok: true, message: '微信服务正在运行中', user: this.wechatLoginUser };
    }

    if (this.wechatManager) await this.stopWeChatService();
    this.wechatError = undefined;
    this.wechatQrCode = undefined;
    this.wechatLoginUser = undefined;

    await this.saveWeChatConfig({ enabled: true });

    const orchestrator = new AgentOrchestrator({ configPath: this.configPath });
    await orchestrator.loadMcpTools();

    this.wechatStatus = 'waiting_qr';

    const manager = new WeChatChannel({
      host: createChannelHost(orchestrator),
      channels: orchestrator.config.resolveChannels(),
      limits: orchestrator.config.resolveLimits(),
      paths: orchestrator.resolvedPaths,
      env: process.env,
      log: (line) => {
        this.info(`[WeChat] ${line}`);
        if (line.includes('[WeChat] 微信已登出：')) {
          this.wechatRunning = false;
          this.wechatStatus = 'error';
          this.wechatError = line.split('[WeChat] 微信已登出：')[1]?.trim();
          this.wechatLoginUser = undefined;
          this.wechatQrCode = undefined;
        }
        if (line.includes('[WeChat] 请使用手机微信扫码登录：') || line.includes('[WeChat QR] 扫码地址:')) {
          const qr = line.split('：')[1]?.trim() || line.split('扫码地址:')[1]?.trim();
          if (qr && qr.startsWith('http')) {
            this.wechatQrCode = qr;
            this.wechatStatus = 'waiting_qr';
          }
        }
        if (line.includes('登录成功')) {
          this.wechatStatus = 'connected';
          const userName = line.split('登录成功：')[1]?.split('(')[0]?.trim() || 'WeChat User';
          this.wechatLoginUser = userName;
        }
      },
    });

    this.wechatManager = manager;
    this.wechatRunning = true;
    try {
      await manager.start();
    } catch (error) {
      await manager.stop();
      this.wechatManager = undefined;
      this.wechatRunning = false;
      this.wechatStatus = 'error';
      this.wechatError = describeError(error);
      throw error;
    }

    if (manager.qrCodeText) {
      this.wechatQrCode = manager.qrCodeText;
    }
    if (manager.currentUser) {
      this.wechatStatus = 'connected';
      this.wechatLoginUser = manager.currentUser.name;
    }

    this.info('微信服务已成功启动！');

    return {
      ok: true,
      message: '微信服务已启动，请扫码或等待消息接收！',
      user: this.wechatLoginUser,
    };
  }

  async stopWeChatService(): Promise<{ ok: boolean; message: string }> {
    if (!this.wechatManager) {
      this.wechatRunning = false;
      this.wechatStatus = 'idle';
      this.wechatError = undefined;
      this.wechatQrCode = undefined;
      this.wechatLoginUser = undefined;
      return { ok: true, message: '微信服务未处于运行状态' };
    }

    try {
      await this.wechatManager.stop();
      this.wechatManager = undefined;
      this.wechatRunning = false;
      this.wechatStatus = 'idle';
      this.wechatError = undefined;
      this.wechatQrCode = undefined;
      this.wechatLoginUser = undefined;
      this.info('微信服务已停止');
      return { ok: true, message: '微信服务已成功停止' };
    } catch (err) {
      this.wechatRunning = false;
      this.wechatStatus = 'error';
      throw new Error(`停止微信服务失败：${describeError(err)}`);
    }
  }

  async syncWeChatContacts(): Promise<{ contacts: number; rooms: number; syncedAt: number }> {
    if (!this.wechatRunning || !this.wechatManager) throw new Error('微信服务尚未启动，无法同步真实联系人');
    const result = await this.wechatManager.syncPersonalContacts();
    this.info(`微信真实联系人同步完成：${result.contacts} 位联系人，${result.rooms} 个群聊`);
    return result;
  }

  // ==========================================
  // 飞书机器人 (Feishu / Lark) 通道管理
  // ==========================================

  private feishuChannel: FeishuChannel | undefined;
  private feishuRunning = false;

  async getFeishuConfig(): Promise<GuiFeishuConfig> {
    const resolver = this.resolver();
    const channels = resolver.resolveChannels();
    const feishu = channels.feishu;

    const declaredAgents = resolver.listAgentIds();
    const defaultAgentId = (feishu?.defaultAgent && declaredAgents.includes(feishu.defaultAgent))
      ? feishu.defaultAgent
      : (declaredAgents[0] || feishu?.defaultAgent || 'coder');

    let agentWorkspace: string | undefined;
    try {
      agentWorkspace = resolver.resolveAgent(defaultAgentId)?.workspace;
    } catch {}

    return {
      enabled: !!feishu?.enabled,
      appId: feishu?.appId,
      appSecret: feishu?.appSecretEnv ? process.env[feishu.appSecretEnv] || '' : '',
      verificationToken: feishu?.verificationToken,
      encryptKey: feishu?.encryptKeyEnv ? process.env[feishu.encryptKeyEnv] || '' : '',
      webhookUrl: feishu?.webhookUrlEnv ? process.env[feishu.webhookUrlEnv] || '' : '',
      bind: feishu?.bind || '127.0.0.1:8765',
      path: feishu?.path || '/api/feishu/events',
      defaultAgent: defaultAgentId,
      workspace: agentWorkspace,
      running: this.feishuRunning,
      status: this.feishuRunning ? 'running' : 'idle',
    };
  }

  async saveFeishuConfig(config: Partial<GuiFeishuConfig>): Promise<GuiFeishuConfig> {
    if (config.appSecret !== undefined && config.appSecret.trim()) {
      process.env.FEISHU_APP_SECRET = config.appSecret.trim();
      const env = readSavedEnv();
      env.FEISHU_APP_SECRET = config.appSecret.trim();
      writeSavedEnv(env);
    }
    if (config.encryptKey !== undefined && config.encryptKey.trim()) {
      process.env.FEISHU_ENCRYPT_KEY = config.encryptKey.trim();
      const env = readSavedEnv();
      env.FEISHU_ENCRYPT_KEY = config.encryptKey.trim();
      writeSavedEnv(env);
    }
    if (config.webhookUrl !== undefined && config.webhookUrl.trim()) {
      process.env.FEISHU_WEBHOOK_URL = config.webhookUrl.trim();
      const env = readSavedEnv();
      env.FEISHU_WEBHOOK_URL = config.webhookUrl.trim();
      writeSavedEnv(env);
    }

    const writer = new ConfigWriter(this.configPath);
    const { config: hapConfig } = writer.read();
    if (!hapConfig.channels) hapConfig.channels = {};
    if (!hapConfig.channels.feishu) hapConfig.channels.feishu = {};

    if (config.enabled !== undefined) hapConfig.channels.feishu.enabled = config.enabled;
    if (config.appId !== undefined) hapConfig.channels.feishu.app_id = config.appId;
    if (config.verificationToken !== undefined) hapConfig.channels.feishu.verification_token = config.verificationToken;
    if (config.bind !== undefined) hapConfig.channels.feishu.bind = config.bind;
    if (config.path !== undefined) hapConfig.channels.feishu.path = config.path;
    if (config.defaultAgent !== undefined) hapConfig.channels.feishu.default_agent = config.defaultAgent;
    if (config.appSecret) hapConfig.channels.feishu.app_secret_env = 'FEISHU_APP_SECRET';
    if (config.encryptKey) hapConfig.channels.feishu.encrypt_key_env = 'FEISHU_ENCRYPT_KEY';
    if (config.webhookUrl) hapConfig.channels.feishu.webhook_url_env = 'FEISHU_WEBHOOK_URL';

    writer.writeConfig(hapConfig, '保存飞书配置');
    this.info('飞书机器人配置已成功保存！');
    return this.getFeishuConfig();
  }

  async startFeishuService(): Promise<{ ok: boolean; message: string }> {
    if (this.feishuRunning && this.feishuChannel) {
      return { ok: true, message: '飞书机器人服务已处于运行状态' };
    }

    try {
      const orchestrator = new AgentOrchestrator(this.configPath ? { configPath: this.configPath } : {});
      await orchestrator.loadMcpTools();
      const host = createChannelHost(orchestrator);
      const cfg = await this.getFeishuConfig();

      this.feishuChannel = new FeishuChannel({
        host,
        config: {
          enabled: true,
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          verificationToken: cfg.verificationToken,
          encryptKey: cfg.encryptKey,
          webhookUrl: cfg.webhookUrl,
          bind: cfg.bind,
          path: cfg.path,
          defaultAgent: cfg.defaultAgent,
        },
      });

      await this.feishuChannel.start();
      this.feishuRunning = true;
      this.info('飞书机器人服务已成功启动！');
      return { ok: true, message: '飞书机器人服务已启动，正在监听事件！' };
    } catch (err) {
      this.feishuRunning = false;
      this.feishuChannel = undefined;
      throw new Error(`启动飞书机器人服务失败：${describeError(err)}`);
    }
  }

  async stopFeishuService(): Promise<{ ok: boolean; message: string }> {
    if (!this.feishuRunning || !this.feishuChannel) {
      this.feishuRunning = false;
      return { ok: true, message: '飞书机器人服务未运行' };
    }

    try {
      await this.feishuChannel.stop();
      this.feishuChannel = undefined;
      this.feishuRunning = false;
      this.info('飞书机器人服务已停止');
      return { ok: true, message: '飞书机器人服务已成功停止' };
    } catch (err) {
      this.feishuRunning = false;
      throw new Error(`停止飞书服务失败：${describeError(err)}`);
    }
  }

  // ==========================================
  // QQ 机器人 (OneBot / 官方开放平台) 通道管理
  // ==========================================

  private qqChannel: QQChannel | undefined;
  private qqRunning = false;

  async getQQConfig(): Promise<GuiQQConfig> {
    const resolver = this.resolver();
    const channels = resolver.resolveChannels();
    const qq = channels.qq;

    const declaredAgents = resolver.listAgentIds();
    const defaultAgentId = (qq?.defaultAgent && declaredAgents.includes(qq.defaultAgent))
      ? qq.defaultAgent
      : (declaredAgents[0] || qq?.defaultAgent || 'coder');

    let agentWorkspace: string | undefined;
    try {
      agentWorkspace = resolver.resolveAgent(defaultAgentId)?.workspace;
    } catch {}

    return {
      enabled: !!qq?.enabled,
      mode: qq?.mode || 'onebot',
      onebotWsUrl: qq?.onebotWsUrl,
      onebotAccessToken: qq?.onebotAccessTokenEnv ? process.env[qq.onebotAccessTokenEnv] || '' : '',
      onebotHttpUrl: qq?.onebotHttpUrl || 'http://127.0.0.1:3000',
      bind: qq?.bind || '127.0.0.1:8766',
      path: qq?.path || '/api/qq/onebot',
      officialAppId: qq?.officialAppId,
      officialToken: qq?.officialTokenEnv ? process.env[qq.officialTokenEnv] || '' : '',
      officialSecret: qq?.officialSecretEnv ? process.env[qq.officialSecretEnv] || '' : '',
      defaultAgent: defaultAgentId,
      workspace: agentWorkspace,
      running: this.qqRunning,
      status: this.qqRunning ? 'running' : 'idle',
    };
  }

  async saveQQConfig(config: Partial<GuiQQConfig>): Promise<GuiQQConfig> {
    if (config.onebotAccessToken !== undefined && config.onebotAccessToken.trim()) {
      process.env.QQ_ONEBOT_ACCESS_TOKEN = config.onebotAccessToken.trim();
      const env = readSavedEnv();
      env.QQ_ONEBOT_ACCESS_TOKEN = config.onebotAccessToken.trim();
      writeSavedEnv(env);
    }
    if (config.officialToken !== undefined && config.officialToken.trim()) {
      process.env.QQ_OFFICIAL_TOKEN = config.officialToken.trim();
      const env = readSavedEnv();
      env.QQ_OFFICIAL_TOKEN = config.officialToken.trim();
      writeSavedEnv(env);
    }
    if (config.officialSecret !== undefined && config.officialSecret.trim()) {
      process.env.QQ_OFFICIAL_SECRET = config.officialSecret.trim();
      const env = readSavedEnv();
      env.QQ_OFFICIAL_SECRET = config.officialSecret.trim();
      writeSavedEnv(env);
    }

    const writer = new ConfigWriter(this.configPath);
    const { config: hapConfig } = writer.read();
    if (!hapConfig.channels) hapConfig.channels = {};
    if (!hapConfig.channels.qq) hapConfig.channels.qq = {};

    if (config.enabled !== undefined) hapConfig.channels.qq.enabled = config.enabled;
    if (config.mode !== undefined) hapConfig.channels.qq.mode = config.mode;
    if (config.onebotWsUrl !== undefined) hapConfig.channels.qq.onebot_ws_url = config.onebotWsUrl;
    if (config.onebotHttpUrl !== undefined) hapConfig.channels.qq.onebot_http_url = config.onebotHttpUrl;
    if (config.bind !== undefined) hapConfig.channels.qq.bind = config.bind;
    if (config.path !== undefined) hapConfig.channels.qq.path = config.path;
    if (config.officialAppId !== undefined) hapConfig.channels.qq.official_app_id = config.officialAppId;
    if (config.defaultAgent !== undefined) hapConfig.channels.qq.default_agent = config.defaultAgent;
    if (config.onebotAccessToken) hapConfig.channels.qq.onebot_access_token_env = 'QQ_ONEBOT_ACCESS_TOKEN';
    if (config.officialToken) hapConfig.channels.qq.official_token_env = 'QQ_OFFICIAL_TOKEN';
    if (config.officialSecret) hapConfig.channels.qq.official_secret_env = 'QQ_OFFICIAL_SECRET';

    writer.writeConfig(hapConfig, '保存QQ机器人配置');
    this.info('QQ 机器人配置已成功保存！');
    return this.getQQConfig();
  }

  async startQQService(): Promise<{ ok: boolean; message: string }> {
    if (this.qqRunning && this.qqChannel) {
      return { ok: true, message: 'QQ 机器人服务已处于运行状态' };
    }

    try {
      const orchestrator = new AgentOrchestrator(this.configPath ? { configPath: this.configPath } : {});
      await orchestrator.loadMcpTools();
      const host = createChannelHost(orchestrator);
      const cfg = await this.getQQConfig();

      this.qqChannel = new QQChannel({
        host,
        config: {
          enabled: true,
          mode: cfg.mode,
          onebotWsUrl: cfg.onebotWsUrl,
          onebotAccessToken: cfg.onebotAccessToken,
          onebotHttpUrl: cfg.onebotHttpUrl,
          bind: cfg.bind,
          path: cfg.path,
          officialAppId: cfg.officialAppId,
          officialToken: cfg.officialToken,
          officialSecret: cfg.officialSecret,
          defaultAgent: cfg.defaultAgent,
        },
      });

      await this.qqChannel.start();
      this.qqRunning = true;
      this.info('QQ 机器人服务已成功启动！');
      return { ok: true, message: 'QQ 机器人服务已启动，正在监听消息！' };
    } catch (err) {
      this.qqRunning = false;
      this.qqChannel = undefined;
      throw new Error(`启动 QQ 机器人服务失败：${describeError(err)}`);
    }
  }

  async stopQQService(): Promise<{ ok: boolean; message: string }> {
    if (!this.qqRunning || !this.qqChannel) {
      this.qqRunning = false;
      return { ok: true, message: 'QQ 机器人服务未运行' };
    }

    try {
      await this.qqChannel.stop();
      this.qqChannel = undefined;
      this.qqRunning = false;
      this.info('QQ 机器人服务已停止');
      return { ok: true, message: 'QQ 机器人服务已成功停止' };
    } catch (err) {
      this.qqRunning = false;
      throw new Error(`停止 QQ 服务失败：${describeError(err)}`);
    }
  }

  // ==========================================
  // 多通道通用联系人与智能体专属自动回复管理
  // ==========================================

  listChannelContacts(channel?: ChannelName): ChannelContact[] {
    return ChannelContactStore.getInstance().listContacts(channel);
  }

  getChannelMessages(contactId?: string, channel?: ChannelName): ChannelChatMessage[] {
    return ChannelContactStore.getInstance().getMessages(contactId, channel);
  }

  upsertChannelContact(input: Partial<ChannelContact> & { id: string; channel: ChannelName; name: string }): ChannelContact {
    const res = ChannelContactStore.getInstance().upsertContact(input);
    this.info(`已更新通道 [${input.channel}] 联系人/会话 [${res.name}] 规则配置`);
    return res;
  }

  removeChannelContact(id: string, channel?: ChannelName): boolean {
    const res = ChannelContactStore.getInstance().removeContact(id, channel);
    this.info(`已移除通道 [${channel || 'all'}] 联系人/会话 [${id}]`);
    return res;
  }

  async sendChannelMessage(payload: {
    channel: ChannelName;
    targetId: string;
    text: string;
    agentId?: string | undefined;
    workspace?: string | undefined;
  }): Promise<{ ok: boolean; replyText?: string | undefined; error?: string | undefined }> {
    const store = ChannelContactStore.getInstance();
    const contact = store.getContact(payload.targetId, payload.channel);
    const assignedAgent = payload.agentId || contact?.agentId || 'coder';
    const contactWorkspace = payload.workspace || contact?.workspace || '';

    // 记录用户端发出的输入
    store.recordIncomingMessage({
      channel: payload.channel,
      fromId: payload.targetId,
      fromName: contact ? contact.name : payload.targetId,
      isRoom: contact ? contact.isRoom : false,
      roomId: contact?.isRoom ? payload.targetId : undefined,
      roomName: contact?.isRoom ? contact.name : undefined,
      text: payload.text,
    });

    try {
      // 触发智能体响应执行
      const orchestrator = new AgentOrchestrator(this.configPath ? { configPath: this.configPath } : {});
      await orchestrator.loadMcpTools();

      const res = await orchestrator.runTask({
        agentId: assignedAgent,
        input: payload.text,
        workspace: contactWorkspace || undefined,
        sessionKey: `${payload.channel}:manual:${payload.targetId}`,
      });

      const replyContent = res.text || '（任务执行完成，无输出文本）';
      store.recordOutgoingMessage({
        channel: payload.channel,
        contactId: payload.targetId,
        agentId: assignedAgent,
        text: replyContent,
      });

      return { ok: true, replyText: replyContent };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      store.recordOutgoingMessage({
        channel: payload.channel,
        contactId: payload.targetId,
        agentId: '系统',
        text: `[FAIL] 执行发生错误：${errorMsg}`,
      });
      return { ok: false, error: errorMsg };
    }
  }

  // 保持与现有微信 API 兼容
  listWeChatContacts(): WeChatContact[] {
    return this.listChannelContacts('wechat');
  }

  getWeChatMessages(contactId?: string): WeChatChatMessage[] {
    return this.getChannelMessages(contactId, 'wechat');
  }

  upsertWeChatContact(input: Partial<WeChatContact> & { id: string; name: string }): WeChatContact {
    return this.upsertChannelContact({
      ...input,
      channel: 'wechat',
    });
  }

  removeWeChatContact(id: string): boolean {
    return this.removeChannelContact(id, 'wechat');
  }

  async sendWeChatMessage(payload: {
    targetId: string;
    text: string;
    agentId?: string | undefined;
    workspace?: string | undefined;
  }): Promise<{ ok: boolean; replyText?: string | undefined; error?: string | undefined }> {
    return this.sendChannelMessage({
      channel: 'wechat',
      ...payload,
    });
  }

  // ==========================================
  // 多机器人实例管理中心 (Multi-Bot Instances Hub)
  // ==========================================
  async listBots(): Promise<GuiBotInstance[]> {
    return this.botControl.listBots();
  }

  async upsertBot(bot: GuiBotInstance): Promise<{ ok: boolean; bot: GuiBotInstance }> {
    const result = this.botControl.upsertBot(bot);
    this.info(`机器人实例 [${bot.name || bot.id}] 配置已保存并同步`);

    // GUI 服务器列表保留 boundBotId 展示字段；真实一对一约束由控制平面 SQLite 保证。
    const serverStore = RemoteServerStore.getInstance();
    serverStore.list().forEach((server) => {
      if (server.boundBotId === bot.id && server.id !== bot.boundServerId) {
        serverStore.upsert({ ...server, boundBotId: undefined });
      }
    });
    if (bot.boundServerId && bot.boundServerId !== 'local') {
      const server = serverStore.get(bot.boundServerId);
      if (server && server.boundBotId !== bot.id) {
        serverStore.upsert({ ...server, boundBotId: bot.id });
      }
    }
    return result;
  }

  async deleteBot(id: string): Promise<{ ok: boolean }> {
    const result = this.botControl.deleteBot(id);

    // 解除相关服务器的绑定
    const serverStore = RemoteServerStore.getInstance();
    serverStore.list().forEach(s => {
      if (s.boundBotId === id) {
        serverStore.upsert({ ...s, boundBotId: undefined });
      }
    });
    this.info(`机器人实例 [${id}] 已删除并解除服务器绑定`);
    return result;
  }

  async toggleBotStatus(id: string, enabled: boolean): Promise<{ ok: boolean; message: string; bot?: GuiBotInstance }> {
    const result = this.botControl.toggleBotStatus(id, enabled);
    this.info(result.message);
    return result;
  }

  async testBotConnection(bot: Partial<GuiBotInstance>): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
    const platform = bot.platform || 'telegram';
    if (platform === 'telegram') {
      const token = bot.config?.token || (bot.id ? this.botControl.readCredentialsForTest(bot.id)?.token : undefined);
      if (!token) return { ok: false, message: '请先输入 Telegram Bot Token' };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
        const data = await res.json() as { ok: boolean; result?: { id: number; is_bot: boolean; first_name: string; username: string } };
        if (data.ok && data.result) {
          return { ok: true, message: `🎉 握手成功！机器人：@${data.result.username} (${data.result.first_name})`, details: data.result };
        }
        return { ok: false, message: 'Telegram Token 校验失败：凭据无效或被封禁' };
      } catch (err) {
        const errorDesc = describeError(err);
        return {
          ok: false,
          message: `网络连接失败或超时（${errorDesc}）。提示：Telegram 官方接口 api.telegram.org 需在已启用代理的网络环境下访问，请检查本地代理工具是否开启系统代理/TUN模式。`,
        };
      }
    } else if (platform === 'qq') {
      const wsUrl = bot.config?.wsEndpoint || 'ws://127.0.0.1:3001';
      return { ok: true, message: `已配置 OneBot 监听地址: ${wsUrl}，保存后平台将自动建立长连接` };
    } else if (platform === 'feishu') {
      const appId = bot.config?.appId;
      const appSecret = bot.config?.appSecret || (bot.id ? this.botControl.readCredentialsForTest(bot.id)?.appSecret : undefined);
      if (!appId || !appSecret) return { ok: false, message: '飞书机器人需填写 App ID 和 App Secret' };
      return { ok: true, message: `飞书凭据就绪 (App ID: ${appId})，保存后将开启事件分发` };
    } else if (platform === 'dingtalk') {
      return { ok: true, message: '钉钉机器人凭据配置完成' };
    } else if (platform === 'wechat') {
      const configured = Boolean(bot.config?.puppetToken || (bot.id ? this.botControl.readCredentialsForTest(bot.id)?.botToken : undefined));
      if (configured) {
        return { ok: true, message: '已检测到 Wechaty Puppet 凭据，保存后将通过 Puppet 服务连接' };
      }
      return { ok: true, message: '个人微信扫码模式就绪，保存后请点击【立即弹出扫码面板】或前往微信通道扫码登录' };
    }
    return { ok: true, message: `${platform} 机器人配置已就绪` };
  }

  clearLogs(): object {
    this.logs.length = 0;
    return { ok: true };
  }

  logsSnapshot(): GuiLogEntry[] {
    return this.logs.slice(-120);
  }

  private resolver(): ConfigResolver {
    return new ConfigResolver(loadConfig({ path: this.configPath }), {}, process.env);
  }

  private targetStates(modelNames: string[]): Array<Record<string, unknown>> {
    const targets: GuiTarget[] = ['codex', 'claude', 'gemini', 'grok', 'openclaw'];
    return targets.map((target) => {
      const path = targetPath(target);
      const raw = target === 'codex' ? (existsSync(path) ? readFileSync(path, 'utf8') : '') : JSON.stringify(readJsonFile(path));
      const configured = modelNames.find((name) => raw.includes(name.split('/').at(-1) ?? name));
      return { target, path, exists: existsSync(path), configuredModel: configured };
    });
  }

  async listServers(): Promise<RemoteServerConfig[]> {
    return RemoteServerStore.getInstance().list();
  }

  async upsertServer(config: Partial<RemoteServerConfig> & { id: string; host: string }): Promise<RemoteServerConfig> {
    const saved = RemoteServerStore.getInstance().upsert(config);
    this.info(`已更新远程服务器配置：${saved.name} (${saved.host})`);
    return saved;
  }

  async removeServer(id: string): Promise<boolean> {
    const removed = RemoteServerStore.getInstance().remove(id);
    if (removed) this.info(`已移除远程服务器配置：${id}`);
    return removed;
  }


  async testServerBotAlert(payload: { serverId: string; botConfig: ServerBotConfig }): Promise<{ ok: boolean; message: string }> {
    const server = RemoteServerStore.getInstance().get(payload.serverId) || { name: payload.serverId, host: payload.serverId };
    const { channel, webhookUrl, targetId } = payload.botConfig;
    const nowStr = new Date().toLocaleString();
    const title = '🚨 [HAP 计算节点监控测试告警]';
    const content = `【节点名称】${server.name} (${server.host})\n【绑定智能体】${payload.botConfig.agentId || 'ops'}\n【通道状态】测试推送正常\n【时间】${nowStr}\n\n已成功连通告警机器人，当 CPU/内存/磁盘 超过阈值或节点离线时将自动推送并唤醒 Agent 自愈。`;

    if (channel === 'feishu') {
      if (!webhookUrl) return { ok: false, message: '请填写飞书 Webhook 地址' };
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msg_type: 'text',
            content: { text: `${title}\n${content}` },
          }),
        });
        const data = await res.json() as any;
        if (data.code === 0 || data.StatusCode === 0 || res.ok) {
          return { ok: true, message: '🎉 飞书告警卡片已成功推送到指定群聊！' };
        }
        return { ok: false, message: `飞书推送响应异常：${JSON.stringify(data)}` };
      } catch (err: any) {
        return { ok: false, message: `飞书 Webhook 连接失败：${err.message}` };
      }
    } else if (channel === 'wechat') {
      if (!webhookUrl) return { ok: false, message: '请填写企业微信 Webhook 地址' };
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
              content: `### ${title}\n> **节点名称**：<font color="info">${server.name} (${server.host})</font>\n> **负责智能体**：${payload.botConfig.agentId || 'ops'}\n> **告警测试**：<font color="comment">推送正常</font>\n> **时间**：${nowStr}`,
            },
          }),
        });
        const data = await res.json() as any;
        if (data.errcode === 0 || res.ok) {
          return { ok: true, message: '🎉 企微告警卡片已成功推送到群聊！' };
        }
        return { ok: false, message: `企微推送异常：${JSON.stringify(data)}` };
      } catch (err: any) {
        return { ok: false, message: `企微 Webhook 连接失败：${err.message}` };
      }
    } else if (channel === 'telegram') {
      const token = webhookUrl || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return { ok: false, message: '请填写 Telegram Bot Token 或在环境变量中设置' };
      const chatId = targetId?.trim() || '';
      if (!chatId) return { ok: false, message: '请填写接收告警的 Telegram Chat ID' };
      if (chatId === payload.serverId.trim()) {
        return {
          ok: false,
          message: 'Telegram Chat ID 不能填写服务器编号。请先私聊 Bot 发送 /start（群聊则把 Bot 加入群并发送一条消息），再填写真实 Chat ID。',
        };
      }
      if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(chatId)) {
        return {
          ok: false,
          message: 'Telegram Chat ID 格式无效，请填写数字 ID（群聊通常以 -100 开头）或 @用户名。',
        };
      }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `${title}\n\n${content}`,
          }),
        });
        const data = await res.json() as any;
        if (data.ok) {
          return { ok: true, message: '🎉 Telegram 告警消息已成功发送至指定 Chat！' };
        }
        const description = String(data.description || '');
        if (description.toLowerCase().includes('chat not found')) {
          return {
            ok: false,
            message: 'Telegram 找不到这个 Chat ID。请先在 Telegram 中私聊 Bot 发送 /start；如果是群聊，请把 Bot 加入群并发送一条消息，再填写真实 Chat ID。',
          };
        }
        if (description.toLowerCase().includes('bot is not a member') || description.toLowerCase().includes('forbidden')) {
          return {
            ok: false,
            message: 'Telegram 拒绝发送：请确认 Bot 已加入目标群聊且拥有发消息权限，并检查 Chat ID。',
          };
        }
        return { ok: false, message: `Telegram 发送失败：${description || JSON.stringify(data)}` };
      } catch (err: any) {
        return { ok: false, message: `Telegram 请求失败：${err.message}` };
      }
    } else {
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'server_alert_test',
              server: { id: payload.serverId, name: server.name, host: server.host },
              botConfig: payload.botConfig,
              timestamp: Date.now(),
            }),
          });
          return { ok: true, message: '🎉 通用 Webhook 告警测试请求已成功送达！' };
        } catch (err: any) {
          return { ok: false, message: `Webhook 请求失败：${err.message}` };
        }
      }
      return { ok: true, message: `[模拟测试] 已成功触发 ${channel.toUpperCase()} 告警测试流！` };
    }
  }

  async testServer(id: string): Promise<{ ok: boolean; mode: string; message: string; latencyMs: number; systemInfo?: RemoteSystemInfo }> {
    const server = RemoteServerStore.getInstance().get(id);
    if (!server) throw new Error(`未找到服务器：${id}`);
    return RemoteClientManager.getInstance().testConnection(server);
  }

  async installServer(id: string, onProgress?: (event: InstallProgressEvent) => void): Promise<{ ok: boolean; token: string; daemonPort: number; error?: string }> {
    const server = RemoteServerStore.getInstance().get(id);
    if (!server) throw new Error(`未找到服务器：${id}`);

    RemoteServerStore.getInstance().updateStatus(id, { status: 'installing' });
    this.info(`开始部署远端守护进程至：${server.name} (${server.host})`);

    const res = await installRemoteDaemon(server, (event) => {
      this.info(`[Install ${server.name}] ${event.message}`);
      if (onProgress) onProgress(event);
    });

    if (res.ok) {
      RemoteServerStore.getInstance().updateStatus(id, {
        status: 'online',
        token: res.token,
        daemonPort: res.daemonPort,
        lastConnectedAt: Date.now(),
      });
      this.info(`远端守护进程部署成功：${server.name} (端口: ${res.daemonPort})`);
    } else {
      RemoteServerStore.getInstance().updateStatus(id, {
        status: 'error',
        lastError: res.error,
      });
      this.error(`远端守护进程部署失败：${server.name} - ${res.error}`);
    }

    return res;
  }

  async getServerInfo(id?: string): Promise<any> {
    if (!id || id === 'host' || id === 'local') {
      const hostInfo = getHostSystemInfo();
      return {
        hostname: hostInfo.network.hostname,
        platform: hostInfo.os.platform,
        arch: hostInfo.os.arch,
        osRelease: hostInfo.os.release,
        uptimeSeconds: hostInfo.os.uptimeSeconds,
        cpuCount: hostInfo.cpu.cores,
        cpuModel: hostInfo.cpu.model,
        cpuUsagePercent: hostInfo.cpu.usagePercent,
        totalMemBytes: hostInfo.memory.totalBytes,
        freeMemBytes: hostInfo.memory.freeBytes,
        usedMemPercent: hostInfo.memory.usedPercent,
        loadAvg: hostInfo.loadAvg,
        nodeVersion: hostInfo.os.nodeVersion,
        timestamp: hostInfo.timestamp,
        os: {
          platform: hostInfo.os.platform,
          release: hostInfo.os.release,
          arch: hostInfo.os.arch,
          hostname: hostInfo.network.hostname,
        },
        cpu: {
          model: hostInfo.cpu.model,
          cores: hostInfo.cpu.cores,
        },
        memory: {
          total: hostInfo.memory.totalBytes,
          used: hostInfo.memory.usedBytes,
          free: hostInfo.memory.freeBytes,
          usagePercent: hostInfo.memory.usedPercent,
        },
        disk: {
          total: hostInfo.disk.totalBytes,
          used: hostInfo.disk.usedBytes,
          free: hostInfo.disk.freeBytes,
          usagePercent: hostInfo.disk.usedPercent,
          mount: hostInfo.disk.mount,
        },
        diskFreeBytes: hostInfo.disk.freeBytes,
        diskTotalBytes: hostInfo.disk.totalBytes,
        uptime: hostInfo.os.processUptimeSeconds,
      };
    }
    const server = RemoteServerStore.getInstance().get(id);
    if (!server) throw new Error(`未找到服务器：${id}`);
    return RemoteClientManager.getInstance().getSystemInfo(server);
  }

  async execServerCommand(payload: { id: string; command: string }): Promise<RemoteExecResult> {
    const server = RemoteServerStore.getInstance().get(payload.id);
    if (!server) throw new Error(`未找到服务器：${payload.id}`);
    this.info(`向远端 [${server.name}] 发送指令：${payload.command}`);
    return RemoteClientManager.getInstance().execCommand(server, payload.command);
  }

  private resolveRemoteServer(reference: string): RemoteServerConfig {
    const trimmed = reference.trim();
    const store = RemoteServerStore.getInstance();
    const server = store.get(trimmed) || store.list().find((item) => item.name === trimmed || item.host === trimmed);
    if (!server) throw new Error(`未找到远程服务器：${reference}`);
    return server;
  }

  async getServerProcesses(id: string, options?: { limit?: number }): Promise<RemoteProcessList> {
    const server = this.resolveRemoteServer(id);
    return RemoteClientManager.getInstance().listProcesses(server, options);
  }

  async killLocalProcess(pid: number, signal: RemoteProcessSignal = 'KILL'): Promise<RemoteProcessKillResult> {
    const normalizedPid = Number(pid);
    if (!Number.isSafeInteger(normalizedPid) || normalizedPid <= 1) {
      throw new Error('禁止终止系统受保护的核心进程 (PID <= 1)');
    }
    if (normalizedPid === process.pid || normalizedPid === process.ppid) {
      throw new Error('禁止终止当前平台管理服务进程');
    }
    if (signal !== 'TERM' && signal !== 'KILL') {
      throw new Error('无效的信号，仅支持 TERM 或 KILL');
    }

    try {
      process.kill(normalizedPid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
      this.info(`[LocalProcess] 已向本地进程 PID ${normalizedPid} 发送 ${signal} 信号`);
      return {
        pid: normalizedPid,
        signal,
        killed: true,
      };
    } catch (error: any) {
      if (error?.code === 'ESRCH') {
        return {
          pid: normalizedPid,
          signal,
          killed: true,
          message: `进程 PID ${normalizedPid} 已不存在`,
        };
      }
      if (error?.code === 'EPERM') {
        throw new Error(`权限不足：无法终止进程 PID ${normalizedPid} (EPERM)`);
      }
      throw new Error(`终止本地进程 PID ${normalizedPid} 失败：${error?.message || error}`);
    }
  }

  async killServerProcess(payload: {
    id?: string;
    serverId?: string;
    server?: string;
    pid: number;
    signal: RemoteProcessSignal;
    expectedStartTime?: string;
  }): Promise<RemoteProcessKillResult> {
    const reference = payload.id || payload.serverId || payload.server;
    if (!reference) throw new Error('服务器编号不能为空');
    if (reference === 'local' || reference === 'host') {
      return this.killLocalProcess(payload.pid, payload.signal);
    }
    const server = this.resolveRemoteServer(reference);
    return RemoteClientManager.getInstance().killProcess(
      server,
      payload.pid,
      payload.signal,
      payload.expectedStartTime,
    );
  }

  async scanDiskCleanable(server?: string): Promise<DiskScanReport> {
    if (server && server !== 'local' && server !== 'host') {
      const remoteServer = this.resolveRemoteServer(server);
      return RemoteClientManager.getInstance().scanDisk(remoteServer);
    }
    return scanLocalDisk();
  }

  async executeDiskCleanup(payload: { server?: string; itemIds?: string[] }): Promise<DiskCleanResult> {
    if (payload.server && payload.server !== 'local' && payload.server !== 'host') {
      const remoteServer = this.resolveRemoteServer(payload.server);
      return RemoteClientManager.getInstance().cleanDisk(remoteServer, payload.itemIds || ['all']);
    }
    const report = await scanLocalDisk();
    return cleanLocalDisk(payload.itemIds || ['all'], report);
  }

  async getIpGeoInfo(ip?: string): Promise<IpGeoInfo> {
    return lookupIpGeo(ip);
  }

  private info(message: string): void {
    this.logs.push({ at: new Date().toISOString(), level: 'info', message });
  }

  error(error: unknown): void {
    this.logs.push({ at: new Date().toISOString(), level: 'error', message: describeError(error) });
  }
}
