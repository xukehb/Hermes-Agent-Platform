/**
 * 线制层类型：SDK 调用形态与协议语义之间的中间表示。
 *
 * 分层职责（对应规格 §1.2 的 Runtime → ProviderClient 单向依赖）：
 * - ProtocolAdapter 负责「语义 ↔ 线制」：内部 ToolCall 抽象与厂商原生表示的双向翻译。
 * - ProviderClient 负责「线制 ↔ SDK」：把 WireRequest 交给对应 SDK 端点，
 *   并把各 SDK 的流式响应归一化为 WireEvent 序列。
 *
 * 这样新增厂商只需增加配置块（复用既有 ProviderClient），
 * 新增协议只需增加一个 ProtocolAdapter（§3.4 可扩展性矩阵）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { FinishReason, TokenUsage } from './types.js';

/**
 * 线制请求体。字段刻意保持「最小公倍数」形态：
 * messages/tools 为 unknown[]，因为其元素结构由适配器按目标线制决定，
 * ProviderClient 只做透传，不理解其内部语义。
 */
export interface WireRequest {
  model: string;
  /** 已按目标线制序列化的消息数组 */
  messages: unknown[];
  /** Anthropic Messages API 的 system 是顶层参数而非消息项 */
  system?: string;
  /** 已按目标线制序列化的工具声明数组；hermes-native 不使用该字段 */
  tools?: unknown[];
  /** 采样参数等透传项（temperature / top_p / ...） */
  params: Record<string, unknown>;
  /** Anthropic 必填；OpenAI 线制可选（FR-LOOP-011A 第 4 点） */
  maxTokens?: number;
  /** 停止序列。hermes-native 用它在 </tool_call> 处收束 */
  stop?: string[];
}

/**
 * 归一化流式事件。各 SDK 的 chunk 结构差异在 ProviderClient 内被吸收。
 *
 * 工具调用被拆为 start / args_delta / args_object / end 四类事件，
 * 原因是 OpenAI 线制的 arguments 是逐片到达的 JSON 字符串，
 * 而 Anthropic 的 input 在 input_json_delta 累积后才成为对象。
 */
export type WireEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'tool_call_end'; index: number }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

/** 提供商连通性自检结果（FR-PROV-005） */
export interface ProviderCheckResult {
  providerId: string;
  reachable: boolean;
  /** 握手耗时（毫秒） */
  handshakeMs: number;
  /** 端点支持列举时返回的模型标识列表 */
  models: string[];
  /** 不可达时的原因摘要（已剔除凭据信息，FR-PROV-002） */
  error?: string;
}

/** 底层传输客户端。一个提供商实例对应一个 ProviderClient。 */
export interface ProviderClient {
  readonly providerId: string;
  readonly wireApi: import('./types.js').WireApi;
  /** 发起一次流式请求，产出归一化事件序列。 */
  send(request: WireRequest, signal?: AbortSignal): AsyncIterable<WireEvent>;
  /** 最小化探测：可达性 + 握手耗时 + 可用模型列表。 */
  check(signal?: AbortSignal): Promise<ProviderCheckResult>;
}
