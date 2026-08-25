/**
 * 通道通用调度器（FR-CHAN-002~013）。
 *
 * 三个通道的差异只在「怎么收消息、怎么回消息」，而
 * 命令分派、串行队列、流式节流刷新、异步卡片、错误兜底这些逻辑完全一致。
 * 因此把共性抽到这里：通道自己只负责把平台消息归一成 InboundMessage 交给 dispatch。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { SessionQueue } from './queue.js';
import { OutboundSender } from './outbound.js';
import { TaskRenderer } from './normalizer.js';
import { parseCommand, type ChannelCommand } from './command-parser.js';
import type { ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { SessionStatus, TaskEvent, TaskOutcome, TraceSummary } from '../agent/index.js';
import { HapError } from '../domain/index.js';

/** 调度器配置。 */
export interface DispatcherOptions {
  host: ChannelHost;
  sender: OutboundSender;
  /** 平台单条消息字符上限；<=0 表示不限 */
  messageCharLimit: number;
  /** 流式回写节流间隔（FR-CHAN-015） */
  editIntervalMs: number;
  /** 超过该时长仍未结束则转异步卡片（FR-CHAN-008） */
  asyncThresholdMs: number;
  /** 入站队列容量（FR-CHAN-013） */
  queueCapacity: number;
  /** 是否展示推理段，缺省 false */
  reasoningVisible?: boolean;
}

/** 命令帮助文案，/help 与未知命令共用。 */
export const HELP_TEXT = [
  '可用指令：',
  '/agents 列出全部智能体',
  '/agent <id> 查看某个智能体的模型与工具集',
  '/status 查看当前会话状态与今日用量',
  '/trace [任务id] 查看任务执行轨迹',
  '/usage [天数] 查看用量聚合（默认 7 天）',
  '/stop 中止当前会话正在跑的任务',
  '/new 清空当前会话历史',
  '/help 显示本帮助',
  '',
  '直接发消息即为下发任务；用 @<智能体id> 开头可指定执行者。',
].join('\n');

/**
 * 通用调度器。
 *
 * 内部持有一条 SessionQueue，保证同一会话串行；不同会话并行。
 */
export class ChannelDispatcher {
  private readonly options: DispatcherOptions;
  private readonly queue: SessionQueue<InboundMessage>;

  constructor(options: DispatcherOptions) {
    this.options = options;
    this.queue = new SessionQueue<InboundMessage>({
      capacity: options.queueCapacity,
      handler: (message) => this.handle(message),
      onDrop: (message) => {
        void this.reply(message.target, '⚠ 队列已满，最早的一条待处理指令被丢弃。');
      },
      onError: (message, error) => {
        void this.reply(message.target, '✗ 处理失败：' + describeError(error));
      },
    });
  }

  /** 入队一条入站消息，立即返回。 */
  submit(message: InboundMessage): void {
    this.queue.enqueue(message.sessionKey, message);
  }

  /** 等待队列排空，供优雅停机与测试使用。 */
  async drain(): Promise<void> {
    await this.queue.drain();
  }

  /** 同步执行一条入站消息（HTTP 同步接口与测试使用）。 */
  async handle(message: InboundMessage): Promise<void> {
    const command = parseCommand(message.text);
    if (command.kind === 'prompt') {
      if (command.text.length === 0 && (message.attachments === undefined || message.attachments.length === 0)) {
        await this.reply(message.target, HELP_TEXT);
        return;
      }
      await this.runPrompt(message, command.text);
      return;
    }
    await this.runCommand(message, command);
  }

  /** 分派非 prompt 命令。 */
  private async runCommand(message: InboundMessage, command: ChannelCommand): Promise<void> {
    switch (command.kind) {
      case 'help':
        await this.reply(message.target, HELP_TEXT);
        return;
      case 'stop': {
        const aborted = this.options.host.abortSession(message.sessionKey);
        await this.reply(
          message.target,
          aborted.length === 0
            ? '当前会话没有正在执行的任务。'
            : '已中止 ' + String(aborted.length) + ' 个任务：' + aborted.join('、'),
        );
        return;
      }
      case 'new':
        this.options.host.clearSession(message.sessionKey, message.defaultAgent);
        await this.reply(message.target, '已清空当前会话历史，下一条消息将开启新上下文。');
        return;
      case 'status': {
        const status = this.options.host.status(message.sessionKey, message.defaultAgent);
        await this.reply(message.target, renderStatus(status));
        return;
      }
      case 'agents': {
        const ids = this.options.host.agentIds();
        await this.reply(
          message.target,
          ids.length === 0 ? '尚未配置任何智能体。' : '已配置智能体：\n' + ids.map((id) => '· ' + id).join('\n'),
        );
        return;
      }
      case 'agent': {
        if (command.agentId === undefined) {
          const status = this.options.host.status(message.sessionKey, message.defaultAgent);
          await this.reply(message.target, renderStatus(status));
          return;
        }
        const status = this.options.host.status(message.sessionKey, command.agentId);
        await this.reply(message.target, renderStatus(status));
        return;
      }
      case 'trace': {
        const taskId = command.taskId ?? latestTaskId(this.options.host.status(message.sessionKey, message.defaultAgent));
        if (taskId === undefined) {
          await this.reply(message.target, '当前会话还没有任务记录。');
          return;
        }
        const summary = this.options.host.trace(taskId);
        await this.reply(message.target, summary === undefined ? '找不到任务 ' + taskId + '。' : renderTrace(summary));
        return;
      }
      case 'usage': {
        const since = new Date(Date.now() - command.days * 86_400_000).toISOString();
        const rows = this.options.host.usageSince(since);
        await this.reply(message.target, renderUsage(rows, command.days));
        return;
      }
      case 'unknown':
        await this.reply(message.target, '未知指令 /' + command.name + '。\n\n' + HELP_TEXT);
        return;
      default:
        await this.reply(message.target, HELP_TEXT);
    }
  }

  /**
   * 执行一次任务并把进度流式回写。
   *
   * 三段式：先占位消息 → 节流编辑刷新进度 → 终态整条替换（超长则分片补发）。
   * 若通道不支持 edit，则退化为「只在终态发一条」，避免刷屏。
   */
  private async runPrompt(message: InboundMessage, prompt: string): Promise<void> {
    const header = (message.agentId ?? message.defaultAgent ?? 'hap') + ' 正在处理';
    const renderer = new TaskRenderer({
      header: '⚙ ' + header,
      reasoningVisible: this.options.reasoningVisible ?? false,
    });
    const canEdit = typeof message.target.edit === 'function';
    let placeholderId: string | undefined;
    if (canEdit) {
      placeholderId = await this.sendSafely(message.target, '⚙ ' + header + '…');
    }
    let lastEditAt = 0;
    let asyncNoticeSent = false;
    const startedAt = Date.now();

    const flush = async (force: boolean): Promise<void> => {
      if (placeholderId === undefined || message.target.edit === undefined) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastEditAt < this.options.editIntervalMs) {
        return;
      }
      if (!renderer.hasChanges) {
        return;
      }
      lastEditAt = now;
      const view = renderer.progress();
      try {
        await message.target.edit(placeholderId, clampForChannel(view, this.options.messageCharLimit));
      } catch {
        // 编辑失败不影响任务本身：终态还会整条重发，这里静默即可
      }
    };

    let pendingFlush: Promise<void> = Promise.resolve();
    const onEvent = (event: TaskEvent): void => {
      const changed = renderer.push(event);
      if (!changed) {
        return;
      }
      if (
        !asyncNoticeSent &&
        this.options.asyncThresholdMs > 0 &&
        Date.now() - startedAt > this.options.asyncThresholdMs
      ) {
        asyncNoticeSent = true;
        renderer.push({
          type: 'notice',
          message: '任务耗时较长，已转为后台执行，完成后会继续在此回复。',
        });
      }
      pendingFlush = pendingFlush.then(() => flush(false));
    };

    const request: Parameters<ChannelHost['runTask']>[0] = {
      input: prompt,
      sessionKey: message.sessionKey,
      onEvent,
    };
    if (message.agentId !== undefined) {
      request.agentId = message.agentId;
    }
    if (message.defaultAgent !== undefined) {
      request.channelDefaultAgent = message.defaultAgent;
    }
    if (message.attachments !== undefined && message.attachments.length > 0) {
      request.attachments = message.attachments;
    }

    let outcome: TaskOutcome | undefined;
    let failure: unknown;
    try {
      outcome = await this.options.host.runTask(request);
    } catch (error) {
      failure = error;
    }
    await pendingFlush;

    const finalText =
      outcome !== undefined
        ? renderer.final(terminalNote(outcome))
        : renderer.final('✗ 任务失败：' + describeError(failure));

    if (placeholderId !== undefined && message.target.edit !== undefined) {
      const chunks = splitFinal(finalText, this.options.messageCharLimit);
      const head = chunks[0] ?? finalText;
      try {
        await message.target.edit(placeholderId, head);
      } catch {
        await this.sendSafely(message.target, head);
      }
      for (const extra of chunks.slice(1)) {
        await this.sendSafely(message.target, extra);
      }
      return;
    }
    await this.reply(message.target, finalText);
  }

  /** 分片发送，失败时落入重投缓冲而不打断流程。 */
  private async reply(target: OutboundTarget, text: string): Promise<void> {
    try {
      await this.options.sender.send(target, text, this.options.messageCharLimit);
    } catch {
      // send 内部已把剩余文本落盘，这里不再重复处理
    }
  }

  private async sendSafely(target: OutboundTarget, text: string): Promise<string | undefined> {
    try {
      return await this.options.sender.send(target, text, this.options.messageCharLimit);
    } catch {
      return undefined;
    }
  }
}

/** 终态提示：只有非正常收尾才需要提示用户。 */
function terminalNote(outcome: TaskOutcome): string | undefined {
  if (outcome.status === 'aborted') {
    return '⏹ 任务已中止。';
  }
  if (outcome.status === 'failed') {
    return '✗ 任务失败：' + (outcome.error ?? '未知原因');
  }
  if (outcome.stopReason === 'max_iterations') {
    return '⚠ 已达工具调用轮数上限（' + String(outcome.iterations) + ' 轮），输出可能不完整。';
  }
  if (outcome.stopReason === 'fallback_exhausted') {
    return '⚠ 所有备用模型均不可用，输出可能不完整。';
  }
  const total = outcome.usage.totalTokens;
  return total > 0 ? '· ' + outcome.model + ' · ' + String(total) + ' tokens · ' + outcome.taskId.slice(0, 8) : undefined;
}

/** 把终态文本切成适配平台的片段。 */
function splitFinal(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = window.lastIndexOf('\n') > limit * 0.4 ? window.lastIndexOf('\n') : limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

function clampForChannel(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - 1) + '…';
}

/** 会话状态视图。 */
export function renderStatus(status: SessionStatus): string {
  const lines: string[] = [
    '会话 ' + status.sessionKey,
    '智能体 ' + status.agentId,
    '模型 ' + status.model,
  ];
  if (status.chain.length > 1) {
    lines.push('降级链 ' + status.chain.join(' → '));
  }
  lines.push(
    '今日用量 ' +
      String(status.todayTokens) +
      (status.dailyTokenBudget > 0 ? ' / ' + String(status.dailyTokenBudget) : ' / 不限') +
      ' tokens',
  );
  if (status.running.length > 0) {
    lines.push('');
    lines.push('正在执行：');
    for (const row of status.running) {
      lines.push('· ' + row.taskId.slice(0, 8) + ' 起于 ' + row.startedAt);
    }
  }
  if (status.recent.length > 0) {
    lines.push('');
    lines.push('最近任务：');
    for (const row of status.recent.slice(0, 5)) {
      lines.push(
        '· ' +
          row.taskId.slice(0, 8) +
          ' [' +
          row.status +
          '] ' +
          String(row.usage.totalTokens) +
          ' tokens ' +
          (row.title ?? ''),
      );
    }
  }
  return lines.join('\n');
}

/** trace 摘要视图。 */
export function renderTrace(summary: TraceSummary): string {
  const lines: string[] = [
    '任务 ' + summary.taskId,
    '状态 ' + summary.status,
    '模型 ' + (summary.models.length === 0 ? '未记录' : summary.models.join(' → ')),
  ];
  if (summary.route !== undefined) {
    lines.push('路由 ' + summary.route);
  }
  if (summary.protocol !== undefined) {
    lines.push('协议 ' + summary.protocol);
  }
  lines.push('迭代 ' + String(summary.iterations) + ' 轮 · ' + String(summary.usage.totalTokens) + ' tokens');
  if (summary.switches.length > 0) {
    lines.push('');
    lines.push('降级：');
    for (const item of summary.switches) {
      lines.push('· ' + item.from + ' → ' + item.to + '（' + item.reason + '）');
    }
  }
  if (summary.tools.length > 0) {
    lines.push('');
    lines.push('工具调用：');
    for (const item of summary.tools.slice(0, 12)) {
      lines.push('· ' + (item.isError ? '✗' : '✓') + ' ' + item.name + ' ' + String(item.durationMs) + 'ms');
    }
    if (summary.tools.length > 12) {
      lines.push('… 其余 ' + String(summary.tools.length - 12) + ' 条见 ' + summary.filePath);
    }
  }
  if (summary.error !== undefined) {
    lines.push('');
    lines.push('错误 ' + summary.error);
  }
  lines.push('');
  lines.push('完整轨迹 ' + summary.filePath);
  return lines.join('\n');
}

/** 用量聚合视图。 */
export function renderUsage(rows: readonly { agentId: string; providerId: string; model: string; totalTokens: number; calls: number }[], days: number): string {
  if (rows.length === 0) {
    return '最近 ' + String(days) + ' 天没有用量记录。';
  }
  const lines: string[] = ['最近 ' + String(days) + ' 天用量：'];
  let total = 0;
  for (const row of rows) {
    total += row.totalTokens;
    lines.push(
      '· ' + row.agentId + ' · ' + row.providerId + '/' + row.model + ' · ' + String(row.totalTokens) + ' tokens · ' + String(row.calls) + ' 次',
    );
  }
  lines.push('');
  lines.push('合计 ' + String(total) + ' tokens');
  return lines.join('\n');
}

/** 会话里最近一个任务 id，供无参数的 /trace 使用。 */
function latestTaskId(status: SessionStatus): string | undefined {
  return status.running[0]?.taskId ?? status.recent[0]?.taskId;
}

/** 统一错误文案：HapError 用 userMessage，其余退回 message。 */
export function describeError(error: unknown): string {
  if (error instanceof HapError) {
    return error.userMessage ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
