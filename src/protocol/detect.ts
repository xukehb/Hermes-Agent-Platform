/**
 * 协议探测继承链（FR-LOOP-012）。
 *
 * 规格给出的推断顺序是「模型名含 hermes > 提供商 default_protocol > 全局默认」，
 * 前提是「智能体未显式声明 protocol」。本实现在此基础上把模型条目自身的
 * protocol 声明也视为显式声明（排在名称启发式之前）：显式配置压过启发式匹配，
 * 否则一个名字里带 hermes 但实际走 OpenAI 线制的模型将无法通过配置纠正。
 * 命中层级会写入 trace，便于 hap explain 复盘。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ProtocolName, ProtocolSource } from '../domain/index.js';

/** 全局兜底协议。 */
export const GLOBAL_DEFAULT_PROTOCOL: ProtocolName = 'openai-tools';

/** 模型名命中该关键字时视为 Hermes 标签协议。 */
const HERMES_KEYWORD = 'hermes';

export interface ProtocolDetectionInput {
  /** 智能体显式声明 */
  agentProtocol?: ProtocolName | undefined;
  /** 模型条目显式声明 */
  modelProtocol?: ProtocolName | undefined;
  /** 提供商 default_protocol（FR-PROV-008） */
  providerDefault?: ProtocolName | undefined;
  /** provider 侧模型标识，用于名称启发式 */
  model: string;
}

export interface ProtocolDetection {
  protocol: ProtocolName;
  source: ProtocolSource;
}

export function detectProtocol(input: ProtocolDetectionInput): ProtocolDetection {
  if (input.agentProtocol !== undefined) return { protocol: input.agentProtocol, source: 'agent-explicit' };
  if (input.modelProtocol !== undefined) return { protocol: input.modelProtocol, source: 'model-explicit' };
  if (input.model.toLowerCase().includes(HERMES_KEYWORD)) {
    return { protocol: 'hermes-native', source: 'model-name-hermes' };
  }
  if (input.providerDefault !== undefined) return { protocol: input.providerDefault, source: 'provider-default' };
  return { protocol: GLOBAL_DEFAULT_PROTOCOL, source: 'global-default' };
}
