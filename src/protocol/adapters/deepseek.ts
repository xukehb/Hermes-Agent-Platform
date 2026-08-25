/**
 * deepseek 适配器（FR-LOOP-011）。
 *
 * 请求体与 openai-tools 完全一致，差异只有一处：推理内容单独成字段。
 * DeepSeek 官方端点把它放在 delta.reasoning_content（provider 客户端已归一为
 * reasoning_delta 事件），而部分中转代理会把推理直接内联进正文的 <think> 标签，
 * 因此这里额外注册推理标签，保证两种形态都能与正文分离（FR-LOOP-005）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { OpenAiToolsAdapter } from './openai-tools.js';

/** 代理常用的内联推理标签。 */
const DEEPSEEK_REASONING_TAGS: readonly string[] = ['thinking', 'think'];

export class DeepSeekAdapter extends OpenAiToolsAdapter {
  constructor() {
    super({ name: 'deepseek', tags: DEEPSEEK_REASONING_TAGS });
  }
}
