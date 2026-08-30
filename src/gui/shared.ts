export type GuiTarget = 'codex' | 'claude' | 'gemini' | 'grok' | 'openclaw';

export interface GuiProject {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface GuiProjectInput {
  name?: string;
  path: string;
}

export interface GuiProviderInput {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  envKey?: string;
  wireApi: 'chat' | 'responses' | 'anthropic-messages';
  protocol: 'hermes-native' | 'openai-tools' | 'deepseek' | 'anthropic';
}

export interface GuiModelInput {
  alias: string;
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  protocol?: 'hermes-native' | 'openai-tools' | 'deepseek' | 'anthropic';
}

export interface GuiSyncInput {
  target: GuiTarget;
  model: string;
  write: boolean;
}

export interface GuiAttachmentInput {
  kind: 'image' | 'audio' | 'document';
  fileName: string;
  mimeType?: string;
  bytes?: number;
  dataUrl?: string; // base64 data url
  path?: string; // local absolute path
}

export interface GuiChatInput {
  input: string;
  agentId?: string | undefined;
  model?: string | undefined;
  sessionKey?: string | undefined;
  projectPath?: string | undefined;
  attachments?: GuiAttachmentInput[] | undefined;
}

export interface GuiLogEntry {
  at: string;
  level: 'info' | 'error';
  message: string;
}

export interface GuiImageGenInput {
  prompt: string;
  providerId?: string | undefined;
  model?: string | undefined;
  customBaseUrl?: string | undefined;
  customApiKey?: string | undefined;
  size?: '1024x1024' | '512x512' | '1024x1792' | '1792x1024' | '1024x768' | '768x1024' | string | undefined;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | undefined;
  style?: 'vivid' | 'natural' | 'anime' | 'digital-art' | 'photorealistic' | '3d-render' | 'cyberpunk' | 'watercolor' | 'vector' | undefined;
  engine?: string | undefined;
  outputFileName?: string | undefined;
  workspace?: string | undefined;
}

export interface GuiImageGenResult {
  ok: boolean;
  imageUrl?: string | undefined;
  localFilePath?: string | undefined;
  localUri?: string | undefined;
  prompt: string;
  width: number;
  height: number;
  engineUsed: string;
  error?: string | undefined;
}

export interface GuiEnvVarItem {
  key: string;
  label: string;
  desc: string;
  value: string;
  isSet: boolean;
  category: 'llm' | 'search' | 'channel' | 'custom';
}

export interface GuiProviderTestInput {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  envKey?: string;
  wireApi?: 'chat' | 'responses' | 'anthropic-messages';
  protocol?: 'hermes-native' | 'openai-tools' | 'deepseek' | 'anthropic';
}

export type {
  AuthType,
  RemoteServerConfig,
  RemoteSystemInfo,
  InstallProgressEvent,
  RemoteExecResult,
} from '../remote/types.js';

// Skill 市场数据结构 (关联 GitHub 开源市场)
export interface GuiSkill {
  id: string;
  name: string;
  description: string;
  repo: string; // e.g. "open-skills/code-audit" or GitHub URL
  author: string;
  stars: number;
  tags: string[];
  installed: boolean;
  enabled: boolean;
  version?: string;
}

// 插件市场 (MCP / Builtin Plugins)
export interface GuiPlugin {
  id: string;
  name: string;
  description: string;
  type: 'mcp' | 'builtin';
  category: 'system' | 'developer' | 'browser' | 'database' | 'search' | 'ops' | 'im';
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

// 权限配置 (支持完完全全放开权限等模式)
export type GuiPermissionMode = 'full-access' | 'confirm-writes' | 'strict';

export interface GuiPermissionConfig {
  mode: GuiPermissionMode;
  allowShell: boolean;
  allowFsWrite: boolean;
  allowNetwork: boolean;
  allowSpawnSubagent: boolean;
  autoApproveTools: string[];
}

export interface GuiGitFileChange {
  status: string;
  file: string;
  additions: number;
  deletions: number;
}

// Git 状态与协同操作数据结构
export interface GuiGitStatus {
  isRepo: boolean;
  branch: string;
  remoteUrl?: string | undefined;
  changedFiles: GuiGitFileChange[];
  uncommittedCount: number;
  totalAdditions: number;
  totalDeletions: number;
  recentCommits: Array<{ hash: string; message: string }>;
}

// 多机器人实例平台与数据模型
export type GuiBotPlatform = 'telegram' | 'qq' | 'feishu' | 'dingtalk' | 'wechat' | 'discord' | 'slack' | 'webhook';

export interface GuiBotInstance {
  id: string;
  name: string;
  platform: GuiBotPlatform;
  enabled: boolean;
  boundServerId?: string | undefined; // 绑定的目标服务器 ID (如 "local" 或 "node_xxx")
  defaultAgent?: string | undefined; // 默认调度的智能体 (如 "ops", "coder", "researcher")
  config: {
    token?: string; // Telegram / Discord / Slack
    botName?: string;
    adminUsers?: string[]; // 管理员 User ID 列表
    appId?: string; // 飞书 / 钉钉 / 微信
    appSecret?: string; // 飞书 / 钉钉
    wsEndpoint?: string; // QQ / OneBot WebSocket 地址
    accessToken?: string;
    webhookUrl?: string; // 钉钉 / Webhook
    secret?: string; // 钉钉加签密钥
    puppetToken?: string; // 微信 Puppet Token
  };
  status?: 'running' | 'stopped' | 'error' | undefined;
  lastActiveAt?: string | undefined;
  error?: string | undefined;
}

// Telegram 机器人与通道可视化配置
export interface GuiTelegramConfig {
  enabled: boolean;
  token: string;
  mode: 'polling' | 'webhook';
  defaultAgent: string;
  workspace?: string | undefined;
  running: boolean;
  botUsername?: string | undefined;
  botName?: string | undefined;
  allowedUsers?: string[] | string | undefined;
}

// 微信与企业微信通道可视化配置
export interface GuiWeChatConfig {
  enabled: boolean;
  mode: 'personal' | 'ilink_bot' | 'wecom' | 'official_account';
  defaultAgent: string;
  workspace?: string | undefined;
  running: boolean;
  status: 'idle' | 'waiting_qr' | 'connected' | 'error';
  qrCodeText?: string | undefined;
  loginUser?: string | undefined;
  wecomCorpId?: string | undefined;
  wecomAgentId?: number | undefined;
  wecomSecret?: string | undefined;
  wecomWebhookUrl?: string | undefined;
  voiceTranscribe?: boolean | undefined;
  approvalCard?: boolean | undefined;
}

// 飞书机器人通道可视化配置
export interface GuiFeishuConfig {
  enabled: boolean;
  appId?: string | undefined;
  appSecret?: string | undefined;
  verificationToken?: string | undefined;
  encryptKey?: string | undefined;
  webhookUrl?: string | undefined;
  bind?: string | undefined;
  path?: string | undefined;
  defaultAgent: string;
  workspace?: string | undefined;
  running: boolean;
  status: 'idle' | 'running' | 'error';
}

// QQ 机器人通道可视化配置
export interface GuiQQConfig {
  enabled: boolean;
  mode: 'onebot' | 'official';
  endpoint?: string | undefined;
  token?: string | undefined;
  onebotWsUrl?: string | undefined;
  onebotAccessToken?: string | undefined;
  onebotHttpUrl?: string | undefined;
  bind?: string | undefined;
  path?: string | undefined;
  officialAppId?: string | undefined;
  officialToken?: string | undefined;
  officialSecret?: string | undefined;
  defaultAgent: string;
  workspace?: string | undefined;
  adminList?: string | undefined;
  running: boolean;
  status: 'idle' | 'running' | 'error';
}

// 钉钉机器人通道可视化配置
export interface GuiDingTalkConfig {
  enabled: boolean;
  appKey?: string | undefined;
  appSecret?: string | undefined;
  webhookUrl?: string | undefined;
  defaultAgent: string;
  workspace?: string | undefined;
  running: boolean;
  status: 'idle' | 'running' | 'error';
}
