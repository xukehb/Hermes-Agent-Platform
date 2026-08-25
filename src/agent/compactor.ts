/**
 * 上下文压缩与溢出兜底（FR-LOOP-013 / FR-LOOP-014）。
 *
 * 压缩策略：把「早期历史」交给 utility_model 生成摘要，替换为一条 system 消息，
 * 保留最近若干轮原文。切分点不是简单的「倒数第 N 条」，而是要保证
 * assistant 的 tool_calls 与其对应的 tool 结果不被拆散——
 * 拆散会导致 openai-tools / anthropic 线制直接报「tool_call 缺少响应」而整轮失败。
 *
 * 压缩后仍超窗时不静默截断，而是抛 CONTEXT_OVERFLOW（FR-LOOP-014）：
 * 静默丢历史会让模型基于残缺信息给出看似正常但实际错误的结论，比失败更糟。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { AgentMessage, TokenUsage } from '../domain/index.js';
import { RecoverableError, FatalError, addUsage, emptyUsage } from '../domain/index.js';
import { estimateHistoryTokens, textOfProtocolEvents, collectProtocolEvents, protocolAdapter } from '../protocol/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { ModelPlan } from './router.js';
import { COMPACT_SYSTEM_PROMPT } from './system-prompt.js';

/** 保留的最近轮次数量下限：至少留下最后一次用户提问及其后续。 */
const MIN_KEEP_MESSAGES = 4;

/** 压缩判定结果。 */
export interface CompactDecision {
  /** 是否需要压缩 */
  needed: boolean;
  /** 当前估算 token */
  estimated: number;
  /** 触发阈值（绝对 token 数） */
  threshold: number;
}

/** 判断是否达到压缩阈值。 */
export function shouldCompact(
  history: readonly AgentMessage[],
  systemPrompt: string,
  contextWindow: number,
  compactThreshold: number,
): CompactDecision {
  const estimated = estimateHistoryTokens(history, systemPrompt);
  const threshold = Math.floor(contextWindow * compactThreshold);
  return { needed: estimated > threshold, estimated, threshold };
}

/**
 * 找一个安全的切分下标：该下标之后的消息自成完整段落。
 *
 * 安全定义为：切点处不能位于「assistant 发起工具调用」到「其全部 tool 结果」之间。
 * 实现上从目标位置向后扫，直到遇到一条 user 消息或一条无 toolCalls 的 assistant 消息。
 */
export function safeSplitIndex(history: readonly AgentMessage[], target: number): number {
  if (target <= 0) return 0;
  for (let index = target; index < history.length; index += 1) {
    const message = history[index];
    if (message === undefined) break;
    if (message.role === 'user') return index;
    if (message.role === 'assistant' && (message.toolCalls === undefined || message.toolCalls.length === 0)) {
      return index + 1;
    }
  }
  return history.length;
}

/** 把一段历史渲染成供摘要模型阅读的纯文本。 */
export function renderHistoryForSummary(history: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of history) {
    if (message.role === 'system') {
      lines.push('[系统] ' + message.content);
      continue;
    }
    if (message.role === 'user') {
      lines.push('[用户] ' + message.content);
      continue;
    }
    if (message.role === 'tool') {
      const result = message.toolResult;
      if (result === undefined) continue;
      lines.push('[工具 ' + result.name + (result.isError ? ' 失败' : ' 成功') + '] ' + result.content);
      continue;
    }
    if (message.content !== '') lines.push('[助手] ' + message.content);
    for (const call of message.toolCalls ?? []) {
      lines.push('[助手调用工具] ' + call.name + ' ' + JSON.stringify(call.args));
    }
  }
  return lines.join('\n');
}

/** 压缩结果。 */
export interface CompactResult {
  history: AgentMessage[];
  /** 摘要正文 */
  summary: string;
  /** 被压缩掉的消息条数 */
  compacted: number;
  usage: TokenUsage;
  /** 压缩后的估算 token */
  estimated: number;
}

export interface CompactorOptions {
  registry: ProviderRegistry;
  utility: ModelPlan;
  signal: AbortSignal;
  /** 保留的最近消息条数目标值 */
  keepRecent?: number;
}

/**
 * 执行压缩。
 *
 * 摘要调用刻意不带工具、不带历史 system：摘要器只需读文本、写文本，
 * 给它工具只会诱发不必要的工具调用并浪费一轮。
 */
export async function compactHistory(
  history: readonly AgentMessage[],
  systemPrompt: string,
  options: CompactorOptions,
): Promise<CompactResult> {
  const keepRecent = Math.max(options.keepRecent ?? 6, MIN_KEEP_MESSAGES);
  const target = Math.max(history.length - keepRecent, 0);
  const splitAt = safeSplitIndex(history, target);

  if (splitAt <= 0) {
    // 整段历史都无法安全切分（例如单轮里塞了超长工具输出），压缩无从下手
    throw new FatalError('CONTEXT_OVERFLOW', '会话历史无法安全压缩：最近一轮本身已超出上下文窗口', {
      context: { messages: history.length },
    });
  }

  const older = history.slice(0, splitAt);
  const recent = history.slice(splitAt);
  const rendered = renderHistoryForSummary(older);

  const adapter = protocolAdapter(options.utility.protocol);
  const summaryHistory: AgentMessage[] = [
    { role: 'user', content: '请压缩以下对话历史：\n\n' + rendered },
  ];
  const request = adapter.buildRequest(summaryHistory, {
    wireApi: options.utility.provider.wireApi,
    model: options.utility.model,
    systemPrompt: COMPACT_SYSTEM_PROMPT,
    tools: [],
    params: options.utility.params,
    maxTokens: Math.min(options.utility.maxTokens, 2048),
  });

  const client = options.registry.client(options.utility.providerId);
  const events = await collectProtocolEvents(client.send(request, options.signal), adapter.createParser());
  const summary = textOfProtocolEvents(events).trim();
  let usage = emptyUsage();
  for (const event of events) if (event.type === 'usage') usage = addUsage(usage, event.usage);

  if (summary === '') {
    throw new RecoverableError('CONTEXT_OVERFLOW', '摘要模型未返回内容，压缩失败', {
      userMessage: '上下文压缩失败：摘要模型未返回内容，请稍后重试或改用更短的指令。',
      context: { utilityModel: options.utility.fullName },
    });
  }

  const compactedMessage: AgentMessage = {
    role: 'system',
    content: '【早期对话摘要（由 ' + options.utility.fullName + ' 压缩自 ' + older.length + ' 条消息）】\n' + summary,
    createdAt: new Date().toISOString(),
  };
  const next = [compactedMessage, ...recent];

  return {
    history: next,
    summary,
    compacted: older.length,
    usage,
    estimated: estimateHistoryTokens(next, systemPrompt),
  };
}

/**
 * 压缩后仍超窗时的兜底（FR-LOOP-014）。
 * 单独成函数是为了让循环里的判断点只有一行，便于测试直接覆盖该分支。
 */
export function assertFitsContext(
  estimated: number,
  contextWindow: number,
  modelFullName: string,
): void {
  if (estimated <= contextWindow) return;
  throw new FatalError('CONTEXT_OVERFLOW', '压缩后仍超出上下文窗口：估算 ' + estimated + ' token，窗口 ' + contextWindow + ' token', {
    userMessage: '本次会话内容已超出模型 ' + modelFullName + ' 的上下文窗口（估算 ' + estimated
      + ' token，上限 ' + contextWindow + ' token），已停止以避免丢失内容。请用 /reset 开始新会话，或把任务拆分为更小的步骤。',
    context: { estimated, contextWindow, model: modelFullName },
  });
}
