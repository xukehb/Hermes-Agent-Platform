/**
 * 工具执行器（FR-TOOL-005/007、FR-LOOP-009）。
 *
 * 核心原则：除任务取消以外，任何工具层问题都不抛出，而是以 isError 结果回灌给模型。
 * 工具找不到、参数不合法、执行报错、执行超时——模型都有机会自行纠正并重试，
 * 一抛异常就等于让整轮对话前功尽弃。真正需要终止的只有用户主动取消（TASK_ABORTED）。
 *
 * 超时用独立 AbortController 叠加任务 signal，并用 Promise.race 兜底：
 * 有些工具实现（尤其是 MCP 服务器）不理 signal，光 abort 不足以让 await 返回。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { HapError, FatalError, describeError, digestArgs } from '../domain/index.js';
import type { ToolCall, ToolResult, TraceEvent } from '../domain/index.js';
import { truncateToolOutput } from './output.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolModule, ToolOutput } from './types.js';

export interface ToolExecutorOptions {
  /** 覆盖 agent.limits.toolTimeoutMs，仅测试与 CLI 单次调用使用 */
  timeoutMs?: number;
  /** 覆盖 agent.limits.toolOutputMaxBytes */
  maxOutputBytes?: number;
}

/** 内部哨兵：controller abort 时用它中断 race，不会外泄给调用方。 */
class ToolInterrupted extends Error {
  constructor() {
    super('tool interrupted');
    this.name = 'ToolInterrupted';
  }
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly options: ToolExecutorOptions;

  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.registry = registry;
    this.options = options;
  }

  /** 顺序执行一轮里的全部工具调用。顺序而非并发，因为工具间常有写读依赖。 */
  async executeAll(calls: readonly ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      results.push(await this.execute(call, ctx));
    }
    return results;
  }

  /** 执行单个工具调用，产出可直接进历史的 ToolResult。 */
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) {
      throw new FatalError('TASK_ABORTED', '任务已取消，工具 ' + call.name + ' 未执行', {
        context: { taskId: ctx.taskId, tool: call.name },
      });
    }
    const startedAt = Date.now();

    const module = this.lookup(call.name, ctx);
    if (module === undefined) {
      return this.finish(call, ctx, { content: this.notFoundMessage(call.name, ctx), isError: true }, startedAt);
    }

    const validated = module.validate === undefined
      ? { ok: true as const, args: call.args }
      : module.validate(call.args);
    if (!validated.ok) {
      return this.finish(call, ctx, { content: this.invalidArgsMessage(module, validated.issues), isError: true }, startedAt);
    }

    const output = await this.runGuarded(module, validated.args, ctx, call);
    return this.finish(call, ctx, output, startedAt);
  }

  /** 只在智能体可见范围内查找：被 deny 掉的工具等同于不存在。 */
  private lookup(name: string, ctx: ToolContext): ToolModule | undefined {
    if (!this.registry.namesFor(ctx.agent).includes(name)) return undefined;
    return this.registry.get(name);
  }

  private notFoundMessage(name: string, ctx: ToolContext): string {
    const available = this.registry.namesFor(ctx.agent);
    const list = available.length > 0 ? available.join('、') : '（当前没有可用工具）';
    return '未找到工具 ' + name + '。可用工具：' + list + '。请改用可用工具，或直接给出最终答复。';
  }

  private invalidArgsMessage(module: ToolModule, issues: readonly string[]): string {
    const lines = issues.map((issue) => '- ' + issue).join('\n');
    return '工具 ' + module.definition.name + ' 的参数校验失败：\n' + lines
      + '\n该工具的参数结构（JSON Schema）：\n'
      + JSON.stringify(module.definition.parameters, null, 2)
      + '\n请按上述结构修正参数后重新调用。';
  }

  /** 带超时与取消保护地执行 handler，把异常收敛成 isError 输出。 */
  private async runGuarded(
    module: ToolModule,
    args: Record<string, unknown>,
    ctx: ToolContext,
    call: ToolCall,
  ): Promise<ToolOutput> {
    const timeoutMs = this.options.timeoutMs ?? ctx.agent.limits.toolTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const onParentAbort = (): void => {
      controller.abort();
    };
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const childCtx: ToolContext = { ...ctx, signal: controller.signal };
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new ToolInterrupted());
      }, { once: true });
    });
    // race 只取先到者，落败的一方仍会 reject，必须先接住避免未处理拒绝告警
    interrupted.catch(() => undefined);

    try {
      const running = module.handler(args, childCtx);
      running.catch(() => undefined);
      return await Promise.race([running, interrupted]);
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new FatalError('TASK_ABORTED', '任务已取消：工具 ' + call.name + ' 执行中断', {
          context: { taskId: ctx.taskId, tool: call.name },
        });
      }
      if (timedOut) {
        return {
          content: '工具 ' + call.name + ' 执行超时（上限 ' + timeoutMs + 'ms），已终止。'
            + '请缩小处理范围（例如限定目录、减少行数）或拆成多次调用后重试。',
          isError: true,
        };
      }
      const code = error instanceof HapError ? error.code : 'TOOL_FAILED';
      return { content: '工具执行失败（' + code + '）：' + describeError(error), isError: true };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParentAbort);
    }
  }

  /** 统一收尾：裁剪输出、落 overflow、发 trace、组装 ToolResult。 */
  private async finish(
    call: ToolCall,
    ctx: ToolContext,
    output: ToolOutput,
    startedAt: number,
  ): Promise<ToolResult> {
    const truncated = await truncateToolOutput(output.content, {
      maxBytes: this.options.maxOutputBytes ?? ctx.agent.limits.toolOutputMaxBytes,
      overflowDir: ctx.paths.overflowDir,
      taskId: ctx.taskId,
      callId: call.id,
      toolName: call.name,
    });
    const durationMs = Date.now() - startedAt;

    const result: ToolResult = {
      callId: call.id,
      name: call.name,
      content: truncated.content,
      isError: output.isError === true,
      durationMs,
    };
    if (truncated.overflowPath !== undefined) result.overflowPath = truncated.overflowPath;

    const event: TraceEvent = {
      kind: 'tool',
      at: new Date().toISOString(),
      name: call.name,
      argsDigest: digestArgs(call.args),
      durationMs,
      isError: result.isError,
      truncated: truncated.truncated,
    };
    ctx.onTrace?.(event);

    return result;
  }
}
