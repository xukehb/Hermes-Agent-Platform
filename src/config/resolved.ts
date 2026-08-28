/**
 * 解析后的运行时配置形态（Resolved*）。
 *
 * 原始配置（schema.ts）几乎全部字段都是 optional，用于表达「此层未声明」；
 * 运行时不应再到处判空，因此 ConfigResolver 的输出统一收敛为本文件的 Resolved* 结构：
 * 所有值都已按六层优先级取定，路径已展开为绝对路径，数组已复制为可变副本。
 *
 * 独立成文件而非塞进 resolver.ts 的原因：defaults.ts 需要这些类型标注 BUILTIN 常量，
 * 若类型定义在 resolver.ts 内会形成 defaults 与 resolver 的循环依赖。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ConfigLayer, ProtocolName, WireApi } from '../domain/index.js';

/** 智能体运行模式（FR-TASK-001）。 */
export type RuntimeMode = 'oneshot' | 'persistent';

/** 工具集档位。与 schema.ts 的 toolSelectionSchema.profile 枚举保持一致，若漂移则赋值处报错。 */
export type ToolProfileName = 'minimal' | 'standard' | 'coding' | 'research' | 'full';

/** 解析后的配额上限（第 3.3 节）。全部字段必填，运行时直接使用。 */
export interface ResolvedLimits {
  /** 单任务工具调用轮数上限（FR-LOOP-009） */
  maxIterations: number;
  /** 子智能体派生深度上限（FR-ROUTE-009） */
  maxSubagentDepth: number;
  /** 单个工具执行超时 */
  toolTimeoutMs: number;
  /** 工具输出裁剪阈值，超出部分落盘到 overflowDir（FR-TOOL-005） */
  toolOutputMaxBytes: number;
  /** 上下文占用达该比例触发压缩（FR-LOOP-013） */
  compactThreshold: number;
  /** 每智能体日 token 预算（FR-TASK-007） */
  dailyTokenBudget: number;
  sessionRetentionDays: number;
  /** 入站队列容量，满载时按背压丢弃最旧（FR-CHAN-013） */
  ingressQueueSize: number;
  /** provider id 到并发上限的映射；未列出者取 defaultProviderConcurrency（FR-ROUTE-006） */
  providerConcurrency: Record<string, number>;
  /** provider id 到每分钟请求上限的映射；未列出者不限速 */
  providerRpm: Record<string, number>;
  agentConcurrency: Record<string, number>;
  agentRpm: Record<string, number>;
  defaultProviderConcurrency: number;
  defaultAgentConcurrency: number;
}

/** 解析后的数据目录，均为已展开的绝对路径。 */
export interface ResolvedPaths {
  dataDir: string;
  /** 任务 trace JSONL 落盘目录（FR-TASK-006） */
  traceDir: string;
  /** 工具输出溢出文件目录（FR-TOOL-005） */
  overflowDir: string;
  /** 出站消息重投缓冲目录（FR-CHAN-014） */
  spoolDir: string;
}

/** 解析后的模型绑定（FR-ROUTE-001）。primary 与 fallbacks 均为规范化后的 provider/model 全名。 */
export interface ResolvedModelBinding {
  primary: string;
  fallbacks: string[];
}

/** 解析后的工具集裁剪结果（FR-TOOL-003）。 */
export interface ResolvedToolSelection {
  profile: ToolProfileName;
  /** 空数组表示不额外收窄，直接取 profile 展开结果 */
  allow: string[];
  /** deny 始终优先于 allow */
  deny: string[];
}

/** 解析后的智能体。运行时只依赖该结构，不再回头读原始配置。 */
export interface ResolvedAgent {
  id: string;
  name: string;
  description: string;
  /** 文件工作目录，已按 workspace_root 与 id 展开为绝对路径（FR-AGT-002） */
  workspace: string;
  /** 状态目录，内含该智能体独立的 SQLite 会话库（FR-AGT-002） */
  agentDir: string;
  model: ResolvedModelBinding;
  /** 辅助调用模型（标题、压缩、意图分类）；缺省时复用 primary（FR-ROUTE-002） */
  utilityModel: string | undefined;
  /** 显式声明的协议；undefined 表示交给探测链推断（FR-LOOP-012） */
  protocol: ProtocolName | undefined;
  params: Record<string, unknown>;
  capabilities: string[];
  tools: ResolvedToolSelection;
  /** 允许派生的子智能体 id 列表（FR-ROUTE-007/008） */
  subagentAllow: string[];
  runtime: { mode: RuntimeMode; idleTimeoutMs: number };
  identity: { emoji: string; displayName: string };
  /** 职责段提示文件的绝对路径（FR-AGT-007） */
  systemPromptFile: string | undefined;
  /** 是否向用户展示 reasoning 内容（FR-LOOP-014） */
  reasoningVisible: boolean;
  limits: ResolvedLimits;
}

/** 解析后的提供商。凭据不入该结构，运行时按 envKey 现取现用（FR-PROV-002）。 */
export interface ResolvedProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** 缺省表示无凭据提供商，如本地 Ollama（FR-PROV-003） */
  envKey: string | undefined;
  wireApi: WireApi;
  defaultProtocol: ProtocolName;
  httpHeaders: Record<string, string>;
  /** 值为环境变量名，运行时读取后拼为请求头 */
  envHttpHeaders: Record<string, string>;
  requestMaxRetries: number;
  streamMaxRetries: number;
  streamIdleTimeoutMs: number;
  /** Anthropic 的 max_tokens 必填兜底值（FR-LOOP-011A） */
  maxTokensDefault: number;
}

/** 解析后的模型目录条目。 */
export interface ResolvedModel {
  /** 目录别名，即 [models.<alias>] 的键 */
  alias: string;
  providerId: string;
  /** 厂商侧真实模型标识 */
  model: string;
  displayName: string;
  /** provider/model 全名，路由与 trace 统一使用该形式 */
  fullName: string;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  capabilities: string[];
  protocol: ProtocolName | undefined;
  params: Record<string, unknown>;
}

export interface ResolvedTelegramWebhook {
  url: string;
  bind: string;
  path: string;
}

/** 解析后的 Telegram 通道（FR-CHAN-015/016）。 */
export interface ResolvedTelegramChannel {
  enabled: boolean;
  tokenEnv: string;
  mode: 'polling' | 'webhook';
  /** 通道绑定的默认智能体，路由第二优先级（FR-ROUTE-003） */
  defaultAgent: string | undefined;
  mentionPatterns: string[];
  /** 平台硬上限，超出则分片（FR-CHAN-015） */
  messageCharLimit: number;
  /** 仅 webhook 模式下存在 */
  webhook: ResolvedTelegramWebhook | undefined;
}

/** 解析后的 WhatsApp 通道。authDir 为 Baileys 多文件登录态目录。 */
export interface ResolvedWhatsAppChannel {
  enabled: boolean;
  authDir: string;
  defaultAgent: string | undefined;
  mentionPatterns: string[];
  messageCharLimit: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  qrLog: boolean;
}

export interface ResolvedWeChatWeCom {
  corpId: string | undefined;
  corpSecretEnv: string;
  agentId: number | undefined;
  token: string | undefined;
  encodingAesKey: string | undefined;
  webhookUrlEnv: string;
  bind: string;
  path: string;
}

export interface ResolvedWeChatOfficialAccount {
  appId: string | undefined;
  appSecretEnv: string;
  token: string | undefined;
  encodingAesKey: string | undefined;
  bind: string;
  path: string;
}

/** 解析后的微信通道配置。 */
export interface ResolvedWeChatChannel {
  enabled: boolean;
  mode: 'personal' | 'wecom' | 'official_account';
  defaultAgent: string | undefined;
  mentionPatterns: string[];
  messageCharLimit: number;
  authDir: string;
  qrLog: boolean;
  wecom: ResolvedWeChatWeCom | undefined;
  officialAccount: ResolvedWeChatOfficialAccount | undefined;
}

export interface ResolvedHttpChannel {
  enabled: boolean;
  bind: string;
  defaultAgent: string | undefined;
}

export interface ResolvedCliChannel {
  enabled: boolean;
  defaultAgent: string | undefined;
}

/** 解析后的通道总配置。 */
export interface ResolvedChannels {
  /** 流式回写节流间隔（FR-CHAN-015） */
  editIntervalMs: number;
  /** 超过该时长转异步卡片（FR-CHAN-008） */
  asyncThresholdMs: number;
  telegram: ResolvedTelegramChannel;
  whatsapp: ResolvedWhatsAppChannel;
  wechat: ResolvedWeChatChannel;
  http: ResolvedHttpChannel;
  cli: ResolvedCliChannel;
}

/** config explain 的单层取值记录（FR-CFG-006）。 */
export interface ExplainCandidate {
  layer: ConfigLayer;
  /** 该层是否声明了此键 */
  present: boolean;
  value: unknown;
  /** 取值出处的可读描述，如 agents.entries.coder.model 或 HAP_MODEL */
  source: string;
}

/** config explain 的完整输出（FR-CFG-006）。 */
export interface ExplainResult {
  key: string;
  agentId: string | undefined;
  value: unknown;
  /** 最终胜出层 */
  winner: ConfigLayer;
  /** 六层逐层取值，按优先级从高到低排列 */
  candidates: ExplainCandidate[];
}
