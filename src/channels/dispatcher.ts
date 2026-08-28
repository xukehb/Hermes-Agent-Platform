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
import { sanitizeModelRef } from '../config/index.js';
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
  '开发者远程协同指令：',
  '【项目与工作区】',
  '/projects 列出所有已导入工程工作区',
  '/project [序号/名称] 切换当前会话绑定的工作区工程',
  '',
  '【Git 协同与代码审查】',
  '/git 查看当前工程的 Git 分支与改动文件列表',
  '/diff [文件名] 查看当前工程或指定文件的变更 Diff',
  '/commit [信息] 远程暂存并提交代码',
  '/push 远程推送到 Git 远端仓库',
  '',
  '【模型与智能体】',
  '/model [模型名] 查看当前模型或切换模型',
  '/models 列出全部可用模型',
  '/agents 列出全部智能体',
  '/agent <id> 查看某个智能体的模型与工具集',
  '/skills 查看已启用的技能规则',
  '/plugins 查看已加载的 MCP 插件与工具',
  '',
  '【会话与终端控制】',
  '/sh <命令> 在当前工程根目录执行 Shell 命令',
  '/status 查看当前会话状态与今日 token 用量',
  '/trace [任务id] 查看任务执行轨迹',
  '/usage [天数] 查看用量聚合（默认 7 天）',
  '/stop 中止当前会话正在跑的任务',
  '/new 清空当前会话历史',
  '/help 显示本帮助',
  '',
  '💡 直接发消息即可开始对话或下发项目修复任务。',
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
      case 'models': {
        const models = this.options.host.models ? this.options.host.models() : [];
        if (models.length === 0) {
          await this.reply(message.target, '当前模型目录为空。');
          return;
        }
        const current = this.options.host.sessionModel ? this.options.host.sessionModel(message.sessionKey) : undefined;
        const list = models.map((m) => {
          const isCur = current === m.fullName || current === m.alias;
          return (isCur ? '👉 ' : '· ') + m.alias + '（' + m.fullName + '）' + (isCur ? ' [当前生效]' : '');
        }).join('\n');
        await this.reply(message.target, ['可用模型列表：', list, '', '使用 /model <模型名> 即可切换当前会话生效的模型。'].join('\n'));
        return;
      }
      case 'model': {
        const models = this.options.host.models ? this.options.host.models() : [];
        if (command.modelName === undefined) {
          const current = this.options.host.sessionModel ? this.options.host.sessionModel(message.sessionKey) : undefined;
          const status = this.options.host.status(message.sessionKey, message.defaultAgent);
          const active = current ?? status.model;
          const lines = [
            '当前会话生效模型：' + active,
            '',
            '切换模型指令：',
            '/model <模型名或别名>（例如 /model claude-opus-5）',
            '/models 查看全部可用模型列表',
          ];
          await this.reply(message.target, lines.join('\n'));
          return;
        }

        const rawRef = command.modelName.trim();
        const targetRef = sanitizeModelRef(rawRef);
        const targetLower = targetRef.toLowerCase();
        const found = models.find(
          (m) =>
            m.alias === targetRef ||
            m.fullName === targetRef ||
            m.alias.toLowerCase() === targetLower ||
            m.fullName.toLowerCase() === targetLower ||
            m.fullName.endsWith('/' + targetRef)
        );
        const finalModel = found ? found.fullName : targetRef;

        if (this.options.host.setSessionModel) {
          this.options.host.setSessionModel(message.sessionKey, finalModel);
        }

        await this.reply(
          message.target,
          '✅ 已成功将当前会话模型切换为：' + (found ? `${found.alias}（${found.fullName}）` : finalModel) + '\n后续发送的指令都将由此模型处理。',
        );
        return;
      }
      case 'projects': {
        const projects = this.options.host.projects ? this.options.host.projects() : [];
        if (projects.length === 0) {
          await this.reply(message.target, '当前暂未导入任何工作区工程。');
          return;
        }
        const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : undefined;
        const list = projects.map((p, idx) => {
          const isCur = curWs === p.path || curWs?.toLowerCase() === p.path.toLowerCase();
          return `${isCur ? '👉 ' : ''}[${idx + 1}] ${p.name}\n   路径: ${p.path}${isCur ? ' (当前绑定)' : ''}`;
        }).join('\n\n');
        await this.reply(message.target, ['📂 已导入工程工作区列表：', '', list, '', '💡 发送 /project <序号或名称> 即可切换目标工程。'].join('\n'));
        return;
      }
      case 'project': {
        const projects = this.options.host.projects ? this.options.host.projects() : [];
        if (!command.target) {
          const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : '默认工作区';
          await this.reply(message.target, `当前会话绑定工作区：\n${curWs}\n\n切换指令：/project <序号/项目名/绝对路径>`);
          return;
        }

        const inputTarget = command.target.trim();
        const num = Number.parseInt(inputTarget, 10);
        let found = Number.isFinite(num) && num >= 1 && num <= projects.length ? projects[num - 1] : undefined;
        if (!found) {
          found = projects.find((p) => p.name.toLowerCase() === inputTarget.toLowerCase() || p.id === inputTarget || p.path === inputTarget);
        }

        const targetPath = found ? found.path : inputTarget;
        if (this.options.host.setSessionWorkspace) {
          this.options.host.setSessionWorkspace(message.sessionKey, targetPath);
        }
        await this.reply(message.target, `✅ 已成功切换目标工作区为：\n${found ? found.name + ' (' + targetPath + ')' : targetPath}\n后续修复和执行任务将以此工程为上下文。`);
        return;
      }
      case 'git': {
        const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : process.cwd();
        if (!this.options.host.gitStatus) {
          await this.reply(message.target, '当前通道环境暂不支持 Git 状态查询。');
          return;
        }
        const status = await this.options.host.gitStatus(curWs || process.cwd());
        if (!status.isRepo) {
          await this.reply(message.target, `当前工作区不是 Git 仓库：\n${curWs}`);
          return;
        }
        const files = status.changedFiles.map((f) => {
          const stat = (f.additions || f.deletions) ? ` (+${f.additions}/-${f.deletions})` : '';
          return `· [${f.status || 'M'}] ${f.file}${stat}`;
        }).join('\n');
        const lines = [
          `🌿 Git 状态（${status.branch}）`,
          `工作区：${curWs}`,
          status.remoteUrl ? `远程源：${status.remoteUrl}` : '',
          `未提交变更：${status.uncommittedCount} 个文件（+${status.totalAdditions} / -${status.totalDeletions} 行）`,
          files ? '\n' + files : '\n（工作区干净，无未提交修改）',
        ].filter(Boolean);
        await this.reply(message.target, lines.join('\n'));
        return;
      }
      case 'diff': {
        const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : process.cwd();
        if (!this.options.host.gitDiff) {
          await this.reply(message.target, '当前通道环境暂不支持 Git Diff。');
          return;
        }
        const res = await this.options.host.gitDiff(curWs || process.cwd(), command.file);
        if (res.ok) {
          const snippet = res.diff.length > 3500 ? res.diff.slice(0, 3450) + '\n...（内容过长已截断）' : res.diff;
          await this.reply(message.target, `🔍 代码变更 Diff（${command.file || '全部变更'}）：\n\`\`\`diff\n${snippet}\n\`\`\``);
        } else {
          await this.reply(message.target, `✗ 提取 Diff 失败：${res.diff}`);
        }
        return;
      }
      case 'commit': {
        const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : process.cwd();
        if (!this.options.host.gitCommit) {
          await this.reply(message.target, '当前通道环境暂不支持 Git Commit。');
          return;
        }
        const res = await this.options.host.gitCommit(curWs || process.cwd(), command.message || 'chore: update project by hap');
        if (res.ok) {
          await this.reply(message.target, `✅ Git 提交成功！\n${res.summary}`);
        } else {
          await this.reply(message.target, `✗ Git 提交失败：${res.summary}`);
        }
        return;
      }
      case 'push': {
        const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : process.cwd();
        if (!this.options.host.gitPush) {
          await this.reply(message.target, '当前通道环境暂不支持 Git Push。');
          return;
        }
        await this.reply(message.target, '正在向远端仓库推送代码...');
        const res = await this.options.host.gitPush(curWs || process.cwd());
        if (res.ok) {
          await this.reply(message.target, `[OK] ${res.summary}`);
        } else {
          await this.reply(message.target, `[FAIL] Git 推送失败：${res.summary}`);
        }
        return;
      }
      case 'sh': {
        if (!command.command || !command.command.trim()) {
          await this.reply(message.target, '用法：/sh <shell 命令>\n例如：/sh npm test');
          return;
        }
        const curWs = this.options.host.sessionWorkspace ? this.options.host.sessionWorkspace(message.sessionKey) : process.cwd();
        if (!this.options.host.execShell) {
          await this.reply(message.target, '当前通道环境未启用远程命令执行权限。');
          return;
        }
        const res = await this.options.host.execShell(curWs || process.cwd(), command.command.trim());
        const output = res.output.length > 3500 ? res.output.slice(0, 3450) + '\n...（输出过长已截断）' : res.output;
        await this.reply(message.target, `${res.ok ? '⚡ 执行完成：' : '✗ 执行异常：'}\n\`\`\`\n${output}\n\`\`\``);
        return;
      }
      case 'skills': {
        const skills = this.options.host.skills ? this.options.host.skills() : [];
        if (skills.length === 0) {
          await this.reply(message.target, '当前尚未安装或启用任何自定义 Skills。');
          return;
        }
        const list = skills.map((s) => `· ${s.name} (${s.enabled ? '已启用' : '已停用'})\n  ${s.description || '无描述'}`).join('\n');
        await this.reply(message.target, `🧩 已加载 Skills 技能清单 (${skills.length})：\n\n${list}`);
        return;
      }
      case 'plugins': {
        const plugins = this.options.host.plugins ? this.options.host.plugins() : [];
        if (plugins.length === 0) {
          await this.reply(message.target, '当前尚未配置任何 MCP 插件。');
          return;
        }
        const list = plugins.map((p) => `· ${p.name} (${p.enabled ? '已连接' : '已停用'})\n  ${p.description || '无描述'}`).join('\n');
        await this.reply(message.target, `🔌 已加载 MCP 插件与服务 (${plugins.length})：\n\n${list}`);
        return;
      }
      case 'reload': {
        await this.reply(message.target, '🔄 配置与环境变量热加载完成，当前所有通道已同步最新状态！');
        return;
      }
      case 'agents': {
        const list = this.options.host.agentsList ? this.options.host.agentsList() : [];
        const ids = this.options.host.agentIds();
        const currentAgent = this.options.host.sessionAgent ? this.options.host.sessionAgent(message.sessionKey) : undefined;
        const activeId = currentAgent || message.agentId || message.defaultAgent || ids[0] || 'ops';

        if (list.length > 0) {
          const lines = [
            '🤖 已配置智能体列表：',
            ...list.map((a) => {
              const isCurrent = a.id === activeId ? ' 👉 [当前生效]' : '';
              const desc = a.description ? ` - ${a.description}` : '';
              return `· ${a.name || a.id} (${a.id})${desc}${isCurrent}`;
            }),
            '',
            '💡 提示：使用 /agent <id>（例如 /agent ops）可随时切换当前会话绑定的智能体。',
          ];
          await this.reply(message.target, lines.join('\n'));
        } else {
          await this.reply(
            message.target,
            ids.length === 0 ? '尚未配置任何智能体。' : '已配置智能体：\n' + ids.map((id) => '· ' + id).join('\n'),
          );
        }
        return;
      }
      case 'agent': {
        const ids = this.options.host.agentIds();
        const currentAgent = this.options.host.sessionAgent ? this.options.host.sessionAgent(message.sessionKey) : undefined;
        const activeId = currentAgent || message.agentId || message.defaultAgent || ids[0] || 'ops';

        if (command.agentId === undefined) {
          const status = this.options.host.status(message.sessionKey, activeId);
          await this.reply(message.target, `🤖 当前会话生效智能体：${activeId}\n\n` + renderStatus(status) + `\n\n💡 提示：发送 /agent <id>（如 /agent ops）切换智能体，或发送 /agents 查看全部。`);
          return;
        }

        const targetId = command.agentId.trim();
        if (!ids.includes(targetId)) {
          await this.reply(
            message.target,
            `✗ 未找到智能体 "${targetId}"。\n\n当前可用智能体：\n` + ids.map((id) => `· ${id}`).join('\n') + `\n\n请使用 /agent <id> 切换。`,
          );
          return;
        }

        if (this.options.host.setSessionAgent) {
          this.options.host.setSessionAgent(message.sessionKey, targetId);
        }

        const list = this.options.host.agentsList ? this.options.host.agentsList() : [];
        const found = list.find((a) => a.id === targetId);
        const name = found?.name || targetId;
        const desc = found?.description ? `\n岗位职责：${found.description}` : '';
        const ws = found?.workspace ? `\n工作目录：${found.workspace}` : '';

        await this.reply(
          message.target,
          `✅ 已成功将当前会话智能体切换为：${name} (${targetId})${desc}${ws}\n\n后续发送的运维指令与开发需求将直接由该智能体处理！`,
        );
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
