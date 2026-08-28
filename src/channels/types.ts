/**
 * 通道层公共契约（FR-CHAN-001~016）。
 *
 * 通道只认识三样东西：入站消息（InboundMessage）、回写目标（OutboundTarget）、
 * 以及宿主能力（ChannelHost）。编排层的具体实现被 ChannelHost 挡在外面，
 * 这样 Telegram / HTTP / CLI 三个通道可以用桩宿主直接单测，
 * 也避免通道层反向依赖 AgentOrchestrator 造成模块环。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage } from '../domain/index.js';
import type {
  RunTaskRequest,
  SessionStatus,
  TaskOutcome,
  TraceSummary,
  UsageAggregate,
} from '../agent/index.js';

/** 已实现的通道种类。 */
export type ChannelName = 'telegram' | 'whatsapp' | 'wechat' | 'http' | 'cli';

/** 附件沿用消息层定义，通道不自造格式。 */
export type ChannelAttachments = NonNullable<AgentMessage['attachments']>;

/**
 * 回写目标。
 *
 * send 返回平台侧消息 id（没有 id 的通道返回 undefined）；
 * edit 为可选能力，仅 Telegram 这类支持就地编辑的通道实现，
 * 不支持时 StreamRenderer 会自动退化为「攒够一页再发一条」。
 */
export interface OutboundTarget {
  readonly channel: ChannelName;
  /** 稳定标识，用于出站重投缓冲定位收件人（FR-CHAN-014） */
  readonly targetId: string;
  send(text: string): Promise<string | undefined>;
  edit?(messageId: string, text: string): Promise<boolean>;
}

/** 归一化后的入站消息（FR-CHAN-001）。 */
export interface InboundMessage {
  channel: ChannelName;
  /** 会话键：Telegram 用 chat:<id>，WhatsApp 用 whatsapp:<jid>，HTTP 用 http:<session>，CLI 用 cli:<agent> */
  sessionKey: string;
  /** 已剥离命令前缀与 @mention 的正文 */
  text: string;
  receivedAt: string;
  target: OutboundTarget;
  attachments?: ChannelAttachments | undefined;
  /** @mention 命中的智能体，路由第一优先级 */
  agentId?: string | undefined;
  /** 通道绑定的默认智能体，路由第二优先级 */
  defaultAgent?: string | undefined;
}

/**
 * 通道对编排层的最小依赖面。
 *
 * 只暴露通道真正会用到的七个动作，宿主实现见 manager.ts 的 createChannelHost。
 */
export interface ChannelHost {
  runTask(request: RunTaskRequest): Promise<TaskOutcome>;
  /** 中止该会话下所有在跑任务，返回被中止的任务 id */
  abortSession(sessionKey: string): string[];
  status(sessionKey: string, channelDefaultAgent?: string): SessionStatus;
  trace(taskId: string): TraceSummary | undefined;
  agentIds(): string[];
  /** 列出所有可用模型目录 */
  models?(): Array<{ fullName: string; alias: string; providerId: string; description?: string }>;
  /** 获取当前会话生效的模型 */
  sessionModel?(sessionKey: string): string | undefined;
  /** 切换当前会话生效的模型 */
  setSessionModel?(sessionKey: string, model: string): void;
  /** 列出已导入的工作区项目列表 */
  projects?(): Array<{ id: string; name: string; path: string }>;
  /** 获取当前会话生效的项目工作区 */
  sessionWorkspace?(sessionKey: string): string | undefined;
  /** 切换当前会话生效的项目工作区 */
  setSessionWorkspace?(sessionKey: string, workspace: string): void;
  /** 获取 Git 状态 */
  gitStatus?(projectPath: string): Promise<{
    isRepo: boolean;
    branch: string;
    remoteUrl?: string | undefined;
    changedFiles: Array<{ status: string; file: string; additions: number; deletions: number }>;
    uncommittedCount: number;
    totalAdditions: number;
    totalDeletions: number;
    recentCommits: Array<{ hash: string; message: string }>;
  }>;
  /** 获取 Git Diff */
  gitDiff?(projectPath: string, file?: string): Promise<{ ok: boolean; diff: string }>;
  /** Git 提交 */
  gitCommit?(projectPath: string, message: string): Promise<{ ok: boolean; summary: string }>;
  /** Git 推送 */
  gitPush?(projectPath: string): Promise<{ ok: boolean; summary: string }>;
  /** 在工作区执行 Shell 命令 */
  execShell?(projectPath: string, command: string): Promise<{ ok: boolean; output: string }>;
  /** 获取技能列表 */
  skills?(): Array<{ id: string; name: string; description: string; enabled: boolean }>;
  /** 获取 MCP 插件列表 */
  plugins?(): Array<{ id: string; name: string; description: string; enabled: boolean }>;
  /** 清空会话历史（/new） */
  clearSession(sessionKey: string, channelDefaultAgent?: string): void;
  usageSince(since: string): UsageAggregate[];
}

/** 通道生命周期。manager 只按该接口启停，不关心内部实现。 */
export interface Channel {
  readonly name: ChannelName;
  start(): Promise<void>;
  stop(): Promise<void>;
}
