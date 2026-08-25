/**
 * 通道装配与生命周期管理（FR-CHAN-002、FR-TASK-008）。
 *
 * 负责三件事：
 * 1) 把 AgentOrchestrator 包成 ChannelHost，让通道层不直接依赖编排实现；
 * 2) 按配置启用通道，polling/webhook 这类互斥项在通道构造期就报错，不留半启动状态；
 * 3) 启动期把上次进程残留的 running 任务标记为 interrupted，并向对应会话推送中断通知。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { TelegramChannel } from './telegram.js';
import { HttpChannel } from './http.js';
import { CliChannel } from './cli.js';
import { describeError } from './dispatcher.js';
import type { Channel, ChannelHost } from './types.js';
import type { AgentOrchestrator } from '../agent/index.js';

export interface ChannelManagerOptions {
  orchestrator: AgentOrchestrator;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** 是否附带启动交互式 CLI（serve 命令默认不启） */
  includeCli?: boolean;
}

/**
 * 把编排层包成通道宿主。
 *
 * clearSession 需要先确定会话归属的智能体才能拿到对应 SessionStore，
 * 因此这里复用 status() 的路由结果，避免通道层自己再实现一次路由。
 */
export function createChannelHost(orchestrator: AgentOrchestrator): ChannelHost {
  return {
    runTask: (request) => orchestrator.runTask(request),
    abortSession: (sessionKey) => orchestrator.abortSession(sessionKey),
    status: (sessionKey, channelDefaultAgent) => orchestrator.status(sessionKey, channelDefaultAgent),
    trace: (taskId) => orchestrator.trace(taskId),
    agentIds: () => orchestrator.agents.agentIds(),
    clearSession: (sessionKey, channelDefaultAgent) => {
      const status = orchestrator.status(sessionKey, channelDefaultAgent);
      orchestrator.store(status.agentId).clearSession(sessionKey);
    },
    usageSince: (since) => orchestrator.usageSince(since),
  };
}

/** 通道管理器。 */
export class ChannelManager {
  private readonly orchestrator: AgentOrchestrator;
  private readonly host: ChannelHost;
  private readonly env: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly includeCli: boolean;
  private readonly channels: Channel[] = [];
  private telegram: TelegramChannel | undefined;

  constructor(options: ChannelManagerOptions) {
    this.orchestrator = options.orchestrator;
    this.host = createChannelHost(options.orchestrator);
    this.env = options.env ?? process.env;
    this.log = options.log ?? (() => undefined);
    this.includeCli = options.includeCli ?? false;
  }

  /** 已启用的通道名列表。 */
  enabled(): string[] {
    return this.channels.map((channel) => channel.name);
  }

  /**
   * 装配并启动全部启用的通道。
   *
   * 任一通道构造失败即整体失败：配置写错了 token 环境变量却「静默少启一个通道」
   * 会让用户以为手机端已经能用，排查成本远高于直接报错。
   */
  async start(): Promise<void> {
    const resolver = this.orchestrator.config;
    const channels = resolver.resolveChannels();
    const limits = resolver.resolveLimits();
    const paths = this.orchestrator.resolvedPaths;

    if (channels.telegram.enabled) {
      const telegram = new TelegramChannel({
        host: this.host,
        channels,
        limits,
        paths,
        env: this.env,
        log: this.log,
      });
      this.telegram = telegram;
      this.channels.push(telegram);
    }
    if (channels.http.enabled) {
      this.channels.push(new HttpChannel({ host: this.host, channels, limits, paths, log: this.log }));
    }
    if (this.includeCli && channels.cli.enabled) {
      this.channels.push(new CliChannel({ host: this.host, channels, limits, paths }));
    }
    if (this.channels.length === 0) {
      this.log('没有启用任何通道，仅编排层在运行。');
    }
    for (const channel of this.channels) {
      await channel.start();
    }
    this.notifyInterrupted();
  }

  async stop(): Promise<void> {
    for (const channel of [...this.channels].reverse()) {
      try {
        await channel.stop();
      } catch (error) {
        this.log('通道 ' + channel.name + ' 停止时出错：' + describeError(error));
      }
    }
    this.channels.length = 0;
    this.telegram = undefined;
  }

  /**
   * 处理上次进程留下的未完成任务。
   *
   * 只通知、不自动重跑：任务可能已经改过文件，盲目重放会造成重复副作用。
   */
  private notifyInterrupted(): void {
    const rows = this.orchestrator.recoverInterrupted();
    if (rows.length === 0) {
      return;
    }
    this.log('检测到 ' + String(rows.length) + ' 个上次未完成的任务，已标记为中断。');
    for (const row of rows) {
      const text =
        '⚠ 上次运行中断：任务 ' +
        row.taskId.slice(0, 8) +
        '（' +
        row.agentId +
        '）在进程退出时仍在执行，已标记为中断。' +
        '如需继续请重新下发指令。';
      if (row.sessionKey.startsWith('chat:') && this.telegram !== undefined) {
        void this.telegram.notify(row.sessionKey.slice('chat:'.length), text);
        continue;
      }
      this.log(text);
    }
  }
}
