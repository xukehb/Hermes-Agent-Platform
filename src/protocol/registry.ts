/**
 * 协议适配器注册表（FR-LOOP-011 明确「实现且仅实现」4 个适配器）。
 *
 * 新增厂商时只需在配置里声明 default_protocol 指向已有适配器，
 * 不改这里的代码；只有出现全新线制才允许新增适配器实现。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { ConfigError, type ProtocolName } from '../domain/index.js';

import { AnthropicAdapter } from './adapters/anthropic.js';
import { DeepSeekAdapter } from './adapters/deepseek.js';
import { HermesNativeAdapter } from './adapters/hermes-native.js';
import { OpenAiToolsAdapter } from './adapters/openai-tools.js';
import type { ProtocolAdapter } from './types.js';

/** 适配器为无状态对象（解析器每轮新建），全局单例复用即可。 */
const ADAPTERS: Record<ProtocolName, ProtocolAdapter> = {
  'hermes-native': new HermesNativeAdapter(),
  'openai-tools': new OpenAiToolsAdapter(),
  deepseek: new DeepSeekAdapter(),
  anthropic: new AnthropicAdapter(),
};

export const PROTOCOL_NAMES: readonly ProtocolName[] = Object.keys(ADAPTERS) as ProtocolName[];

export function protocolAdapter(name: ProtocolName): ProtocolAdapter {
  const adapter = ADAPTERS[name];
  if (adapter === undefined) {
    throw new ConfigError('CONFIG_INVALID', '未知协议：' + String(name), { protocol: name });
  }
  return adapter;
}
