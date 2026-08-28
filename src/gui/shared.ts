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
  category: 'system' | 'developer' | 'browser' | 'database';
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
  mode: 'personal' | 'wecom' | 'official_account';
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

