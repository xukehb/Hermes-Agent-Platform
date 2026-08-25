/**
 * 领域基础类型：平台内部与任何厂商线制无关的统一抽象。
 *
 * 设计约束（AGENTS.md 第 4 节）：
 * - 本文件不依赖任何外部 SDK，是依赖图的汇点；其余模块单向指向此处。
 * - 一切厂商差异（字段命名、消息结构）都在 protocol 层被翻译掉，不得泄漏到这里。
 *
 * 日期：2026-08-24  执行者：Codex
 */

/** 消息角色：ChatML 四类角色（FR-LOOP-001） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** JSON Schema 片段。工具参数声明与运行时校验共用此结构（FR-LOOP-002 / FR-LOOP-009） */
export type JsonSchema = Record<string, unknown>;

/** 附件类型。入站附件落地到智能体 workspace 的 inbox/ 目录（FR-CHAN-011） */
export type AttachmentKind = 'image' | 'audio' | 'document';

/** 入站附件的本地化描述。平台只传本地路径给模型，不转发平台临时 URL。 */
export interface Attachment {
  kind: AttachmentKind;
  /** 落地后的本地绝对路径 */
  path: string;
  fileName?: string;
  mimeType?: string;
  bytes?: number;
}

/**
 * 工具调用的内部抽象。
 *
 * args 一律为「已解析对象」：OpenAI 线制的 JSON 字符串在适配器入口即被解析，
 * Anthropic 线制的 input 本身已是对象、不得二次解析（FR-LOOP-011A 第 2 点）。
 */
export interface ToolCall {
  /** 调用标识。Anthropic 侧须与 tool_use.id 严格对应（FR-LOOP-011A 第 3 点） */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 工具执行结果的内部抽象。 */
export interface ToolResult {
  /** 对应 ToolCall.id */
  callId: string;
  name: string;
  /** 面向模型的文本结果（已按 FR-TOOL-007 裁剪） */
  content: string;
  /** 是否为错误结果。错误一律回灌模型而非终止任务（§6 可恢复错误） */
  isError: boolean;
  /** 输出被裁剪时，完整输出的落盘路径（FR-TOOL-007） */
  overflowPath?: string;
  durationMs?: number;
}

/**
 * 平台内部统一消息。整段对话历史以此结构持久化，
 * 跨协议降级时由该结构重新序列化为新线制格式（FR-LOOP-015）。
 */
export interface AgentMessage {
  role: MessageRole;
  /** 面向用户的正文。推理段不混入此字段（FR-LOOP-005） */
  content: string;
  /** 推理段：<think> / <scratch_pad> / reasoning_content 归一化后的内容 */
  reasoning?: string;
  /** 助手侧发起的工具调用，按输出顺序排列（FR-LOOP-008） */
  toolCalls?: ToolCall[];
  /** role === 'tool' 时承载的执行结果 */
  toolResult?: ToolResult;
  attachments?: Attachment[];
  /** ISO 8601 时间戳 */
  createdAt?: string;
}

/** 工具声明。source 用于同名冲突重命名（FR-TOOL-006） */
export interface ToolDefinition {
  name: string;
  description: string;
  /** 参数 JSON Schema。注入位置由各适配器决定（FR-LOOP-011） */
  parameters: JsonSchema;
  /** 来源标识：'builtin' 或 MCP 服务器 id */
  source: string;
}

/** token 用量。按智能体/提供商/模型三维累计（FR-TASK-007） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 推理模型单独计费的思考 token（DeepSeek reasoner / OpenAI o 系列） */
  reasoningTokens?: number;
  totalTokens: number;
}

/** 空用量常量，用于累加初值。 */
export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** 用量累加。reasoningTokens 仅在任一侧存在时出现，避免污染无推理模型的统计。 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  const merged: TokenUsage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  if (reasoning > 0) merged.reasoningTokens = reasoning;
  return merged;
}

/** 单轮结束原因。 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';

/** 协议适配器名称。系统实现且仅实现这 4 个（FR-LOOP-011） */
export type ProtocolName = 'hermes-native' | 'openai-tools' | 'deepseek' | 'anthropic';

/** 线制名称。决定使用哪个 SDK 端点（FR-PROV-004 / FR-PROV-009） */
export type WireApi = 'chat' | 'responses' | 'anthropic-messages';

/** 模型引用：provider/model 两段式（FR-ROUTE-001） */
export interface ModelRef {
  providerId: string;
  model: string;
}

/** 解析 'provider/model' 形式的模型引用。model 段允许含斜杠（如 openrouter 的 vendor/name）。 */
export function parseModelRef(raw: string): ModelRef {
  const idx = raw.indexOf('/');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error('模型引用格式应为 <provider>/<model>，实际收到：' + raw);
  }
  return { providerId: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

/** 还原为 'provider/model' 字符串。 */
export function formatModelRef(ref: ModelRef): string {
  return ref.providerId + '/' + ref.model;
}
