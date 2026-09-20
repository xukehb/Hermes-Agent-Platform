import { IlinkAccountStore } from '../channels/wechat/ilink/credential-store.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dialog, shell } from 'electron';
import { execa } from 'execa';
import { AgentOrchestrator } from '../agent/index.js';
import { WeChatChannel } from '../channels/wechat.js';
import {
  isWeChatRunning,
  captureWeChatWindow,
  parseWeChatScreen,
  getWeChatWindowBounds,
  type WeChatVisionParseResult,
  type WeChatWindowBounds,
} from '../channels/wechat/desktop-vision/index.js';
import { ChannelManager, TelegramChannel, createChannelHost, parseCommand, HELP_TEXT, ChannelContactStore, WeChatContactStore, FeishuChannel, QQChannel, type ChannelContact, type ChannelChatMessage, type ChannelDefaultPolicy, type ChannelName, type WeChatContact, type WeChatChatMessage } from '../channels/index.js';
import { BUILTIN_MODELS, BUILTIN_PROVIDERS, ConfigResolver, ConfigWriter, loadConfig, resolveConfigPath, sanitizeModelRef, type ModelPatch, type ProviderPatch, type ResolvedAgent, type ResolvedProvider } from '../config/index.js';
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
import { getGatewayService } from '../gateway/index.js';
import {
  getHostSystemInfo,
  scanLocalDisk,
  cleanLocalDisk,
  lookupIpGeo,
  checkOllamaStatus,
  startOllamaDaemon,
  pullOllamaModelStream,
  deleteOllamaModel as removeOllamaModel,
  getHardwareRecommendationProfile,
  OPEN_SOURCE_MODEL_CATALOG,
  type HostSystemInfo,
  type DiskScanReport,
  type DiskCleanResult,
  type IpGeoInfo,
  type OllamaStatusResult,
  type OllamaPullProgress,
  type HardwareRecommendationProfile,
  type ModelCategory,
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

export interface GuiHostingActivity {
  id: string;
  timestamp: number;
  timeStr: string;
  stage: 'detected' | 'thinking' | 'generated' | 'executing' | 'sent' | 'cooldown' | 'draft' | 'system' | 'scan';
  level: 'info' | 'success' | 'warning' | 'error';
  tag: string;
  title: string;
  detail?: string | undefined;
  target?: string | undefined;
  sender?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  model?: string | undefined;
  elapsedMs?: number | undefined;
}

interface GuiState {
  projects: GuiProject[];
  hiddenProviders?: string[];
  hiddenModels?: string[];
  defaultProvidersCleared?: boolean;
  skills?: GuiSkill[];
  plugins?: GuiPlugin[];
  permissions?: GuiPermissionConfig;
}

const DATA_DIR = process.env.HAP_GUI_DATA_DIR || join(homedir(), '.hap', 'gui');
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
  {
    id: 'img-skill-cyberpunk',
    name: '赛博朋克霓虹机能 (Cyberpunk Neo-Glow)',
    description: '强化未来主义都市机能感、高动态范围霓虹冷暖光交织、细致金属质感与全息投影细节',
    repo: 'image-skills/cyberpunk-glow',
    author: 'Hermes Studio',
    stars: 1850,
    tags: ['生图', 'Cyberpunk', 'Style'],
    installed: true,
    enabled: true,
    version: '1.0.0',
    category: 'image',
    promptTemplate: 'cyberpunk aesthetic, vibrant neon reflections, futuristic tech details, volumetric lighting, unreal engine 5 render, cinematic 8k, {{prompt}}',
    style: 'cyberpunk',
  },
  {
    id: 'img-skill-photoreal',
    name: '大师级胶片写实人像 (Master Film Portrait)',
    description: '模拟哈苏中画幅胶片相机质感、自然柔光微距、皮肤细腻纹理与浅景深虚化',
    repo: 'image-skills/film-portrait',
    author: 'Hermes Studio',
    stars: 2420,
    tags: ['生图', 'Portrait', 'Photoreal'],
    installed: true,
    enabled: true,
    version: '1.0.0',
    category: 'image',
    promptTemplate: 'shot on Hasselblad H6D-100c, 85mm f/1.4 lens, natural skin texture, soft rim lighting, shallow depth of field, photorealistic, raw candid style, {{prompt}}',
    style: 'photorealistic',
  },
  {
    id: 'img-skill-anime',
    name: '新海诚唯美动漫风景 (Makoto Shinkai Anime)',
    description: '呈现澄澈通透的天空与积雨云、高饱和青橙色调、细腻逆光与日系唯美画风',
    repo: 'image-skills/anime-shinkai',
    author: 'Hermes Studio',
    stars: 3100,
    tags: ['生图', 'Anime', 'Landscape'],
    installed: true,
    enabled: true,
    version: '1.0.0',
    category: 'image',
    promptTemplate: 'Makoto Shinkai style, CoMix Wave Films aesthetic, dramatic sky and cumulus clouds, vibrant teal and orange lighting, anime masterpiece, {{prompt}}',
    style: 'anime',
  },
  {
    id: 'img-skill-isometric',
    name: '等距轴测 3D 架构设计 (Isometric 3D)',
    description: '采用等距轴测视角、整洁现代微缩建筑/设备、柔和黏土质感与立体影棚布光',
    repo: 'image-skills/isometric-3d',
    author: 'Hermes Studio',
    stars: 1560,
    tags: ['生图', '3D', 'Isometric'],
    installed: true,
    enabled: true,
    version: '1.0.0',
    category: 'image',
    promptTemplate: 'isometric 3D render, blender 3d, clean architectural model, soft ambient occlusion, minimalist modern design, orthographic view, {{prompt}}',
    style: '3d-render',
  },
  {
    id: 'img-skill-ink',
    name: '东方意境水墨丹青 (Oriental Ink Wash)',
    description: '融合传统水墨留白、宣纸宣染渐变、写意山水笔触与淡雅东方美学',
    repo: 'image-skills/ink-wash',
    author: 'Hermes Studio',
    stars: 1290,
    tags: ['生图', 'Traditional', 'Art'],
    installed: true,
    enabled: true,
    version: '1.0.0',
    category: 'image',
    promptTemplate: 'traditional Chinese ink wash painting, shan shui style, Xuan paper texture, elegant brushstrokes, atmospheric mist, minimalist poetic composition, {{prompt}}',
    style: 'watercolor',
  },
  {
    id: 'img-skill-pixel',
    name: '复古 16-Bit 像素艺术 (Retro 16-Bit Pixel)',
    description: '经典 90 年代街机与点阵像素美学、限定复古色盘搭配与细腻像素阴影',
    repo: 'image-skills/pixel-art',
    author: 'Hermes Studio',
    stars: 1430,
    tags: ['生图', 'Pixel', 'Retro'],
    installed: true,
    enabled: true,
    version: '1.0.0',
    category: 'image',
    promptTemplate: '16-bit pixel art, retro gaming aesthetic, clean sprite work, vibrant limited color palette, detailed pixel shading, {{prompt}}',
    style: 'digital-art',
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
  let defaultProvidersCleared = true;
  let skills = DEFAULT_SKILLS;
  let plugins = DEFAULT_PLUGINS;
  let permissions = DEFAULT_PERMISSIONS;

  if (existsSync(STATE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as GuiState;
      projects = Array.isArray(raw.projects) ? raw.projects : [];
      hiddenProviders = Array.isArray(raw.hiddenProviders) ? raw.hiddenProviders : [];
      hiddenModels = Array.isArray(raw.hiddenModels) ? raw.hiddenModels : [];
      if (raw.skills && raw.skills.length > 0) {
        const existingSkillIds = new Set(raw.skills.map((s) => s.id));
        const mergedSkills = [...raw.skills];
        for (const ds of DEFAULT_SKILLS) {
          if (!existingSkillIds.has(ds.id)) {
            mergedSkills.push(ds);
          }
        }
        skills = mergedSkills;
      }
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
    // 仅在首次创建状态文件时，默认初始化当前工作区为初始工程，并清空默认内置服务商
    const cwd = process.cwd();
    const defaultProject: GuiProject = {
      id: randomUUID(),
      name: basename(cwd) || 'Hermes Agent Platform',
      path: cwd,
      addedAt: new Date().toISOString(),
    };
    projects = [defaultProject];
    hiddenProviders = Object.keys(BUILTIN_PROVIDERS);
    hiddenModels = Object.keys(BUILTIN_MODELS);
    defaultProvidersCleared = true;
    writeState({
      projects,
      hiddenProviders,
      hiddenModels,
      defaultProvidersCleared,
      skills,
      plugins,
      permissions,
    });
  }

  // 若处于默认服务商已清空模式且隐藏列表为空（如升级兼容），则默认隐藏全部内置项
  if (defaultProvidersCleared && hiddenProviders.length === 0) {
    hiddenProviders = Object.keys(BUILTIN_PROVIDERS);
    hiddenModels = Object.keys(BUILTIN_MODELS);
  }

  return {
    projects,
    hiddenProviders,
    hiddenModels,
    defaultProvidersCleared,
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
  private readonly activeOllamaPulls = new Map<string, AbortController>();
  private readonly hostingActivities: GuiHostingActivity[] = [];
  private readonly hostingActivityListeners = new Set<(activity: GuiHostingActivity) => void>();

  constructor(
    private readonly configPath = resolveConfigPath(undefined, process.env),
  ) {}

  snapshot(): object {
    loadSavedEnvIntoProcess();
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
      defaultModel: resolver.resolveDefaultModel(),
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

  clearDefaultProviders(): object {
    const builtinIds = Object.keys(BUILTIN_PROVIDERS);
    const builtinModelAliases = Object.keys(BUILTIN_MODELS);
    const state = readState();
    state.hiddenProviders = Array.from(new Set([...(state.hiddenProviders || []), ...builtinIds]));
    state.hiddenModels = Array.from(new Set([...(state.hiddenModels || []), ...builtinModelAliases]));
    state.defaultProvidersCleared = true;
    writeState(state);

    const writer = new ConfigWriter(this.configPath);
    for (const id of builtinIds) {
      try {
        writer.removeProvider(id);
      } catch {
        // 允许预置项不存在于 config.toml 中
      }
    }
    for (const alias of builtinModelAliases) {
      try {
        writer.removeModel(alias);
      } catch {
        // 忽略
      }
    }
    this.info(`已清空全部默认服务商 (${builtinIds.length} 个) 及内置模型`);
    return { ok: true, clearedProvidersCount: builtinIds.length, clearedModelsCount: builtinModelAliases.length };
  }

  restoreDefaultProviders(): object {
    const builtinIds = new Set(Object.keys(BUILTIN_PROVIDERS));
    const builtinModelAliases = new Set(Object.keys(BUILTIN_MODELS));
    const state = readState();
    state.hiddenProviders = (state.hiddenProviders || []).filter((id) => !builtinIds.has(id));
    state.hiddenModels = (state.hiddenModels || []).filter((m) => !builtinModelAliases.has(m));
    state.defaultProvidersCleared = false;
    writeState(state);
    this.info('已恢复默认服务商预置');
    return { ok: true };
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
      capabilities: input.capabilities,
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
    this.reloadRunningChannels();
    return result;
  }

  setDefaultAgent(rawId: string): object {
    const id = rawId.trim();
    const resolver = this.resolver();
    if (!resolver.listAgentIds().includes(id)) {
      throw new Error(`智能体 ${id} 不存在，无法设为默认`);
    }
    const result = new ConfigWriter(this.configPath).setGlobals({ defaultAgent: id });
    this.info('已设置默认智能体：' + id);
    this.reloadRunningChannels();
    return result;
  }

  setDefaultModel(rawAlias: string): object {
    const alias = rawAlias.trim();
    if (!alias) throw new Error('模型标识不能为空');
    const resolver = this.resolver();
    const models = resolver.resolveModels();
    const found = models.get(alias) || [...models.values()].find((m) => m.alias === alias || m.fullName === alias);
    if (!found) {
      throw new Error(`模型 "${alias}" 未在已注册模型目录中找到，无法设为默认模型`);
    }
    const result = new ConfigWriter(this.configPath).setGlobals({ defaultModel: alias });
    this.info('已设置全局默认模型：' + alias);
    this.reloadRunningChannels();
    return result;
  }

  async testModel(rawAlias: string): Promise<{ ok: boolean; latencyMs?: number; preview?: string; error?: string }> {
    const alias = rawAlias.trim();
    if (!alias) return { ok: false, error: '请指定要测试的模型名称' };

    const resolver = this.resolver();
    const models = resolver.resolveModels();
    const modelEntry = models.get(alias) || [...models.values()].find((m) => m.alias === alias || m.fullName === alias);
    if (!modelEntry) {
      return { ok: false, error: `未在模型目录中找到模型 "${alias}"` };
    }

    const providerId = modelEntry.providerId;
    const provider = resolver.resolveProviders().get(providerId);
    if (!provider) {
      return { ok: false, error: `模型所属服务商 "${providerId}" 未找到` };
    }

    const saved = readSavedEnv();
    const envKey = provider.envKey || `${providerId.toUpperCase()}_API_KEY`;
    const apiKey = (provider.envKey ? process.env[provider.envKey] || saved[provider.envKey] : undefined)
      || process.env[envKey] || saved[envKey] || process.env[`${providerId.toUpperCase()}_API_KEY`];

    const tempEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (apiKey) {
      tempEnv[envKey] = apiKey;
    }

    const tempMap = new Map<string, ResolvedProvider>([[providerId, provider]]);
    const registry = new ProviderRegistry(tempMap, { env: tempEnv });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const started = Date.now();

    try {
      let preview = '';
      const realModelName = modelEntry.model || modelEntry.alias;
      for await (const event of registry.client(providerId).send(
        {
          model: realModelName,
          messages: [{ role: 'user', content: 'Say "OK"' }],
          params: {},
          maxTokens: 16,
        },
        controller.signal
      )) {
        if (event.type === 'text_delta') {
          preview += event.text;
        } else if (event.type === 'finish') {
          break;
        }
      }
      const latencyMs = Date.now() - started;
      this.info(`测试模型 ${alias} (${realModelName}) 成功，耗时 ${latencyMs}ms`);
      return {
        ok: true,
        latencyMs,
        preview: preview.trim() || 'OK',
      };
    } catch (err) {
      const msg = describeError(err);
      const isTimeout = msg.includes('aborted') || msg.includes('timeout') || controller.signal.aborted;
      const errorText = isTimeout ? '模型请求超时 (12s)' : msg;
      this.error(`测试模型 ${alias} 失败：${errorText}`);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: errorText,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  removeAgent(rawId: string): object {
    const id = rawId.trim();
    const result = removeGuiAgent(this.configPath, id);
    this.info('已删除智能体配置：' + id);
    this.reloadRunningChannels();
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

    const providerId = input.providerId?.trim() || '';
    const model = input.model?.trim() || '';
    const provider = allProviders.get(providerId);
    const usedEngine = `${providerId} (${model})`;
    if (!provider || !model || !provider.baseUrl) {
      return { ok: false, prompt, width, height, engineUsed: usedEngine, error: '请选择已配置的服务商及生图模型，并配置服务商 Base URL' };
    }
    const baseUrl = provider.baseUrl;
    const apiKey = (provider.envKey ? process.env[provider.envKey] || savedEnv[provider.envKey] : undefined)
      || process.env[`${providerId.toUpperCase()}_API_KEY`] || savedEnv[`${providerId.toUpperCase()}_API_KEY`] || '';

    try {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      // 保留服务商配置的版本路径，例如智谱的 /api/paas/v4。
      const endpoint = new URL(cleanBase).pathname === '/'
        ? `${cleanBase}/v1/images/generations` : `${cleanBase}/images/generations`;
      const sizeStr = `${width}x${height}`;
      const styleDesc = input.style ? `${input.style} style, ` : '';
      const fullPrompt = `${prompt}${styleDesc ? ` (${styleDesc.trim()})` : ''}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 40000);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...provider.httpHeaders,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          prompt: fullPrompt,
          model,
          n: 1,
          size: sizeStr,
          ...(model === 'dall-e-3' ? { style: input.style === 'natural' ? 'natural' : 'vivid' } : {}),
          ...(model.startsWith('dall-e-') ? { response_format: 'b64_json' } : {}),
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
      return {
        ok: false, prompt, width, height, engineUsed: usedEngine,
        error: `${usedEngine} 生图失败：${errorMsg}。请检查服务商配置及所选模型是否支持生图接口。`,
      };
    }
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
      const modelsEndpoint = new URL(cleanBaseUrl).pathname === '/' ? `${cleanBaseUrl}/v1/models` : `${cleanBaseUrl}/models`;

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

  importSkill(skillData: Partial<GuiSkill>): GuiSkill {
    const name = skillData.name?.trim();
    if (!name) throw new Error('Skill 名称不能为空');

    const state = readState();
    const skills = state.skills || DEFAULT_SKILLS;
    const id = skillData.id?.trim() || `skill-custom-${Date.now()}`;

    const newSkill: GuiSkill = {
      id,
      name,
      description: skillData.description?.trim() || '自定义生图或能力扩展 Skill',
      repo: skillData.repo || 'local/custom-skill',
      author: skillData.author || 'Custom',
      stars: skillData.stars || 100,
      tags: Array.isArray(skillData.tags) && skillData.tags.length > 0 ? skillData.tags : ['Image', 'Custom'],
      installed: true,
      enabled: true,
      version: skillData.version || '1.0.0',
      category: skillData.category || 'image',
      promptTemplate: skillData.promptTemplate?.trim() || '',
      negativePrompt: skillData.negativePrompt?.trim() || '',
      style: skillData.style || 'vivid',
    };

    const existingIdx = skills.findIndex((s) => s.id === id);
    if (existingIdx >= 0) {
      skills[existingIdx] = newSkill;
    } else {
      skills.unshift(newSkill);
    }
    state.skills = skills;
    writeState(state);
    this.info(`已成功导入 Skill: ${newSkill.name} (${id})`);
    return newSkill;
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
        isMerging: false,
        isRebasing: false,
      };
    }

    let isMerging = false;
    let isRebasing = false;
    try {
      const gitDirRes = await execa('git', ['rev-parse', '--git-dir'], { cwd: projectPath });
      const gitDir = gitDirRes.stdout.trim();
      const absGitDir = isAbsolute(gitDir) ? gitDir : join(projectPath, gitDir);
      isMerging = existsSync(join(absGitDir, 'MERGE_HEAD'));
      isRebasing = existsSync(join(absGitDir, 'rebase-merge')) || existsSync(join(absGitDir, 'rebase-apply'));
    } catch {}

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

    const changedFiles: Array<{ status: string; file: string; additions: number; deletions: number; isStaged?: boolean }> = [];
    const stagedFiles: Array<{ status: string; file: string; additions: number; deletions: number; isStaged: true }> = [];
    const unstagedFiles: Array<{ status: string; file: string; additions: number; deletions: number; isStaged: false }> = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    try {
      const sRes = await execa('git', ['status', '--porcelain'], { cwd: projectPath });
      const lines = sRes.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      for (const line of lines) {
        if (line.length < 3) continue;
        const indexStatus = line[0] || ' ';
        const workingStatus = line[1] || ' ';
        let file = line.slice(3).trim();
        if (file.includes(' -> ')) {
          const parts = file.split(' -> ');
          file = (parts[1] || parts[0] || '').trim();
        }

        let adds = 0;
        let dels = 0;

        if (numstatMap.has(file)) {
          const stat = numstatMap.get(file)!;
          adds = stat.additions;
          dels = stat.deletions;
        } else if (indexStatus === '?' || workingStatus === '?' || indexStatus === 'A') {
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

        const isStaged = indexStatus !== ' ' && indexStatus !== '?';
        const isUnstaged = workingStatus !== ' ' || indexStatus === '?';

        changedFiles.push({
          status: line.slice(0, 2).trim(),
          file,
          additions: adds,
          deletions: dels,
          isStaged,
        });

        if (isStaged) {
          stagedFiles.push({
            status: indexStatus,
            file,
            additions: adds,
            deletions: dels,
            isStaged: true,
          });
        }
        if (isUnstaged) {
          unstagedFiles.push({
            status: workingStatus === ' ' ? indexStatus : workingStatus === '?' ? 'U' : workingStatus,
            file,
            additions: adds,
            deletions: dels,
            isStaged: false,
          });
        }
      }
    } catch {}

    const recentCommits: Array<{ hash: string; shortHash?: string; message: string; isStash?: boolean; relativeDate?: string }> = [];
    try {
      const logRes = await execa('git', ['log', '-n', '5', '--format=%H%x09%h%x09%an%x09%ad%x09%ar%x09%s'], { cwd: projectPath });
      const lines = logRes.stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        const [p0, p1, , , p4] = parts;
        if (parts.length >= 6 && p0 && p1 && p4) {
          const hash = p0.trim();
          const shortHash = p1.trim();
          const message = parts.slice(5).join('\t').trim();
          const isStash = /^\s*(\[暂存\]|stash:?|\[stash\])/i.test(message) || message.includes('[暂存]');
          recentCommits.push({
            hash,
            shortHash,
            message,
            isStash,
            relativeDate: p4.trim(),
          });
        } else {
          const spaceIdx = line.indexOf(' ');
          if (spaceIdx > 0) {
            const hash = line.slice(0, spaceIdx);
            const message = line.slice(spaceIdx + 1);
            recentCommits.push({
              hash,
              shortHash: hash.slice(0, 7),
              message,
              isStash: message.includes('[暂存]'),
            });
          }
        }
      }
    } catch {}

    const firstCommit = recentCommits[0];
    const isLatestStash = !!firstCommit?.isStash;
    const latestCommit = firstCommit;

    return {
      isRepo: true,
      branch,
      remoteUrl,
      changedFiles,
      stagedFiles,
      unstagedFiles,
      stagedCount: stagedFiles.length,
      unstagedCount: unstagedFiles.length,
      uncommittedCount: changedFiles.length,
      totalAdditions,
      totalDeletions,
      recentCommits,
      latestCommit,
      isLatestStash,
      isMerging,
      isRebasing,
    };
  }

  async gitCommit(projectPath: string, message: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    if (!message || !message.trim()) throw new Error('Commit message 不能为空');

    // 检查是否已有暂存区文件 (Staged Changes)
    let hasStaged = false;
    try {
      const diffRes = await execa('git', ['diff', '--cached', '--name-only'], { cwd: projectPath });
      hasStaged = diffRes.stdout.split('\n').filter((l) => l.trim().length > 0).length > 0;
    } catch {}

    if (!hasStaged) {
      // 若没有单独暂存任何文件，则默认暂存全部改动后提交
      await execa('git', ['add', '-A'], { cwd: projectPath });
    }

    const res = await execa('git', ['commit', '-m', message.trim()], { cwd: projectPath });
    this.info(`Git 提交成功 [${projectPath}]: ${message.trim()}`);
    return { ok: true, summary: res.stdout || '提交成功' };
  }

  async gitStashCommit(
    projectPath: string,
    message?: string
  ): Promise<{ ok: boolean; summary: string; hash?: string; isStash: boolean }> {
    if (!projectPath) throw new Error('未指定项目路径');

    const sRes = await execa('git', ['status', '--porcelain'], { cwd: projectPath });
    const changedLines = sRes.stdout.split('\n').filter((l) => l.trim().length > 0);
    if (changedLines.length === 0) {
      throw new Error('当前工作区无任何未提交的修改，无需暂存');
    }

    const changedCount = changedLines.length;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let commitMsg = (message || '').trim();
    if (!commitMsg) {
      commitMsg = `[暂存] ${timeStr} 工作区代码快照 (${changedCount} 个文件)`;
    } else if (!commitMsg.startsWith('[暂存]') && !commitMsg.toLowerCase().startsWith('stash:')) {
      commitMsg = `[暂存] ${commitMsg}`;
    }

    await execa('git', ['add', '-A'], { cwd: projectPath });
    const res = await execa('git', ['commit', '-m', commitMsg], { cwd: projectPath });

    let hash = '';
    try {
      const revRes = await execa('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
      hash = revRes.stdout.trim();
    } catch {}

    this.info(`Git 暂存提交成功 [${projectPath}]: ${commitMsg} (${hash.slice(0, 7)})`);
    return { ok: true, summary: res.stdout || '暂存快照创建成功', hash, isStash: true };
  }

  async gitGetCommitHistory(
    projectPath: string,
    limit: number = 20
  ): Promise<{
    ok: boolean;
    commits: Array<{
      hash: string;
      shortHash: string;
      author: string;
      date: string;
      relativeDate: string;
      message: string;
      isStash: boolean;
    }>;
  }> {
    if (!projectPath) throw new Error('未指定项目路径');
    const commits: Array<{
      hash: string;
      shortHash: string;
      author: string;
      date: string;
      relativeDate: string;
      message: string;
      isStash: boolean;
    }> = [];

    try {
      const logRes = await execa(
        'git',
        ['log', `-n`, String(Math.max(1, limit)), '--format=%H%x09%h%x09%an%x09%ad%x09%ar%x09%s'],
        { cwd: projectPath }
      );
      const lines = logRes.stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        const [p0, p1, p2, p3, p4] = parts;
        if (parts.length >= 6 && p0 !== undefined && p1 !== undefined && p2 !== undefined && p3 !== undefined && p4 !== undefined) {
          const hash = p0.trim();
          const shortHash = p1.trim();
          const author = p2.trim();
          const date = p3.trim();
          const relativeDate = p4.trim();
          const message = parts.slice(5).join('\t').trim();
          const isStash = /^\s*(\[暂存\]|stash:?|\[stash\])/i.test(message) || message.includes('[暂存]');
          commits.push({
            hash,
            shortHash,
            author,
            date,
            relativeDate,
            message,
            isStash,
          });
        }
      }
    } catch {}

    return { ok: true, commits };
  }

  async gitRollbackCommit(
    projectPath: string,
    commitHash?: string,
    mode: 'soft' | 'mixed' | 'hard' = 'mixed'
  ): Promise<{ ok: boolean; message: string }> {
    if (!projectPath) throw new Error('未指定项目路径');

    const target = commitHash && commitHash.trim() ? commitHash.trim() : 'HEAD~1';
    const flag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';

    try {
      await execa('git', ['reset', flag, target], { cwd: projectPath });
      let actionDesc = '回滚并保留所有修改到工作区（未提交状态）';
      if (mode === 'soft') actionDesc = '回滚到暂存区（已暂存状态）';
      if (mode === 'hard') actionDesc = '强制回滚并丢弃后续修改';

      this.info(`Git 回滚成功 [${projectPath}] 目标: ${target}, 模式: ${mode}`);
      return { ok: true, message: `已成功${actionDesc}！` };
    } catch (error: any) {
      const stderr = error?.stderr || error?.stdout || error?.message || String(error);
      throw new Error(`回滚失败: ${stderr}`);
    }
  }

  async gitRevertCommit(projectPath: string, commitHash: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !commitHash) throw new Error('参数缺失：项目路径或 commitHash 为空');
    try {
      const res = await execa('git', ['revert', '--no-edit', commitHash.trim()], { cwd: projectPath });
      this.info(`Git 撤销提交成功 [${projectPath}]: ${commitHash}`);
      return { ok: true, message: res.stdout || `已成功撤销提交 ${commitHash.slice(0, 7)}` };
    } catch (error: any) {
      const stderr = error?.stderr || error?.stdout || error?.message || String(error);
      throw new Error(`撤销提交失败: ${stderr}`);
    }
  }

  async gitShowCommit(projectPath: string, commitHash: string): Promise<{ ok: boolean; diff: string }> {
    if (!projectPath || !commitHash) throw new Error('参数缺失：项目路径或 commitHash 为空');
    try {
      const res = await execa('git', ['show', '--stat', '-p', commitHash.trim()], { cwd: projectPath });
      return { ok: true, diff: res.stdout || '（该提交无代码改动内容）' };
    } catch (error: any) {
      const stderr = error?.stderr || error?.stdout || error?.message || String(error);
      throw new Error(`获取提交内容失败: ${stderr}`);
    }
  }

  async gitPush(projectPath: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    try {
      const res = await execa('git', ['push'], {
        cwd: projectPath,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      this.info(`Git 推送成功 [${projectPath}]`);
      return { ok: true, summary: res.stdout || res.stderr || '推送成功' };
    } catch (error: any) {
      const stderr = error?.stderr || error?.stdout || error?.message || String(error);
      if (
        stderr.includes('could not read Username') ||
        stderr.includes('Authentication failed') ||
        stderr.includes('Permission denied (publickey)') ||
        stderr.includes('Invalid username or password')
      ) {
        throw new Error('AUTH_REQUIRED: 远端仓库需要身份验证。请配置 SSH 密钥或 GitHub Personal Access Token。');
      }
      if (stderr.includes('has no upstream branch') || stderr.includes('set-upstream')) {
        throw new Error('BRANCH_UPSTREAM_REQUIRED: 当前分支尚未关联远端分支，请在终端执行一次 git push -u origin <当前分支名>');
      }
      throw new Error(`Git 推送失败: ${stderr}`);
    }
  }

  async gitPull(projectPath: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    try {
      const res = await execa('git', ['pull'], {
        cwd: projectPath,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      this.info(`Git 拉取成功 [${projectPath}]`);
      return { ok: true, summary: res.stdout || res.stderr || '拉取完成' };
    } catch (error: any) {
      const stderr = error?.stderr || error?.stdout || error?.message || String(error);
      if (
        stderr.includes('could not read Username') ||
        stderr.includes('Authentication failed') ||
        stderr.includes('Permission denied (publickey)') ||
        stderr.includes('Invalid username or password')
      ) {
        throw new Error('AUTH_REQUIRED: 远端仓库需要身份验证。请配置 SSH 密钥或 GitHub Personal Access Token。');
      }
      throw error;
    }
  }

  async getGitAuthInfo(projectPath: string): Promise<{
    remoteUrl: string;
    isSsh: boolean;
    hasSshKey: boolean;
    sshPublicKey: string;
  }> {
    if (!projectPath) throw new Error('未指定项目路径');
    let remoteUrl = '';
    try {
      const res = await execa('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
      remoteUrl = res.stdout.trim();
    } catch {
      // 忽略无 origin 错误
    }

    const isSsh = remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://');

    const userHomedir = homedir();
    const edKeyPath = join(userHomedir, '.ssh', 'id_ed25519.pub');
    const rsaKeyPath = join(userHomedir, '.ssh', 'id_rsa.pub');

    let hasSshKey = false;
    let sshPublicKey = '';

    if (existsSync(edKeyPath)) {
      hasSshKey = true;
      sshPublicKey = readFileSync(edKeyPath, 'utf8').trim();
    } else if (existsSync(rsaKeyPath)) {
      hasSshKey = true;
      sshPublicKey = readFileSync(rsaKeyPath, 'utf8').trim();
    }

    return {
      remoteUrl,
      isSsh,
      hasSshKey,
      sshPublicKey,
    };
  }

  async configureGitSsh(projectPath: string): Promise<{
    ok: boolean;
    remoteUrl: string;
    sshPublicKey: string;
  }> {
    if (!projectPath) throw new Error('未指定项目路径');
    const userHomedir = homedir();
    const sshDir = join(userHomedir, '.ssh');
    const edKeyPath = join(sshDir, 'id_ed25519');
    const edPubPath = join(sshDir, 'id_ed25519.pub');

    if (!existsSync(sshDir)) {
      mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    }

    if (!existsSync(edPubPath)) {
      await execa('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', edKeyPath]);
    }

    const sshPublicKey = readFileSync(edPubPath, 'utf8').trim();

    let newRemoteUrl = '';
    try {
      const res = await execa('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
      const currentUrl = res.stdout.trim();
      if (currentUrl.startsWith('https://github.com/')) {
        const pathPart = currentUrl.replace('https://github.com/', '');
        newRemoteUrl = `git@github.com:${pathPart}`;
        await execa('git', ['remote', 'set-url', 'origin', newRemoteUrl], { cwd: projectPath });
        this.info(`已将远程仓库转换为 SSH 格式: ${newRemoteUrl}`);
      } else {
        newRemoteUrl = currentUrl;
      }
    } catch {
      // 忽略
    }

    return {
      ok: true,
      remoteUrl: newRemoteUrl,
      sshPublicKey,
    };
  }

  async configureGitToken(
    projectPath: string,
    username: string,
    token: string
  ): Promise<{ ok: boolean; message: string }> {
    if (!username || !username.trim()) throw new Error('请输入 GitHub 用户名');
    if (!token || !token.trim()) throw new Error('请输入 GitHub Personal Access Token');

    const cleanUsername = username.trim();
    const cleanToken = token.trim();
    await execa('git', ['config', '--global', 'credential.helper', 'store']);

    // 清除已有的 github.com 缓存，避免旧失效 Token 残留导致鉴权失败
    // 使用 -c credential.helper= -c credential.helper=store 确保仅调用标准文本 store，避免 macOS osxkeychain 等系统外部助手在无 TTY 阻塞
    try {
      await execa('git', ['-c', 'credential.helper=', '-c', 'credential.helper=store', 'credential', 'reject'], {
        input: 'protocol=https\nhost=github.com\n\n',
        timeout: 4000,
      });
    } catch {
      // 容错继续
    }

    const credentialPayload = `protocol=https\nhost=github.com\nusername=${cleanUsername}\npassword=${cleanToken}\n\n`;
    await execa('git', ['-c', 'credential.helper=', '-c', 'credential.helper=store', 'credential', 'approve'], {
      input: credentialPayload,
      timeout: 4000,
    });

    try {
      const res = await execa('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
      const currentUrl = res.stdout.trim();
      if (currentUrl.startsWith('git@github.com:')) {
        const repoPath = currentUrl.replace('git@github.com:', '');
        const httpsUrl = `https://github.com/${repoPath}`;
        await execa('git', ['remote', 'set-url', 'origin', httpsUrl], { cwd: projectPath });
      }
    } catch {
      // 忽略
    }

    this.info(`Git 凭据已保存至系统 (用户: ${cleanUsername})`);
    return { ok: true, message: 'GitHub 凭据已成功保存！' };
  }

  async gitListBranches(projectPath: string): Promise<{
    ok: boolean;
    currentBranch: string;
    localBranches: Array<{ name: string; isCurrent: boolean; upstream?: string | undefined; lastCommit?: string | undefined }>;
    remoteBranches: Array<{ name: string; lastCommit?: string | undefined }>;
    isMerging: boolean;
    isRebasing: boolean;
  }> {
    if (!projectPath) throw new Error('未指定项目路径');

    let currentBranch = 'main';
    try {
      const bRes = await execa('git', ['branch', '--show-current'], { cwd: projectPath });
      currentBranch = bRes.stdout.trim() || 'HEAD';
    } catch {}

    let isMerging = false;
    let isRebasing = false;
    try {
      const gitDirRes = await execa('git', ['rev-parse', '--git-dir'], { cwd: projectPath });
      const gitDir = gitDirRes.stdout.trim();
      const absGitDir = isAbsolute(gitDir) ? gitDir : join(projectPath, gitDir);
      isMerging = existsSync(join(absGitDir, 'MERGE_HEAD'));
      isRebasing = existsSync(join(absGitDir, 'rebase-merge')) || existsSync(join(absGitDir, 'rebase-apply'));
    } catch {}

    const localBranches: Array<{ name: string; isCurrent: boolean; upstream?: string | undefined; lastCommit?: string | undefined }> = [];
    const remoteBranches: Array<{ name: string; lastCommit?: string | undefined }> = [];

    try {
      const res = await execa(
        'git',
        ['branch', '-a', '--format=%(refname)|%(refname:short)|%(HEAD)|%(upstream:short)|%(subject)'],
        { cwd: projectPath, env: { ...process.env, LC_ALL: 'C' } }
      );
      const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

      const seenLocal = new Set<string>();
      const seenRemote = new Set<string>();

      for (const line of lines) {
        const parts = line.split('|');
        const refName = parts[0]?.trim() || '';
        const shortName = parts[1]?.trim() || '';
        const headMarker = parts[2]?.trim();
        const upstream = parts[3]?.trim() || undefined;
        const lastCommit = parts[4]?.trim() || undefined;

        if (!shortName || shortName === 'origin' || shortName.endsWith('/HEAD')) {
          continue;
        }

        if (refName.startsWith('refs/remotes/')) {
          if (!seenRemote.has(shortName)) {
            seenRemote.add(shortName);
            remoteBranches.push({
              name: shortName,
              lastCommit,
            });
          }
        } else {
          if (!seenLocal.has(shortName)) {
            seenLocal.add(shortName);
            localBranches.push({
              name: shortName,
              isCurrent: headMarker === '*' || shortName === currentBranch,
              upstream,
              lastCommit,
            });
          }
        }
      }
    } catch (error) {
      this.error(`获取分支列表异常: ${error}`);
    }

    return {
      ok: true,
      currentBranch,
      localBranches,
      remoteBranches,
      isMerging,
      isRebasing,
    };
  }

  async gitCheckoutBranch(
    projectPath: string,
    branchName: string,
    createNew?: boolean
  ): Promise<{ ok: boolean; currentBranch: string; message: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    if (!branchName || !branchName.trim()) throw new Error('分支名称不能为空');
    const target = branchName.trim();
    try {
      if (createNew) {
        await execa('git', ['checkout', '-b', target], {
          cwd: projectPath,
          env: { ...process.env, LC_ALL: 'C' },
        });
        this.info(`已创建并切换到新分支 [${projectPath}]: ${target}`);
        return { ok: true, currentBranch: target, message: `已成功创建并切换至新分支「${target}」` };
      } else {
        await execa('git', ['checkout', target], {
          cwd: projectPath,
          env: { ...process.env, LC_ALL: 'C' },
        });
        this.info(`已切换分支 [${projectPath}]: ${target}`);
        return { ok: true, currentBranch: target, message: `已成功切换至分支「${target}」` };
      }
    } catch (error: any) {
      const msg = error?.stderr || error?.stdout || error?.message || String(error);
      if (
        msg.includes('Your local changes to the following files would be overwritten') ||
        msg.includes('本地修改')
      ) {
        throw new Error('切换分支失败：本地有未提交的代码修改，与目标分支存在冲突。请先在提交面板提交或暂存更改。');
      }
      throw new Error(`切换分支失败: ${msg}`);
    }
  }

  async gitMergeBranch(
    projectPath: string,
    targetBranch: string,
    options?: { noFf?: boolean; squash?: boolean }
  ): Promise<{ ok: boolean; message: string; hasConflict: boolean }> {
    if (!projectPath) throw new Error('未指定项目路径');
    if (!targetBranch || !targetBranch.trim()) throw new Error('未指定待合并的分支');

    const args = ['merge'];
    if (options?.noFf) args.push('--no-ff');
    if (options?.squash) args.push('--squash');
    args.push(targetBranch.trim());

    try {
      const res = await execa('git', args, {
        cwd: projectPath,
        env: { ...process.env, LC_ALL: 'C' },
      });
      this.info(`已合并分支 [${projectPath}]: ${targetBranch}`);
      return { ok: true, hasConflict: false, message: res.stdout || '分支合并成功！' };
    } catch (error: any) {
      const msg = error?.stderr || error?.stdout || error?.message || String(error);
      if (
        msg.includes('CONFLICT') ||
        msg.includes('Automatic merge failed') ||
        msg.includes('冲突') ||
        msg.includes('自动合并失败')
      ) {
        return {
          ok: false,
          hasConflict: true,
          message: '[注意] 合并时检测到代码冲突！冲突文件已在列表中标红，请解决冲突后提交，或点击「终止合并」。',
        };
      }
      throw new Error(`合并分支失败: ${msg}`);
    }
  }

  async gitMergeAbort(projectPath: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    try {
      await execa('git', ['merge', '--abort'], { cwd: projectPath });
      this.info(`已终止合并 [${projectPath}]`);
      return { ok: true, message: '已成功终止合并，工作区已安全恢复到合并前状态。' };
    } catch (error: any) {
      throw new Error(`终止合并失败: ${error?.message || error}`);
    }
  }

  async gitRebaseBranch(
    projectPath: string,
    targetBranch: string
  ): Promise<{ ok: boolean; message: string; hasConflict: boolean }> {
    if (!projectPath) throw new Error('未指定项目路径');
    if (!targetBranch || !targetBranch.trim()) throw new Error('未指定变基基底分支');

    try {
      const res = await execa('git', ['rebase', targetBranch.trim()], {
        cwd: projectPath,
        env: {
          ...process.env,
          LC_ALL: 'C',
          GIT_EDITOR: 'true',
        },
      });
      this.info(`已完成变基 [${projectPath}]: onto ${targetBranch}`);
      return { ok: true, hasConflict: false, message: res.stdout || '变基完成！' };
    } catch (error: any) {
      const msg = error?.stderr || error?.stdout || error?.message || String(error);
      if (
        msg.includes('CONFLICT') ||
        msg.includes('could not apply') ||
        msg.includes('Resolve all conflicts manually') ||
        msg.includes('冲突') ||
        msg.includes('无法应用') ||
        msg.includes('手动解决所有冲突')
      ) {
        return {
          ok: false,
          hasConflict: true,
          message: '[注意] 变基过程中产生代码冲突，变基已暂停！请解决冲突并暂存后点击「继续变基」，或点击「终止变基」。',
        };
      }
      throw new Error(`变基失败: ${msg}`);
    }
  }

  async gitRebaseAbort(projectPath: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    try {
      await execa('git', ['rebase', '--abort'], { cwd: projectPath });
      this.info(`已终止变基 [${projectPath}]`);
      return { ok: true, message: '已成功终止变基，工作区已恢复到变基前状态。' };
    } catch (error: any) {
      throw new Error(`终止变基失败: ${error?.message || error}`);
    }
  }

  async gitRebaseContinue(
    projectPath: string
  ): Promise<{ ok: boolean; message: string; hasConflict: boolean }> {
    if (!projectPath) throw new Error('未指定项目路径');
    try {
      const res = await execa('git', ['rebase', '--continue'], {
        cwd: projectPath,
        env: {
          ...process.env,
          LC_ALL: 'C',
          GIT_EDITOR: 'true',
        },
      });
      this.info(`继续变基成功 [${projectPath}]`);
      return { ok: true, hasConflict: false, message: res.stdout || '继续变基成功！' };
    } catch (error: any) {
      const msg = error?.stderr || error?.stdout || error?.message || String(error);
      if (
        msg.includes('CONFLICT') ||
        msg.includes('could not apply') ||
        msg.includes('冲突') ||
        msg.includes('无法应用')
      ) {
        return {
          ok: false,
          hasConflict: true,
          message: '[注意] 仍存在未解决的变基冲突，请将冲突全部标记解决并暂存后再次继续。',
        };
      }
      throw new Error(`继续变基失败: ${msg}`);
    }
  }

  async gitInit(projectPath: string): Promise<{ ok: boolean; summary: string }> {
    if (!projectPath) throw new Error('未指定项目路径');
    const res = await execa('git', ['init'], { cwd: projectPath });
    this.info(`Git 初始化成功 [${projectPath}]`);
    return { ok: true, summary: res.stdout || '初始化成功' };
  }

  async gitDiff(projectPath: string, file?: string, isStaged?: boolean): Promise<{ ok: boolean; diff: string }> {
    if (!projectPath || !existsSync(projectPath)) {
      throw new Error('未指定有效项目路径');
    }

    try {
      const args = ['diff'];
      if (isStaged) {
        args.push('--cached');
      } else {
        args.push('HEAD');
      }
      if (file && file.trim()) {
        args.push('--', file.trim());
      }

      try {
        const res = await execa('git', args, { cwd: projectPath });
        if (res.stdout.trim()) {
          return { ok: true, diff: res.stdout };
        }
      } catch {
        const fallbackArgs = isStaged ? ['diff', '--cached'] : ['diff'];
        if (file && file.trim()) fallbackArgs.push('--', file.trim());
        const fallbackRes = await execa('git', fallbackArgs, { cwd: projectPath });
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

  async getVisualDiff(projectPath: string, file?: string, isStaged?: boolean): Promise<{ ok: boolean; files: FileDiffItem[]; rawDiff: string }> {
    const rawRes = await this.gitDiff(projectPath, file, isStaged);
    const rawDiff = rawRes.diff || '';
    const files = parseUnifiedDiff(rawDiff);
    return { ok: true, files, rawDiff };
  }

  async revertFileDiff(projectPath: string, file: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !file) throw new Error('参数缺失');
    try {
      await execa('git', ['restore', '--', file], { cwd: projectPath });
      this.info(`已回滚文件变更: ${file}`);
      return { ok: true, message: `已成功还原 ${file}` };
    } catch {
      try {
        await execa('git', ['checkout', 'HEAD', '--', file], { cwd: projectPath });
        this.info(`已回滚文件变更: ${file}`);
        return { ok: true, message: `已成功还原 ${file}` };
      } catch {
        // 如果是未跟踪新增文件，删除本地文件
        const fullPath = join(projectPath, file);
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true, recursive: true });
          this.info(`已清理未跟踪新增文件: ${file}`);
          return { ok: true, message: `已删除未跟踪文件 ${file}` };
        }
        throw new Error(`回滚失败`);
      }
    }
  }

  async revertAllFiles(projectPath: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath) throw new Error('参数缺失');
    try {
      await execa('git', ['restore', '.'], { cwd: projectPath });
    } catch {
      await execa('git', ['checkout', 'HEAD', '--', '.'], { cwd: projectPath });
    }
    try {
      await execa('git', ['clean', '-fd'], { cwd: projectPath });
    } catch {}
    this.info(`已成功放弃工作区全部修改 [${projectPath}]`);
    return { ok: true, message: '已成功放弃工作区全部修改' };
  }

  async stageFileDiff(projectPath: string, file: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !file) throw new Error('参数缺失');
    await execa('git', ['add', '--', file], { cwd: projectPath });
    this.info(`已暂存文件: ${file}`);
    return { ok: true, message: `已成功暂存 ${file}` };
  }

  async unstageFileDiff(projectPath: string, file: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath || !file) throw new Error('参数缺失');
    try {
      await execa('git', ['restore', '--staged', '--', file], { cwd: projectPath });
    } catch {
      await execa('git', ['reset', 'HEAD', '--', file], { cwd: projectPath });
    }
    this.info(`已取消暂存文件: ${file}`);
    return { ok: true, message: `已从暂存区移出 ${file}` };
  }

  async stageAllFiles(projectPath: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath) throw new Error('参数缺失');
    await execa('git', ['add', '-A'], { cwd: projectPath });
    this.info(`已暂存全部改动 [${projectPath}]`);
    return { ok: true, message: '已暂存全部改动' };
  }

  async unstageAllFiles(projectPath: string): Promise<{ ok: boolean; message: string }> {
    if (!projectPath) throw new Error('参数缺失');
    try {
      await execa('git', ['restore', '--staged', '.'], { cwd: projectPath });
    } catch {
      await execa('git', ['reset', 'HEAD'], { cwd: projectPath });
    }
    this.info(`已取消全部暂存 [${projectPath}]`);
    return { ok: true, message: '已取消全部暂存' };
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

  getProjectCommitRule(projectPath: string): { exists: boolean; filePath?: string; fileName?: string; content?: string } {
    if (!projectPath) return { exists: false };
    const candidates = [
      'COMMIT_CONVENTION.md',
      'COMMIT_RULES.md',
      '.github/COMMIT_CONVENTION.md',
      '.github/commit-convention.md',
      'docs/COMMIT_CONVENTION.md',
      '.gitmessage.md',
      '.gitmessage',
    ];
    for (const rel of candidates) {
      const full = join(projectPath, rel);
      if (existsSync(full)) {
        try {
          const content = readFileSync(full, 'utf8');
          return { exists: true, filePath: full, fileName: rel, content };
        } catch {
          // 继续探测下一个候选文件
        }
      }
    }
    return { exists: false };
  }

  saveProjectCommitRule(projectPath: string, content: string, fileName = 'COMMIT_CONVENTION.md'): { ok: boolean; filePath: string } {
    if (!projectPath) throw new Error('项目路径不能为空');
    const targetFile = join(projectPath, fileName);
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, content, 'utf8');
    this.info(`已同步保存项目 Git Commit 规范文件: ${targetFile}`);
    return { ok: true, filePath: targetFile };
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

  async addMemory(input: Parameters<MemoryStore['addMemory']>[0]): Promise<MemoryCard> {
    const card = await MemoryStore.getInstance().addMemory(input);
    this.info(`已存入长期记忆: [${card.category}] ${card.title}`);
    return card;
  }

  async searchMemories(query: string, limit: number = 5) {
    return MemoryStore.getInstance().searchMemories({ text: query, limit });
  }

  async updateMemory(id: string, patch: Parameters<MemoryStore['updateMemory']>[1]): Promise<MemoryCard | undefined> {
    return MemoryStore.getInstance().updateMemoryWithEmbedding(id, patch);
  }

  async rebuildMemoryEmbeddings(): Promise<{ count: number }> {
    return { count: await MemoryStore.getInstance().rebuildEmbeddings() };
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

  // 获取本地 Ollama 引擎状态与已安装模型
  async getOllamaStatus(): Promise<OllamaStatusResult> {
    return checkOllamaStatus();
  }

  // 根据电脑硬件配置获取开源大模型推荐矩阵与评分列表
  async getRecommendedModels(categoryFilter?: ModelCategory | 'all'): Promise<HardwareRecommendationProfile> {
    const sysInfo = getHostSystemInfo();
    const ollamaStatus = await checkOllamaStatus();
    const installedSet = new Set<string>(ollamaStatus.installedModels);
    return getHardwareRecommendationProfile(sysInfo, installedSet, categoryFilter);
  }

  // 尝试在本地拉起 Ollama 服务 (ollama serve)
  async startOllamaService(): Promise<{ ok: boolean; message: string }> {
    return startOllamaDaemon();
  }

  // 一键拉取开源模型 (流式上报进度，完成后自动注册进 HAP 配置)
  async pullOllamaModel(
    modelTag: string,
    onProgress: (progress: OllamaPullProgress) => void
  ): Promise<{ ok: boolean; message: string }> {
    const existing = this.activeOllamaPulls.get(modelTag);
    if (existing) {
      existing.abort();
    }
    const controller = new AbortController();
    this.activeOllamaPulls.set(modelTag, controller);

    try {
      this.info(`开始一键拉取并部署本地模型：${modelTag}`);
      await pullOllamaModelStream(modelTag, {
        signal: controller.signal,
        onProgress,
      });

      // 拉取成功后自动注册进 HAP 系统服务商与模型列表中
      await this.registerOllamaDownloadedModel(modelTag);
      this.info(`本地模型 ${modelTag} 已成功部署并就绪！`);
      return { ok: true, message: `模型 ${modelTag} 已成功部署并就绪！` };
    } catch (err) {
      if (controller.signal.aborted) {
        this.info(`已取消拉取模型：${modelTag}`);
        return { ok: false, message: '已取消拉取' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.error(`拉取模型 ${modelTag} 失败：${msg}`);
      throw err;
    } finally {
      this.activeOllamaPulls.delete(modelTag);
    }
  }

  // 取消正在进行的模型下载
  cancelOllamaPull(modelTag: string): { ok: boolean; message: string } {
    const controller = this.activeOllamaPulls.get(modelTag);
    if (controller) {
      controller.abort();
      this.activeOllamaPulls.delete(modelTag);
      this.info(`已取消模型 ${modelTag} 的下载任务`);
      return { ok: true, message: `已取消下载 ${modelTag}` };
    }
    return { ok: false, message: `未找到正在下载的任务：${modelTag}` };
  }

  // 删除本地已安装的 Ollama 模型
  async deleteOllamaModel(modelTag: string): Promise<{ ok: boolean; message: string }> {
    const result = await removeOllamaModel(modelTag);
    if (result.ok) {
      try {
        this.removeModel(`ollama/${modelTag}`);
      } catch {}
    }
    return result;
  }

  // 自动注册已下载模型到 HAP 系统中
  async registerOllamaDownloadedModel(modelTag: string): Promise<void> {
    const catalogItem = OPEN_SOURCE_MODEL_CATALOG.find((m) => m.id === modelTag);
    const alias = `ollama/${modelTag}`;
    const writer = new ConfigWriter(this.configPath);

    const resolver = this.resolver();
    const existingProvider = resolver.resolveProviders().get('ollama');
    if (!existingProvider) {
      writer.upsertProvider('ollama', {
        name: 'Ollama (本地运行)',
        base_url: 'http://127.0.0.1:11434/v1',
        wire_api: 'chat',
        default_protocol: catalogItem?.protocol || 'openai-tools',
      });
    }

    writer.upsertModel(alias, {
      provider: 'ollama',
      model: modelTag,
      display_name: catalogItem?.displayName || `Ollama ${modelTag}`,
      protocol: catalogItem?.protocol || 'openai-tools',
      capabilities: catalogItem?.category === 'reasoning' ? ['reasoning', 'streaming'] : ['tools', 'streaming'],
    });

    const state = readState();
    if (state.hiddenModels?.includes(alias)) {
      state.hiddenModels = state.hiddenModels.filter((m) => m !== alias);
      writeState(state);
    }
    this.info(`已自动将已下载模型 ${modelTag} 注册进系统配置 (${alias})`);
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
    loadSavedEnvIntoProcess();
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

    const orchestrator = new AgentOrchestrator({ configPath: this.configPath });
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
            text: (outcome?.text ? outcome.text + '\n\n' : '') + '*(用户已手动中断本次生成)*',
            finishReason: 'abort',
            iterations: outcome?.iterations ?? 0,
            model: targetModel || 'default',
          };
        } else if (outcome.status === 'failed' || outcome.finishReason === 'error' || (!outcome.text && outcome.error)) {
          const reason = outcome.error || '大模型接口未返回有效回复';
          outcome.text = `**智能体回复提示：**\n\n\`${reason}\`\n\n> **解决建议：**\n> 1. 请前往左侧导航 **【设置中心 -> AI 服务商与模型】**，检查对应服务商的 **API 基础地址 (Base URL)** 与 **API Key** 是否填写正确；\n> 2. 点击服务商卡片上的 **【连通测试】** 验证网络与 Key 有效性；\n> 3. 您也可以点击顶部模型下拉框，切换到其它已就绪的模型（如 DeepSeek、OpenAI 或本地免费的 Ollama）。\n> 4. 支持本地斜杠系统指令，例如发送 \`/models\` 查看所有已配置模型。\n`;
        }
      } catch (taskErr) {
        if (chatController.signal.aborted) {
          outcome = {
            taskId,
            text: '*(用户已手动中断本次生成)*',
            finishReason: 'abort',
            iterations: 0,
            model: targetModel || 'default',
          };
        } else {
          const errMsg = describeError(taskErr);
          this.error('智能体对话执行异常：' + errMsg);
          outcome = {
            taskId: 'err_' + Date.now(),
            text: `**智能体回复提示：**\n\n\`${errMsg}\`\n\n> **解决建议：**\n> 1. 请前往左侧导航 **【设置中心 -> AI 服务商与模型】**，检查对应服务商的 **API 基础地址 (Base URL)** 与 **API Key** 是否填写正确；\n> 2. 点击服务商卡片上的 **【连通测试】** 验证连通性；\n> 3. 您也可以点击顶部模型下拉框，切换到其它已就绪的模型直接对话。\n> 4. 支持本地斜杠系统指令（如 \`/models\`、\`/help\`）。\n`,
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
  private wechatOrchestrator: AgentOrchestrator | undefined;
  private wechatRunning = false;
  private wechatStatus: 'idle' | 'waiting_qr' | 'connected' | 'error' = 'idle';
  private wechatQrCode: string | undefined;
  private wechatLoginUser: string | undefined;
  private wechatError: string | undefined;

  private reloadRunningChannels(): void {
    if (this.wechatOrchestrator) {
      try {
        this.wechatOrchestrator.reload();
        this.wechatManager?.reload({
          channels: this.wechatOrchestrator.config.resolveChannels(),
          limits: this.wechatOrchestrator.config.resolveLimits(),
        });
        this.info('已向运行中的微信服务同步最新配置');
      } catch (err) {
        this.error('向微信服务同步配置失败: ' + describeError(err));
      }
    }
  }

  async getWeChatConfig(): Promise<GuiWeChatConfig> {
    const resolver = this.resolver();
    const channels = resolver.resolveChannels();
    const wx = channels.wechat;
    
    const declaredAgents = resolver.listAgentIds();
    const defaultAgentId = (wx.defaultAgent && declaredAgents.includes(wx.defaultAgent))
      ? wx.defaultAgent
      : (declaredAgents[0] || wx.defaultAgent || 'coder');
    
    let agentWorkspace: string | undefined;
    try {
      agentWorkspace = resolver.resolveAgent(defaultAgentId)?.workspace;
    } catch {}

    return {
      enabled: !!wx.enabled,
      mode: wx.mode || 'personal',
      puppet: wx.personal?.puppet || (wx.mode === 'ilink_bot' ? 'ilink' : 'service'),
      visionPollIntervalMs: wx.personal?.visionPollIntervalMs,
      visionModel: wx.personal?.visionModel,
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

    if (config.puppet !== undefined) {
      if (!hapConfig.channels.wechat.personal) hapConfig.channels.wechat.personal = {};
      hapConfig.channels.wechat.personal.puppet = config.puppet;
      if (config.puppet === 'desktop_vision') {
        hapConfig.channels.wechat.mode = 'personal';
      } else if (config.puppet === 'ilink') {
        hapConfig.channels.wechat.mode = 'ilink_bot';
      }
    }
    if (config.visionPollIntervalMs !== undefined) {
      if (!hapConfig.channels.wechat.personal) hapConfig.channels.wechat.personal = {};
      hapConfig.channels.wechat.personal.vision_poll_interval_ms = config.visionPollIntervalMs;
    }
    if (config.visionModel !== undefined) {
      if (!hapConfig.channels.wechat.personal) hapConfig.channels.wechat.personal = {};
      hapConfig.channels.wechat.personal.vision_model = config.visionModel;
    }

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
      const resolver = this.resolver();
      const declaredAgents = resolver.listAgentIds();
      const agentKey = config.defaultAgent || hapConfig.channels.wechat.default_agent || declaredAgents[0] || 'coder';
      if (!hapConfig.agents.entries[agentKey]) hapConfig.agents.entries[agentKey] = {};
      hapConfig.agents.entries[agentKey].workspace = config.workspace.trim();
    }

    // @ts-expect-error private commit
    writer.commit(hapConfig, exists, raw, '更新微信/企业微信配置');
    this.info('微信通道配置已保存');
    this.reloadRunningChannels();
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
    try {
      const wx = this.resolver().resolveChannels().wechat;
      if (['personal', 'ilink_bot'].includes(wx.mode) && wx.personal.puppet === 'ilink') {
        new IlinkAccountStore(wx.authDir, wx.personal.ilinkAccountId).clearSession();
      }
    } catch {}
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

    this.wechatOrchestrator = orchestrator;
    this.wechatStatus = 'waiting_qr';

    const manager = new WeChatChannel({
      host: createChannelHost(orchestrator),
      channels: orchestrator.config.resolveChannels(),
      limits: orchestrator.config.resolveLimits(),
      paths: orchestrator.resolvedPaths,
      env: process.env,
      onActivity: (act) => {
        this.addHostingActivity(act);
      },
      log: (line) => {
        this.info(`[WeChat] ${line}`);
        if (this.wechatManager !== manager) return;
        if (line.includes('[WeChat] 微信已登出：')) {
          this.wechatRunning = false;
          this.wechatStatus = 'error';
          this.wechatError = line.split('[WeChat] 微信已登出：')[1]?.trim();
          this.wechatLoginUser = undefined;
          this.wechatQrCode = undefined;
          this.addHostingActivity({
            stage: 'system',
            level: 'error',
            tag: '微信登出',
            title: `微信账号已登出: ${this.wechatError || '连接终止'}`,
          });
        }
        if (line.includes('[WeChat] 请使用手机微信扫码登录：') || line.includes('[WeChat QR] 扫码地址:')) {
          const qr = line.split('：')[1]?.trim() || line.split('扫码地址:')[1]?.trim();
          if (qr && qr.startsWith('http')) {
            this.wechatQrCode = qr;
            this.wechatStatus = 'waiting_qr';
            this.addHostingActivity({
              stage: 'system',
              level: 'info',
              tag: '等待扫码',
              title: '微信驱动等待手机扫码授权登录',
            });
          }
        }
        if (line.includes('登录成功')) {
          this.wechatStatus = 'connected';
          const userName = line.split('登录成功：')[1]?.split('(')[0]?.trim() || 'WeChat User';
          this.wechatLoginUser = userName;
          this.addHostingActivity({
            stage: 'system',
            level: 'success',
            tag: '微信就绪',
            title: `桌面微信接入成功 (${userName})，进入静默巡检与代答模式`,
          });
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
      this.wechatOrchestrator = undefined;
      this.wechatRunning = false;
      this.wechatStatus = 'error';
      this.wechatError = describeError(error);
      throw error;
    }

    if (this.wechatManager !== manager) {
      this.wechatOrchestrator = undefined;
      return { ok: true, message: '微信启动已取消' };
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
    const manager = this.wechatManager;
    this.wechatManager = undefined;
    this.wechatOrchestrator = undefined;
    this.wechatRunning = false;
    try {
      await manager?.stop();
      return { ok: true, message: '微信连接已断开，登录凭据已保留' };
    } catch (err) {
      throw new Error('本地微信连接已停止，但停止通知或清理失败：' + describeError(err));
    } finally {
      this.wechatStatus = 'idle';
      this.wechatError = undefined;
      this.wechatQrCode = undefined;
      this.wechatLoginUser = undefined;
      await this.saveWeChatConfig({ enabled: false });
      this.info('微信本地连接已断开');
    }
  }

  async logoutWeChat(): Promise<{ ok: boolean; message: string }> {
    const wx = this.resolver().resolveChannels().wechat;
    if (!['personal', 'ilink_bot'].includes(wx.mode) || wx.personal.puppet !== 'ilink') {
      throw new Error('当前仅支持 iLink 模式清除登录；其他模式请在对应服务商撤销授权');
    }
    let warning = '';
    try { await this.stopWeChatService(); }
    catch (error) { warning = '（' + describeError(error) + '）'; }
    new IlinkAccountStore(wx.authDir, wx.personal.ilinkAccountId).clearSession();
    return { ok: true, message: '已清除本地微信登录，下次连接需扫码；远端绑定未撤销' + warning };
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

  getChannelMessages(contactIdOrPayload?: string | { contactId?: string; channel?: ChannelName }, channel?: ChannelName): ChannelChatMessage[] {
    let cid: string | undefined;
    let ch: ChannelName | undefined;
    if (typeof contactIdOrPayload === 'object' && contactIdOrPayload !== null) {
      cid = contactIdOrPayload.contactId;
      ch = contactIdOrPayload.channel;
    } else {
      cid = contactIdOrPayload;
      ch = channel;
    }
    return ChannelContactStore.getInstance().getMessages(cid, ch);
  }

  upsertChannelContact(input: Partial<ChannelContact> & { id: string; channel: ChannelName; name: string }): ChannelContact {
    const res = ChannelContactStore.getInstance().upsertContact(input);
    this.info(`已更新通道 [${input.channel}] 联系人/会话 [${res.name}] 规则配置`);
    return res;
  }

  removeChannelContact(idOrPayload: string | { id: string; channel?: ChannelName }, channel?: ChannelName): boolean {
    let cid: string;
    let ch: ChannelName | undefined;
    if (typeof idOrPayload === 'object' && idOrPayload !== null) {
      cid = idOrPayload.id;
      ch = idOrPayload.channel;
    } else {
      cid = idOrPayload;
      ch = channel;
    }
    const res = ChannelContactStore.getInstance().removeContact(cid, ch);
    this.info(`已移除通道 [${ch || 'all'}] 联系人/会话 [${cid}]`);
    return res;
  }

  clearAllChannelContacts(channel?: ChannelName): { ok: boolean; clearedCount: number } {
    const store = ChannelContactStore.getInstance();
    const beforeCount = store.listContacts(channel).length;
    store.clearAllContacts(channel);
    this.info(`已清空通道 [${channel || 'all'}] 的所有托管联系人及消息历史（共 ${beforeCount} 个会话）`);
    return { ok: true, clearedCount: beforeCount };
  }

  getHostingPersonaTemplates(): Array<{ key: string; title: string; emoji: string; description: string; content: string }> {
    const templateDir = join(process.cwd(), 'templates', 'hosting-personas');
    const presets = [
      { key: 'natural', title: '自然口语', emoji: '💬', description: '真人朋友微信口吻，简短亲和，防借钱套话', file: 'natural.md' },
      { key: 'business', title: '商务得体', emoji: '💼', description: '专业稳重，需求三要素，记录预约本人', file: 'business.md' },
      { key: 'tech', title: '技术专家', emoji: '💻', description: '架构严谨，直击要害，代码精炼，务实极客', file: 'tech.md' },
      { key: 'humor', title: '幽默风趣', emoji: '😄', description: '风趣接梗，高情商四两拨千斤，生动活泼', file: 'humor.md' },
      { key: 'polite', title: '稍后联系', emoji: '⏳', description: '闭门研发/会议暂离，紧急拨打电话', file: 'polite.md' },
      { key: 'assistant', title: '贴心秘书', emoji: '👧', description: '以AI助理身份接待，代接留言，分类汇总', file: 'assistant.md' },
    ];

    return presets.map((p) => {
      let content = '';
      const pPath = join(templateDir, p.file);
      if (existsSync(pPath)) {
        try {
          content = readFileSync(pPath, 'utf8');
        } catch {
          content = '';
        }
      }
      return {
        key: p.key,
        title: p.title,
        emoji: p.emoji,
        description: p.description,
        content: content.trim(),
      };
    });
  }

  loadHostingPersonaMarkdown(filePath?: string): { ok: boolean; content: string; filePath?: string; error?: string } {
    try {
      const targetPath = filePath || join(process.cwd(), 'templates', 'hosting-personas', 'natural.md');
      if (!existsSync(targetPath)) {
        return { ok: false, content: '', error: `文件未找到: ${targetPath}` };
      }
      const content = readFileSync(targetPath, 'utf8');
      return { ok: true, content, filePath: targetPath };
    } catch (err: unknown) {
      return { ok: false, content: '', error: describeError(err) };
    }
  }

  exportHostingPersonaMarkdown(filePath: string, content: string): { ok: boolean; filePath: string; error?: string } {
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, content, 'utf8');
      return { ok: true, filePath };
    } catch (err: unknown) {
      return { ok: false, filePath, error: describeError(err) };
    }
  }

  getChannelDefaultPolicy(channel: ChannelName): ChannelDefaultPolicy {
    return ChannelContactStore.getInstance().getDefaultPolicy(channel);
  }

  saveChannelDefaultPolicy(channel: ChannelName, policy: Partial<ChannelDefaultPolicy>): ChannelDefaultPolicy {
    const res = ChannelContactStore.getInstance().saveDefaultPolicy(channel, policy);
    if (channel === 'wechat' && policy.agentId) {
      try {
        const writer = new ConfigWriter(this.configPath);
        const { config: hapConfig, exists, raw } = writer.read();
        if (!hapConfig.channels) hapConfig.channels = {};
        if (!hapConfig.channels.wechat) hapConfig.channels.wechat = {};
        hapConfig.channels.wechat.default_agent = policy.agentId;
        // @ts-expect-error private commit
        writer.commit(hapConfig, exists, raw, '更新微信默认分身智能体配置');
        if (this.wechatOrchestrator) {
          this.wechatOrchestrator.reload();
          this.wechatManager?.reload({
            channels: this.wechatOrchestrator.config.resolveChannels(),
            limits: this.wechatOrchestrator.config.resolveLimits(),
          });
        }
      } catch (err) {
        this.warn(`同步保存微信默认智能体至主配置文件失败: ${err}`);
      }
    }
    this.info(`已更新通道 [${channel}] 默认分身智能体与托管策略配置: agentId=${policy.agentId || 'default'}`);
    this.addHostingActivity({
      stage: 'system',
      level: 'success',
      tag: '配置同步',
      title: `微信分身智能体已绑定至 [${policy.agentId || 'default'}]，人设口吻与防撞车配置已生效`,
      agentId: policy.agentId,
    });
    return res;
  }

  getHostingActivities(limit = 60): GuiHostingActivity[] {
    return this.hostingActivities.slice(0, limit);
  }

  clearHostingActivities(): { ok: true } {
    this.hostingActivities.length = 0;
    return { ok: true };
  }

  onHostingActivity(listener: (activity: GuiHostingActivity) => void): () => void {
    this.hostingActivityListeners.add(listener);
    return () => this.hostingActivityListeners.delete(listener);
  }

  addHostingActivity(activity: Omit<GuiHostingActivity, 'id' | 'timestamp' | 'timeStr'> & { id?: string; timestamp?: number; timeStr?: string }): GuiHostingActivity {
    const full: GuiHostingActivity = {
      id: activity.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: activity.timestamp || Date.now(),
      timeStr: activity.timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      stage: activity.stage,
      level: activity.level,
      tag: activity.tag,
      title: activity.title,
      detail: activity.detail,
      target: activity.target,
      sender: activity.sender,
      agentId: activity.agentId,
      agentName: activity.agentName,
      model: activity.model,
      elapsedMs: activity.elapsedMs,
    };
    this.hostingActivities.unshift(full);
    if (this.hostingActivities.length > 100) {
      this.hostingActivities.length = 100;
    }
    for (const listener of this.hostingActivityListeners) {
      try {
        listener(full);
      } catch {
        // ignore
      }
    }
    return full;
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

    this.addHostingActivity({
      stage: 'thinking',
      level: 'info',
      tag: '大模型调用',
      title: `触发分身 [${assignedAgent}] 生成代答 | 目标: 【${contact ? contact.name : payload.targetId}】`,
      detail: `输入文本: “${payload.text}”`,
      target: contact ? contact.name : payload.targetId,
      agentId: assignedAgent,
    });

    try {
      // 触发智能体响应执行
      const orchestrator = new AgentOrchestrator(this.configPath ? { configPath: this.configPath } : {});
      await orchestrator.loadMcpTools();

      const startTime = Date.now();
      const res = await orchestrator.runTask({
        agentId: assignedAgent,
        input: payload.text,
        workspace: contactWorkspace || undefined,
        sessionKey: `${payload.channel}:manual:${payload.targetId}`,
      });
      const elapsedMs = Date.now() - startTime;

      const replyContent = res.text || '（任务执行完成，无输出文本）';
      store.recordOutgoingMessage({
        channel: payload.channel,
        contactId: payload.targetId,
        agentId: assignedAgent,
        text: replyContent,
        elapsedMs,
      });

      this.addHostingActivity({
        stage: 'generated',
        level: 'success',
        tag: '大模型生成',
        title: `代答回复生成成功 (耗时 ${(elapsedMs / 1000).toFixed(1)}s) | 目标: 【${contact ? contact.name : payload.targetId}】`,
        detail: `回复内容: “${replyContent}”`,
        target: contact ? contact.name : payload.targetId,
        agentId: assignedAgent,
        elapsedMs,
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

  // ==========================================
  // 聊天托管与数字分身代管中心 (Chat Hosting & Delegation Hub)
  // ==========================================

  getHostingOverview(): {
    wechat: {
      running: boolean;
      status: string;
      puppet: 'ilink' | 'service' | 'desktop_vision';
      user?: string | undefined;
      qrCode?: string | undefined;
      error?: string | undefined;
    };
    qq: {
      running: boolean;
      status: string;
    };
    stats: {
      totalContacts: number;
      autoReplyCount: number;
      pendingDrafts: number;
      activeCooldowned: number;
    };
  } {
    const store = ChannelContactStore.getInstance();
    const stats = store.getHostingStats();
    let currentPuppet: 'ilink' | 'service' | 'desktop_vision' = 'ilink';
    try {
      currentPuppet = this.resolver().resolveChannels().wechat.personal.puppet;
    } catch {}
    return {
      wechat: {
        running: this.wechatRunning,
        status: this.wechatStatus,
        puppet: currentPuppet,
        user: this.wechatLoginUser,
        qrCode: this.wechatQrCode,
        error: this.wechatError,
      },
      qq: {
        running: this.qqRunning,
        status: this.qqRunning ? 'connected' : 'idle',
      },
      stats,
    };
  }

  async testVisionCapture(): Promise<{
    ok: boolean;
    platform: string;
    isWeChatRunning: boolean;
    windowBounds?: WeChatWindowBounds | undefined;
    sourceType?: string | undefined;
    windowName?: string | undefined;
    dataUrl?: string | undefined;
    parsed?: WeChatVisionParseResult | undefined;
    error?: string | undefined;
  }> {
    const isRunning = await isWeChatRunning();
    const bounds = await getWeChatWindowBounds();
    const cap = await captureWeChatWindow();
    if (!cap.ok || (!cap.buffer && !cap.base64)) {
      return {
        ok: false,
        platform: process.platform,
        isWeChatRunning: isRunning,
        windowBounds: bounds,
        error: cap.error || '未捕获到有效屏幕图像，请检查系统设置中的屏幕录制权限',
      };
    }
    const input = cap.buffer || cap.base64!;
    const parsed = await parseWeChatScreen(input);
    if (!parsed.ok) {
      return {
        ok: false,
        platform: process.platform,
        isWeChatRunning: isRunning,
        windowBounds: bounds,
        sourceType: cap.sourceType,
        windowName: cap.windowName,
        dataUrl: cap.dataUrl,
        parsed,
        error: parsed.error || '多模态视觉解析失败',
      };
    }
    return {
      ok: true,
      platform: process.platform,
      isWeChatRunning: isRunning,
      windowBounds: bounds,
      sourceType: cap.sourceType,
      windowName: cap.windowName,
      dataUrl: cap.dataUrl,
      parsed,
    };
  }

  async switchWeChatHostingPuppet(puppet: 'ilink' | 'desktop_vision'): Promise<{ ok: boolean; puppet: string }> {
    await this.saveWeChatConfig({ puppet });
    if (this.wechatRunning) {
      await this.stopWeChatService();
      await this.startWeChatService();
    }
    return { ok: true, puppet };
  }

  async sendHumanMessage(payload: {
    channel: ChannelName;
    targetId: string;
    text: string;
    cooldownMinutes?: number | undefined;
  }): Promise<{ ok: boolean; messageRecord?: ChannelChatMessage; error?: string }> {
    const store = ChannelContactStore.getInstance();
    const cooldownMins = payload.cooldownMinutes ?? 10;

    // 1. 触发防撞车冷却与人工接管锁定
    store.triggerHumanTakeover(payload.targetId, payload.channel, cooldownMins);

    // 2. 记录人工发出的出站消息
    const messageRecord = store.recordOutgoingMessage({
      channel: payload.channel,
      contactId: payload.targetId,
      sender: 'human',
      text: payload.text,
    });

    // 3. 真正尝试向下游驱动下发消息
    try {
      if (payload.channel === 'wechat' && this.wechatRunning && this.wechatManager) {
        await this.wechatManager.sendMessage(payload.targetId, payload.text);
      } else if (payload.channel === 'qq' && this.qqRunning && this.qqChannel) {
        const rawTarget = payload.targetId.replace(/^qq_group_|^qq_user_/, '');
        const isGroup = payload.targetId.startsWith('qq_group_');
        await this.qqChannel.sendQQMessage(rawTarget, payload.text, isGroup);
      }
      this.info(`[Hosting] 人工已向 [${payload.channel}:${payload.targetId}] 发送消息，开启 ${cooldownMins} 分钟防撞车冷却`);
      return { ok: true, messageRecord };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.error(`[Hosting] 实际消息投递下游失败（已记录到本地会话流）：${errorMsg}`);
      return { ok: true, messageRecord, error: errorMsg };
    }
  }

  async approveDraft(messageId: string): Promise<{ ok: boolean; messageRecord?: ChannelChatMessage; error?: string }> {
    const store = ChannelContactStore.getInstance();
    const approved = store.approveDraft(messageId);
    if (!approved) {
      return { ok: false, error: '未找到对应待审核草稿' };
    }

    try {
      if (approved.channel === 'wechat' && this.wechatRunning && this.wechatManager) {
        await this.wechatManager.sendMessage(approved.contactId, approved.text);
      } else if (approved.channel === 'qq' && this.qqRunning && this.qqChannel) {
        const rawTarget = approved.contactId.replace(/^qq_group_|^qq_user_/, '');
        const isGroup = approved.contactId.startsWith('qq_group_');
        await this.qqChannel.sendQQMessage(rawTarget, approved.text, isGroup);
      }
      this.info(`[Hosting] 草稿 [${messageId}] 已通过审核并成功发送`);
      return { ok: true, messageRecord: approved };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { ok: true, messageRecord: approved, error: errorMsg };
    }
  }

  discardDraft(messageId: string): { ok: boolean } {
    const res = ChannelContactStore.getInstance().discardDraft(messageId);
    return { ok: res };
  }

  triggerContactTakeover(payload: { channel: ChannelName; targetId: string; cooldownMinutes?: number }): ChannelContact | undefined {
    return ChannelContactStore.getInstance().triggerHumanTakeover(payload.targetId, payload.channel, payload.cooldownMinutes ?? 10);
  }

  releaseContactTakeover(payload: { channel: ChannelName; targetId: string }): ChannelContact | undefined {
    return ChannelContactStore.getInstance().releaseHumanTakeover(payload.targetId, payload.channel);
  }

  async generateQuickReplies(payload: { channel: ChannelName; targetId: string }): Promise<{ ok: boolean; suggestions: string[]; error?: string }> {
    const store = ChannelContactStore.getInstance();
    const msgs = store.getMessages(payload.targetId, payload.channel, 6);
    const contact = store.getContact(payload.targetId, payload.channel);

    if (msgs.length === 0) {
      return {
        ok: true,
        suggestions: ['你好！有什么我可以帮你的吗？', '收到，稍后回复你~', '现在有点忙，稍后电话联系！'],
      };
    }

    const conversationHistory = msgs.map((m) => `${m.sender === 'user' ? '对方' : '我'}: ${m.text}`).join('\n');
    const prompt = `你是一个聊天回复助手。请根据以下我与【${contact?.name || '好友'}】的最近对话历史，生成 3 条简短自然、像真人日常微信打字的备选回复，每条不超过 20 个字。\n请严格以 JSON 数组格式输出，不要有任何多余文字。\n例如: ["好的，我这就看下", "没问题，明天碰头聊", "收到！谢谢提醒"]\n\n对话历史:\n${conversationHistory}`;

    try {
      const orchestrator = new AgentOrchestrator(this.configPath ? { configPath: this.configPath } : {});
      const res = await orchestrator.runTask({
        agentId: contact?.agentId || 'coder',
        input: prompt,
        sessionKey: `quick_reply:${payload.channel}:${payload.targetId}`,
      });

      const text = res.text || '';
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { ok: true, suggestions: parsed.slice(0, 3) };
        }
      }
    } catch {
      // 容错降级
    }

    return {
      ok: true,
      suggestions: ['收到，我稍后处理！', '好的，没问题！', '现在有点忙，稍后细聊~'],
    };
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
          return { ok: true, message: `握手成功！机器人：@${data.result.username} (${data.result.first_name})`, details: data.result };
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
    const title = '[HAP 计算节点监控测试告警]';
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
          return { ok: true, message: '飞书告警卡片已成功推送到指定群聊！' };
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
          return { ok: true, message: '企微告警卡片已成功推送到群聊！' };
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
          return { ok: true, message: 'Telegram 告警消息已成功发送至指定 Chat！' };
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
          return { ok: true, message: '通用 Webhook 告警测试请求已成功送达！' };
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

  // --- API 分发网关 (Gateway) 业务接口 ---
  getGatewayOverview() {
    return getGatewayService(undefined, this.configPath).getOverview(3000);
  }

  getGatewayConfig() {
    return getGatewayService(undefined, this.configPath).getConfig();
  }

  updateGatewayConfig(patch: any) {
    return getGatewayService(undefined, this.configPath).updateConfig(patch);
  }

  listGatewayKeys() {
    return getGatewayService(undefined, this.configPath).listKeys();
  }

  createGatewayKey(input: { name: string; allowedModels?: string[]; rateLimitRpm?: number }) {
    return getGatewayService(undefined, this.configPath).createKey(input);
  }

  updateGatewayKey(id: string, patch: any) {
    return getGatewayService(undefined, this.configPath).updateKey(id, patch);
  }

  deleteGatewayKey(id: string) {
    return getGatewayService(undefined, this.configPath).deleteKey(id);
  }

  listGatewayAliases() {
    return getGatewayService(undefined, this.configPath).listAliases();
  }

  upsertGatewayAlias(input: any) {
    return getGatewayService(undefined, this.configPath).upsertAlias(input);
  }

  deleteGatewayAlias(id: string) {
    return getGatewayService(undefined, this.configPath).deleteAlias(id);
  }

  listGatewayLogs(limit?: number) {
    return getGatewayService(undefined, this.configPath).listLogs(limit);
  }

  clearGatewayLogs() {
    getGatewayService(undefined, this.configPath).clearLogs();
    return true;
  }

  getGatewayClientPresets(key?: string) {
    return getGatewayService(undefined, this.configPath).getClientPresets(3000, key);
  }

  private info(message: string): void {
    this.logs.push({ at: new Date().toISOString(), level: 'info', message });
  }

  private warn(message: string): void {
    this.logs.push({ at: new Date().toISOString(), level: 'warn', message });
  }

  error(error: unknown): void {
    this.logs.push({ at: new Date().toISOString(), level: 'error', message: describeError(error) });
  }
}
