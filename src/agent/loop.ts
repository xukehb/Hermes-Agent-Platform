/**
 * 智能体主循环（FR-LOOP-001~015、FR-ROUTE-004/005、FR-TOOL-*）。
 *
 * 循环只和三个抽象打交道：ProtocolAdapter（翻译）、ProviderClient（发流）、
 * ToolExecutor（执行）。厂商、线制、协议差异全部封在适配器与客户端里，
 * 因此降级换厂商时循环本身无需任何分支——只是换一个 ModelPlan 重新 buildRequest，
 * 内部消息抽象原样重新序列化，这正是 FR-LOOP-015 要求的「历史重译」。
 *
 * 三层失败处理边界：
 * 1. 工具层问题（找不到/参数错/超时/报错）→ ToolExecutor 收敛为 isError 回灌，循环继续；
 * 2. 单模型请求失败或流不完整 → 沿 fallbacks 降级，已完成的工具结果保留（FR-ROUTE-004）；
 * 3. 降级耗尽 → 抛 FALLBACK_EXHAUSTED，由编排层落 trace 并回复用户（FR-ROUTE-005）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import {
  RecoverableError,
  FatalError,
  addUsage,
  describeError,
  emptyUsage,
  isRetryable,
} from '../domain/index.js';
import type {
  AgentMessage,
  FinishReason,
  ProtocolName,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../domain/index.js';
import type { ConfigResolver } from '../config/index.js';
import { protocolAdapter } from '../protocol/index.js';
import type { ProtocolEvent } from '../protocol/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import { ToolExecutor } from '../tools/index.js';
import type { ToolContext, ToolRegistry } from '../tools/index.js';
import { assertFitsContext, compactHistory, shouldCompact } from './compactor.js';
import type { ModelPlan } from './router.js';
import { planModelChain, planUtilityModel } from './router.js';
import type { LoopRequest, LoopResult, StopReason, TaskEvent } from './types.js';

/** 单轮请求的解析产物。 */
interface TurnOutcome {
  text: string;
  reasoning: string;
  calls: ToolCall[];
  /** 参数不是合法 JSON 的调用，其错误说明按 callId 索引 */
  argErrors: Map<string, string>;
  usage: TokenUsage;
  finishReason: FinishReason;
  /** 流结束时仍未闭合的标签名（FR-LOOP-007） */
  incomplete: string[];
}

/** 循环依赖注入。 */
export interface AgentLoopDeps {
  resolver: ConfigResolver;
  providers: ProviderRegistry;
  tools: ToolRegistry;
}

/** 把协议事件流折叠为一轮结果。 */
function foldTurn(events: readonly ProtocolEvent[]): TurnOutcome {
  const outcome: TurnOutcome = {
    text: '',
    reasoning: '',
    calls: [],
    argErrors: new Map<string, string>(),
    usage: emptyUsage(),
    finishReason: 'stop',
    incomplete: [],
  };
  for (const event of events) {
    switch (event.type) {
      case 'text':
        outcome.text += event.text;
        break;
      case 'reasoning':
        outcome.reasoning += event.text;
        break;
      case 'tool_call':
        outcome.calls.push(event.call);
        if (event.argsError !== undefined) outcome.argErrors.set(event.call.id, event.argsError);
        break;
      case 'incomplete':
        outcome.incomplete.push(event.tag);
        break;
      case 'usage':
        outcome.usage = addUsage(outcome.usage, event.usage);
        break;
      case 'finish':
        outcome.finishReason = event.reason;
        break;
    }
  }
  return outcome;
}

/** 参数解析失败时直接构造回灌结果，不进 ToolExecutor（FR-LOOP-009）。 */
function argErrorResult(call: ToolCall, reason: string, definitions: readonly ToolDefinition[]): ToolResult {
  const definition = definitions.find((item) => item.name === call.name);
  const schema = definition === undefined
    ? ''
    : '\n该工具的参数结构（JSON Schema）：\n' + JSON.stringify(definition.parameters, null, 2);
  return {
    callId: call.id,
    name: call.name,
    content: '工具 ' + call.name + ' 的 arguments 不是合法 JSON：' + reason
      + schema + '\n请重新输出合法的 JSON 参数。',
    isError: true,
    durationMs: 0,
  };
}

export class AgentLoop {
  private readonly deps: AgentLoopDeps;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
  }

  /** 执行一次完整任务循环。 */
  async run(request: LoopRequest): Promise<LoopResult> {
    const { agent } = request;
    const chain = planModelChain(this.deps.resolver, agent);
    const executor = new ToolExecutor(this.deps.tools);
    const definitions = this.deps.tools.definitionsFor(agent);

    let history = [...request.history];
    const produced: AgentMessage[] = [];
    let usage = emptyUsage();
    let retranslations = 0;
    let planIndex = 0;
    let plan = this.planAt(chain, planIndex);
    let iterations = 0;
    let stopReason: StopReason = 'stop';
    let finishReason: FinishReason = 'stop';
    let finalText = '';
    let finalReasoning = '';

    this.emitProtocolTrace(request, plan);

    while (iterations < agent.limits.maxIterations) {
      this.throwIfAborted(request);
      iterations += 1;
      request.onEvent?.({ type: 'iteration', index: iterations });

      // 压缩判断放在每轮请求前：工具输出是上下文膨胀的主因，
      // 上一轮回灌完就可能越线，等到发请求被拒再处理已经浪费一次往返。
      history = await this.ensureContextFits(request, plan, history, usage, (extra) => {
        usage = addUsage(usage, extra);
      });

      const turn = await this.requestTurn(request, chain, planIndex, history, definitions, {
        onSwitch: (from, to, reason) => {
          retranslations += 1;
          request.onEvent?.({ type: 'model_switch', from: from.fullName, to: to.fullName, reason });
          request.onTrace?.({
            kind: 'model-switch',
            at: new Date().toISOString(),
            from: from.fullName,
            to: to.fullName,
            reason,
            retranslations,
          });
          request.onEvent?.({
            type: 'notice',
            message: '模型 ' + from.fullName + ' 暂不可用（' + reason + '），已切换至 ' + to.fullName + '。',
          });
        },
        onIteration: iterations,
      });

      planIndex = turn.planIndex;
      plan = this.planAt(chain, planIndex);
      usage = addUsage(usage, turn.outcome.usage);
      if (turn.outcome.usage.totalTokens > 0) {
        request.onUsage?.({
          providerId: plan.providerId,
          model: plan.fullName,
          usage: turn.outcome.usage,
          source: 'model_turn',
        });
        request.onEvent?.({ type: 'usage', usage: turn.outcome.usage });
        request.onTrace?.({
          kind: 'usage',
          at: new Date().toISOString(),
          providerId: plan.providerId,
          model: plan.fullName,
          usage: turn.outcome.usage,
        });
      }

      const outcome = turn.outcome;
      finishReason = outcome.finishReason;
      if (outcome.reasoning !== '') {
        finalReasoning += outcome.reasoning;
        if (agent.reasoningVisible) request.onEvent?.({ type: 'reasoning', text: outcome.reasoning });
      }

      const assistant: AgentMessage = {
        role: 'assistant',
        content: outcome.text,
        createdAt: new Date().toISOString(),
      };
      if (outcome.reasoning !== '') assistant.reasoning = outcome.reasoning;
      if (outcome.calls.length > 0) assistant.toolCalls = outcome.calls;
      history.push(assistant);
      produced.push(assistant);

      if (outcome.calls.length === 0) {
        finalText = outcome.text;
        if (outcome.text !== '') request.onEvent?.({ type: 'text', text: outcome.text });
        stopReason = 'stop';
        break;
      }

      // 有工具调用时的正文是过程性说明（"我先看一下文件"），也要透传给用户，
      // 否则长任务期间用户会面对长时间静默
      if (outcome.text !== '') request.onEvent?.({ type: 'text', text: outcome.text });

      const results = await this.runTools(request, executor, outcome, definitions);
      for (const result of results) {
        const message: AgentMessage = {
          role: 'tool',
          content: result.content,
          toolResult: result,
          createdAt: new Date().toISOString(),
        };
        history.push(message);
        produced.push(message);
      }
      finalText = outcome.text;
    }

    if (iterations >= agent.limits.maxIterations && stopReason === 'stop' && finalText === '') {
      stopReason = 'max_iterations';
    }
    if (iterations >= agent.limits.maxIterations && this.lastHadCalls(produced)) {
      stopReason = 'max_iterations';
    }

    if (stopReason === 'max_iterations') {
      const notice = '已达到单任务工具调用轮数上限（' + agent.limits.maxIterations
        + ' 轮），任务在此终止。以下是已获得的中间结论。';
      request.onEvent?.({ type: 'notice', message: notice });
      if (finalText === '') finalText = this.summarizeIntermediate(produced);
    }

    return {
      text: finalText,
      reasoning: finalReasoning,
      messages: produced,
      usage,
      iterations,
      model: plan.fullName,
      protocol: plan.protocol,
      finishReason,
      stopReason,
      retranslations,
    };
  }

  /** 最后一条产出消息是否仍带未收尾的工具调用。 */
  private lastHadCalls(produced: readonly AgentMessage[]): boolean {
    for (let index = produced.length - 1; index >= 0; index -= 1) {
      const message = produced[index];
      if (message === undefined) continue;
      if (message.role === 'assistant') return (message.toolCalls ?? []).length > 0;
    }
    return false;
  }

  /** 迭代上限时把已有产出拼成中间结论，避免用户只收到一句"超限"（FR-LOOP-010）。 */
  private summarizeIntermediate(produced: readonly AgentMessage[]): string {
    const texts: string[] = [];
    const actions: string[] = [];
    for (const message of produced) {
      if (message.role === 'assistant' && message.content.trim() !== '') texts.push(message.content.trim());
      if (message.role === 'tool' && message.toolResult !== undefined) {
        const result = message.toolResult;
        actions.push('- ' + result.name + (result.isError ? '（失败）' : '（成功）'));
      }
    }
    const parts: string[] = [];
    if (texts.length > 0) parts.push(texts.slice(-3).join('\n\n'));
    if (actions.length > 0) parts.push('本次已执行的工具调用：\n' + actions.slice(-12).join('\n'));
    return parts.length > 0 ? parts.join('\n\n') : '本次未产生可用的中间结论。';
  }

  private planAt(chain: readonly ModelPlan[], index: number): ModelPlan {
    const plan = chain[index];
    if (plan === undefined) {
      throw new FatalError('MODEL_NOT_FOUND', '模型候选链下标越界：' + index, {
        context: { size: chain.length },
      });
    }
    return plan;
  }

  private throwIfAborted(request: LoopRequest): void {
    if (!request.signal.aborted) return;
    throw new FatalError('TASK_ABORTED', '任务已被取消', {
      userMessage: '任务已中止。',
      context: { taskId: request.taskId },
    });
  }

  private emitProtocolTrace(request: LoopRequest, plan: ModelPlan): void {
    request.onTrace?.({
      kind: 'protocol',
      at: new Date().toISOString(),
      protocol: plan.protocol,
      source: plan.protocolSource,
      model: plan.fullName,
    });
  }

  /** 保证历史能装进当前模型的上下文窗口，必要时压缩（FR-LOOP-013/014）。 */
  private async ensureContextFits(
    request: LoopRequest,
    plan: ModelPlan,
    history: AgentMessage[],
    _usage: TokenUsage,
    addExtraUsage: (usage: TokenUsage) => void,
  ): Promise<AgentMessage[]> {
    const decision = shouldCompact(
      history,
      request.systemPrompt,
      plan.contextWindow,
      request.agent.limits.compactThreshold,
    );
    if (!decision.needed) return history;

    const utility = planUtilityModel(this.deps.resolver, request.agent);
    request.onEvent?.({
      type: 'notice',
      message: '会话上下文已达 ' + decision.estimated + ' token（阈值 ' + decision.threshold
        + '），正在用 ' + utility.fullName + ' 压缩历史。',
    });

    const compacted = await compactHistory(history, request.systemPrompt, {
      registry: this.deps.providers,
      utility,
      signal: request.signal,
    });
    addExtraUsage(compacted.usage);
    request.onTrace?.({
      kind: 'note',
      at: new Date().toISOString(),
      message: '上下文压缩完成',
      data: {
        before: decision.estimated,
        after: compacted.estimated,
        compactedMessages: compacted.compacted,
        utilityModel: utility.fullName,
      },
    });
    assertFitsContext(compacted.estimated, plan.contextWindow, plan.fullName);
    return compacted.history;
  }

  /** 执行一轮里的全部工具调用，并把参数非法的调用直接短路回灌。 */
  private async runTools(
    request: LoopRequest,
    executor: ToolExecutor,
    outcome: TurnOutcome,
    definitions: readonly ToolDefinition[],
  ): Promise<ToolResult[]> {
    const ctx: ToolContext = {
      agent: request.agent,
      paths: request.paths,
      taskId: request.taskId,
      signal: request.signal,
      depth: request.depth,
      env: request.env,
    };
    if (request.spawn !== undefined) ctx.spawn = request.spawn;
    if (request.onTrace !== undefined) ctx.onTrace = request.onTrace;
    if (request.executionContext !== undefined) {
      ctx.executionContext = request.executionContext;
      if (request.executionContext.control !== undefined) ctx.control = request.executionContext.control;
    }

    const results: ToolResult[] = [];
    for (const call of outcome.calls) {
      this.throwIfAborted(request);
      const argError = outcome.argErrors.get(call.id);
      if (argError !== undefined) {
        const failed = argErrorResult(call, argError, definitions);
        request.onEvent?.({ type: 'tool_start', name: call.name, args: call.args });
        request.onEvent?.({ type: 'tool_end', result: failed });
        request.onTrace?.({
          kind: 'tool',
          at: new Date().toISOString(),
          name: call.name,
          argsDigest: '(arguments 解析失败)',
          durationMs: 0,
          isError: true,
          truncated: false,
        });
        results.push(failed);
        continue;
      }
      request.onEvent?.({ type: 'tool_start', name: call.name, args: call.args });
      const result = await executor.execute(call, ctx);
      request.onEvent?.({ type: 'tool_end', result });
      results.push(result);
    }
    return results;
  }

  /**
   * 发一轮请求，失败时沿降级链继续（FR-ROUTE-004/005、FR-LOOP-015）。
   *
   * 每次切换模型都重新 buildRequest：请求体从内部历史抽象重新序列化，
   * 而不是修改上一协议的请求体，这样 anthropic → openai-tools 这种
   * 跨线制降级也能把已完成的工具调用与结果正确带过去。
   */
  private async requestTurn(
    request: LoopRequest,
    chain: readonly ModelPlan[],
    startIndex: number,
    history: readonly AgentMessage[],
    definitions: readonly ToolDefinition[],
    hooks: {
      onSwitch: (from: ModelPlan, to: ModelPlan, reason: string) => void;
      onIteration: number;
    },
  ): Promise<{ outcome: TurnOutcome; planIndex: number }> {
    const failures: string[] = [];

    for (let index = startIndex; index < chain.length; index += 1) {
      this.throwIfAborted(request);
      const plan = this.planAt(chain, index);
      if (index > startIndex) {
        const previous = this.planAt(chain, index - 1);
        hooks.onSwitch(previous, plan, failures[failures.length - 1] ?? '未知原因');
        this.emitProtocolTrace(request, plan);
      }

      const adapter = protocolAdapter(plan.protocol);
      const wireRequest = adapter.buildRequest(history, {
        wireApi: plan.provider.wireApi,
        model: plan.model,
        systemPrompt: request.systemPrompt,
        tools: definitions,
        params: plan.params,
        maxTokens: plan.maxTokens,
      });

      const startedAt = Date.now();
      try {
        const client = this.deps.providers.client(plan.providerId);
        const parser = adapter.createParser();
        const events: ProtocolEvent[] = [];
        for await (const wire of client.send(wireRequest, request.signal)) {
          events.push(...parser.push(wire));
        }
        events.push(...parser.end());
        const outcome = foldTurn(events);
        const durationMs = Date.now() - startedAt;

        const trace: TraceEvent = {
          kind: 'request',
          at: new Date().toISOString(),
          providerId: plan.providerId,
          model: plan.fullName,
          protocol: plan.protocol,
          iteration: hooks.onIteration,
          durationMs,
        };
        if (outcome.usage.totalTokens > 0) trace.usage = outcome.usage;
        request.onTrace?.(trace);

        // 未闭合标签意味着这段输出不可信：其中的工具调用一律不执行，
        // 按 FR-LOOP-007 交给降级链重试本轮
        if (outcome.incomplete.length > 0) {
          throw new RecoverableError('TAG_UNCLOSED', '流结束时存在未闭合协议标签：' + outcome.incomplete.join('、'), {
            context: { model: plan.fullName, tags: outcome.incomplete },
          });
        }
        // 空响应同样视为本轮失败：没有正文也没有工具调用，继续循环只会空转
        if (outcome.text === '' && outcome.calls.length === 0 && outcome.finishReason !== 'length') {
          throw new RecoverableError('PROVIDER_STREAM_IDLE', '模型返回空响应', {
            context: { model: plan.fullName },
          });
        }

        return { outcome, planIndex: index };
      } catch (error) {
        this.throwIfAborted(request);
        const reason = describeError(error);
        failures.push(reason);
        request.onTrace?.({
          kind: 'note',
          at: new Date().toISOString(),
          message: '模型 ' + plan.fullName + ' 本轮请求失败：' + reason,
          data: { model: plan.fullName, iteration: hooks.onIteration, retryable: isRetryable(error) },
        });
        if (index === chain.length - 1) {
          throw new FatalError('FALLBACK_EXHAUSTED', '降级链全部失败：' + failures.join(' | '), {
            userMessage: '本次任务失败：已尝试模型 '
              + chain.slice(startIndex).map((item) => item.fullName).join('、')
              + ' 均未成功。最后一次失败原因：' + reason
              + '。请稍后重试，或用 hap provider check 检查提供商可用性。',
            context: { failures, models: chain.map((item) => item.fullName) },
            cause: error,
          });
        }
      }
    }

    throw new FatalError('FALLBACK_EXHAUSTED', '降级链为空', { context: { failures } });
  }
}

/** 便捷入口：一次性构造循环并执行，供 CLI 单次调用使用。 */
export async function runAgentLoop(deps: AgentLoopDeps, request: LoopRequest): Promise<LoopResult> {
  return new AgentLoop(deps).run(request);
}

/** 事件流转文本，供不需要流式的调用方（如子智能体）复用。 */
export function textOfTaskEvents(events: readonly TaskEvent[]): string {
  return events
    .filter((event): event is { type: 'text'; text: string } => event.type === 'text')
    .map((event) => event.text)
    .join('');
}
