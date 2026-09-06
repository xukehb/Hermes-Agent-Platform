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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { TelegramChannel } from './telegram.js';
import { WhatsAppChannel } from './whatsapp.js';
import { WeChatChannel } from './wechat.js';
import { FeishuChannel } from './feishu.js';
import { QQChannel } from './qq.js';
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

const sessionModels = new Map<string, string>();
const sessionWorkspaces = new Map<string, string>();
const sessionAgents = new Map<string, string>();

function readGuiProjects(): Array<{ id: string; name: string; path: string }> {
  try {
    const statePath = join(homedir(), '.hap', 'gui', 'state.json');
    if (existsSync(statePath)) {
      const data = JSON.parse(readFileSync(statePath, 'utf8')) as { projects?: Array<{ id: string; name: string; path: string }> };
      if (Array.isArray(data.projects) && data.projects.length > 0) return data.projects;
    }
  } catch {}
  return [{ id: 'default', name: '当前工作区', path: process.cwd() }];
}

function readGuiSkills(): Array<{ id: string; name: string; description: string; enabled: boolean }> {
  try {
    const statePath = join(homedir(), '.hap', 'gui', 'state.json');
    if (existsSync(statePath)) {
      const data = JSON.parse(readFileSync(statePath, 'utf8')) as { skills?: Array<{ id: string; name: string; description: string; enabled: boolean }> };
      if (Array.isArray(data.skills)) return data.skills;
    }
  } catch {}
  return [];
}

function readGuiPlugins(): Array<{ id: string; name: string; description: string; enabled: boolean }> {
  try {
    const statePath = join(homedir(), '.hap', 'gui', 'state.json');
    if (existsSync(statePath)) {
      const data = JSON.parse(readFileSync(statePath, 'utf8')) as { plugins?: Array<{ id: string; name: string; description: string; enabled: boolean }> };
      if (Array.isArray(data.plugins)) return data.plugins;
    }
  } catch {}
  return [];
}

export function createChannelHost(orchestrator: AgentOrchestrator): ChannelHost {
  return {
    runTask: (request) => {
      if (request.agentId === undefined && request.sessionKey && sessionAgents.has(request.sessionKey)) {
        request.agentId = sessionAgents.get(request.sessionKey);
      }
      if (request.model === undefined && request.sessionKey && sessionModels.has(request.sessionKey)) {
        request.model = sessionModels.get(request.sessionKey);
      }
      if (request.sessionKey && sessionWorkspaces.has(request.sessionKey)) {
        const ws = sessionWorkspaces.get(request.sessionKey)!;
        request.input = `项目路径：${ws}\n\n${request.input}`;
      }
      return orchestrator.runTask(request);
    },
    abortSession: (sessionKey) => orchestrator.abortSession(sessionKey),
    status: (sessionKey, channelDefaultAgent) => {
      const activeAgent = (sessionKey && sessionAgents.has(sessionKey)) ? sessionAgents.get(sessionKey) : channelDefaultAgent;
      const status = orchestrator.status(sessionKey, activeAgent);
      if (sessionModels.has(sessionKey)) {
        status.model = sessionModels.get(sessionKey)!;
      }
      return status;
    },
    trace: (taskId) => orchestrator.trace(taskId),
    agentIds: () => orchestrator.agents.agentIds(),
    agentsList: () => {
      const resolver = orchestrator.config;
      return resolver.listAgentIds().map((id) => {
        const ag = resolver.resolveAgent(id);
        return {
          id: ag.id,
          name: ag.identity.displayName || ag.id,
          displayName: ag.identity.displayName,
          description: ag.description,
          model: ag.model.primary,
          workspace: ag.workspace,
        };
      });
    },
    sessionAgent: (sessionKey) => sessionAgents.get(sessionKey),
    setSessionAgent: (sessionKey, agentId) => {
      sessionAgents.set(sessionKey, agentId);
    },
    models: () => {
      const resolver = orchestrator.config;
      return [...resolver.resolveModels().values()].map((m) => ({
        fullName: m.fullName,
        alias: m.alias,
        providerId: m.providerId,
      }));
    },
    sessionModel: (sessionKey) => sessionModels.get(sessionKey),
    setSessionModel: (sessionKey, model) => {
      sessionModels.set(sessionKey, model);
    },
    projects: () => readGuiProjects(),
    sessionWorkspace: (sessionKey) => {
      if (sessionWorkspaces.has(sessionKey)) return sessionWorkspaces.get(sessionKey);
      const prjs = readGuiProjects();
      return prjs[0]?.path || process.cwd();
    },
    setSessionWorkspace: (sessionKey, workspace) => {
      sessionWorkspaces.set(sessionKey, workspace);
    },
    gitStatus: async (projectPath) => {
      if (!existsSync(join(projectPath, '.git'))) {
        return {
          isRepo: false,
          branch: '',
          changedFiles: [],
          uncommittedCount: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          recentCommits: [],
        };
      }
      let branch = 'main';
      try {
        const b = await execa('git', ['branch', '--show-current'], { cwd: projectPath });
        branch = b.stdout.trim() || 'HEAD';
      } catch {}
      let remoteUrl: string | undefined;
      try {
        const r = await execa('git', ['remote', 'get-url', 'origin'], { cwd: projectPath });
        remoteUrl = r.stdout.trim() || undefined;
      } catch {}

      const numstatMap = new Map<string, { additions: number; deletions: number }>();
      try {
        const numstatRes = await execa('git', ['diff', 'HEAD', '--numstat'], { cwd: projectPath });
        for (const line of numstatRes.stdout.split('\n').filter(Boolean)) {
          const parts = line.split('\t');
          if (parts.length >= 3 && parts[2] !== undefined) {
            numstatMap.set(parts[2].trim(), { additions: Number(parts[0]) || 0, deletions: Number(parts[1]) || 0 });
          }
        }
      } catch {}

      const changedFiles: Array<{ status: string; file: string; additions: number; deletions: number }> = [];
      let totalAdditions = 0;
      let totalDeletions = 0;
      try {
        const sRes = await execa('git', ['status', '--porcelain'], { cwd: projectPath });
        for (const line of sRes.stdout.split('\n').filter(Boolean)) {
          const status = line.slice(0, 2).trim();
          const file = line.slice(3).trim();
          const stat = numstatMap.get(file) || { additions: 0, deletions: 0 };
          totalAdditions += stat.additions;
          totalDeletions += stat.deletions;
          changedFiles.push({ status, file, additions: stat.additions, deletions: stat.deletions });
        }
      } catch {}

      const recentCommits: Array<{ hash: string; message: string }> = [];
      try {
        const logRes = await execa('git', ['log', '-n', '5', '--oneline'], { cwd: projectPath });
        for (const line of logRes.stdout.split('\n').filter(Boolean)) {
          const spaceIdx = line.indexOf(' ');
          if (spaceIdx > 0) {
            recentCommits.push({ hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) });
          }
        }
      } catch {}

      return {
        isRepo: true,
        branch,
        remoteUrl,
        changedFiles,
        uncommittedCount: changedFiles.length,
        totalAdditions,
        totalDeletions,
        recentCommits,
      };
    },
    gitDiff: async (projectPath, file) => {
      try {
        const args = file ? ['diff', 'HEAD', '--', file] : ['diff', 'HEAD'];
        const res = await execa('git', args, { cwd: projectPath });
        if (res.stdout.trim()) return { ok: true, diff: res.stdout.trim() };
        const workingDiff = await execa('git', file ? ['diff', '--', file] : ['diff'], { cwd: projectPath });
        if (workingDiff.stdout.trim()) return { ok: true, diff: workingDiff.stdout.trim() };
        return { ok: true, diff: '（当前暂无变更差异代码）' };
      } catch (err) {
        return { ok: false, diff: describeError(err) };
      }
    },
    gitCommit: async (projectPath, message) => {
      try {
        await execa('git', ['add', '-A'], { cwd: projectPath });
        const res = await execa('git', ['commit', '-m', message || 'chore: update project by hap'], { cwd: projectPath });
        return { ok: true, summary: res.stdout.trim() };
      } catch (err) {
        return { ok: false, summary: describeError(err) };
      }
    },
    gitPush: async (projectPath) => {
      try {
        const res = await execa('git', ['push'], { cwd: projectPath });
        return { ok: true, summary: res.stdout.trim() || '代码已成功推送至远端！' };
      } catch (err) {
        return { ok: false, summary: describeError(err) };
      }
    },
    execShell: async (projectPath, command) => {
      try {
        const res = await execa(command, { cwd: projectPath, shell: true, timeout: 30000 });
        const out = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
        return { ok: true, output: out || '（命令执行完毕，无输出）' };
      } catch (err) {
        return { ok: false, output: describeError(err) };
      }
    },
    skills: () => readGuiSkills(),
    plugins: () => readGuiPlugins(),
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
  private whatsapp: WhatsAppChannel | undefined;
  wechat: WeChatChannel | undefined;

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
    if (channels.whatsapp.enabled) {
      const whatsapp = new WhatsAppChannel({
        host: this.host,
        channels,
        limits,
        paths,
        log: this.log,
      });
      this.whatsapp = whatsapp;
      this.channels.push(whatsapp);
    }
    if (channels.wechat.enabled) {
      const wechat = new WeChatChannel({
        host: this.host,
        channels,
        limits,
        paths,
        env: this.env,
        log: this.log,
      });
      this.wechat = wechat;
      this.channels.push(wechat);
    }
    if (channels.feishu?.enabled) {
      const feishu = new FeishuChannel({
        host: this.host,
        config: channels.feishu,
        channels,
        limits,
        paths,
        env: this.env,
      });
      this.channels.push(feishu);
    }
    if (channels.qq?.enabled) {
      const qq = new QQChannel({
        host: this.host,
        config: channels.qq,
        channels,
        limits,
        paths,
        env: this.env,
      });
      this.channels.push(qq);
    }
    if (channels.http.enabled) {
      this.channels.push(new HttpChannel({
        host: this.host,
        channels,
        limits,
        paths,
        authToken: channels.http.authToken,
        maxBodyBytes: channels.http.maxBodyBytes,
        log: this.log,
      }));
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
    this.whatsapp = undefined;
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
      if (row.sessionKey.startsWith('whatsapp:') && this.whatsapp !== undefined) {
        void this.whatsapp.notify(row.sessionKey.slice('whatsapp:'.length), text);
        continue;
      }
      this.log(text);
    }
  }
}
