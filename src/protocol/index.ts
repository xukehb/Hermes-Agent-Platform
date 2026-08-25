/**
 * 协议层出口。
 *
 * 日期：2026-08-24  执行者：Codex
 */

export * from './types.js';
export * from './stream-tag-parser.js';
export * from './wire-parser.js';
export * from './prompt-composer.js';
export * from './message-parts.js';
export * from './attachments.js';
export * from './detect.js';
export * from './registry.js';
export { OpenAiToolsAdapter, buildChatMessages, buildResponsesInput, chatToolSchemas, responsesToolSchemas } from './adapters/openai-tools.js';
export { DeepSeekAdapter } from './adapters/deepseek.js';
export { AnthropicAdapter, anthropicToolSchemas, buildAnthropicMessages } from './adapters/anthropic.js';
export { HermesNativeAdapter, buildHermesMessages } from './adapters/hermes-native.js';
