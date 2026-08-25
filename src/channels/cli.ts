/**
 * CLI 交互通道（FR-CHAN-009/010）。
 *
 * 用 node:readline 提供 REPL：与 Telegram 共用同一套命令解析与调度器，
 * 因此本地调试看到的行为就是手机端的行为，不存在两套语义。
 * 终端支持就地重绘，所以进度直接用 process.stdout.write 增量输出，
 * 不走 edit 通路（edit 语义留给 Telegram 这类不能追加的平台）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { createInterface, type Interface } from 'node:readline';

import { ChannelDispatcher, describeError } from './dispatcher.js';
import { OutboundSender } from './outbound.js';
import { extractMention } from './command-parser.js';
import type { Channel, ChannelHost, InboundMessage, OutboundTarget } from './types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../config/index.js';

export interface CliChannelOptions {
  host: ChannelHost;
  channels: ResolvedChannels;
  limits: ResolvedLimits;
  paths: ResolvedPaths;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * 终端 REPL 通道。
 *
 * 会话键固定为 cli:<默认智能体>，这样 CLI 与 Telegram 的历史天然隔离，
 * 本地试错不会污染手机端正在进行的对话。
 */
export class CliChannel implements Channel {
  readonly name = 'cli' as const;

  private readonly options: CliChannelOptions;
  private readonly dispatcher: ChannelDispatcher;
  private readonly out: NodeJS.WritableStream;
  private rl: Interface | undefined;
  private stopped = false;

  constructor(options: CliChannelOptions) {
    this.options = options;
    this.out = options.output ?? process.stdout;
    this.dispatcher = new ChannelDispatcher({
      host: options.host,
      sender: new OutboundSender(options.paths.spoolDir),
      messageCharLimit: 0,
      editIntervalMs: options.channels.editIntervalMs,
      asyncThresholdMs: 0,
      queueCapacity: options.limits.ingressQueueSize,
    });
  }

  async start(): Promise<void> {
    const agents = this.options.host.agentIds();
    this.write('Hermes 多智能体平台 · 交互模式');
    this.write('可用智能体：' + (agents.length === 0 ? '（无）' : agents.join('、')));
    this.write('输入 /help 查看指令，Ctrl+C 退出。');
    const rl = createInterface({
      input: this.options.input ?? process.stdin,
      output: this.out,
      prompt: '› ',
    });
    this.rl = rl;
    rl.prompt();
    rl.on('line', (line) => {
      const raw = line.trim();
      if (raw.length === 0) {
        rl.prompt();
        return;
      }
      if (raw === '/exit' || raw === '/quit') {
        void this.stop();
        return;
      }
      void this.handleLine(raw).finally(() => {
        if (!this.stopped) {
          rl.prompt();
        }
      });
    });
    await new Promise<void>((resolve) => {
      rl.on('close', () => {
        this.stopped = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.dispatcher.drain();
    this.rl?.close();
  }

  /** 执行一行输入并等待完成（REPL 里必须串行，否则输出会交错）。 */
  private async handleLine(raw: string): Promise<void> {
    const cliConfig = this.options.channels.cli;
    const known = this.options.host.agentIds();
    const mention = extractMention(raw, known);
    const defaultAgent = cliConfig.defaultAgent ?? known[0];
    const sessionAgent = mention.agentId ?? defaultAgent ?? 'default';
    const message: InboundMessage = {
      channel: 'cli',
      sessionKey: 'cli:' + sessionAgent,
      text: mention.text,
      receivedAt: new Date().toISOString(),
      target: this.target(sessionAgent),
    };
    if (mention.agentId !== undefined) {
      message.agentId = mention.agentId;
    }
    if (defaultAgent !== undefined) {
      message.defaultAgent = defaultAgent;
    }
    try {
      await this.dispatcher.handle(message);
    } catch (error) {
      this.write('✗ ' + describeError(error));
    }
  }

  private target(agentId: string): OutboundTarget {
    return {
      channel: 'cli',
      targetId: 'cli:' + agentId,
      send: async (text: string) => {
        this.write(text);
        return undefined;
      },
    };
  }

  private write(text: string): void {
    this.out.write(text + '\n');
  }
}
