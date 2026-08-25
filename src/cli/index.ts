/**
 * hap 命令行入口（FR-CLI-001 ~ FR-CLI-012）。
 *
 * 这里只做三件事：声明全局选项、注册命令、把异常翻译成人读文本。
 * 具体逻辑分散在 provider/model/agent 三组子命令与 channels 层，
 * 入口保持薄，才能在新增命令时不产生连锁修改。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { Command } from 'commander';

import { CliContext, CliExit, emit, fail, type GlobalOptions } from './context.js';
import { orDash, renderPairs, renderTable, yesNo } from './render.js';
import { registerProviderCommands } from './provider-commands.js';
import { registerModelCommands } from './model-commands.js';
import { registerAgentCommands } from './agent-commands.js';
import { ChannelManager, CliChannel, createChannelHost, describeError, renderStatus, renderTrace, renderUsage } from '../channels/index.js';
import { ProviderRegistry } from '../providers/index.js';
import type { TaskEvent } from '../agent/index.js';
import { HapError } from '../domain/index.js';

const VERSION = '0.1.0';

/** 组装根命令。导出以便测试直接 parseAsync，不必起子进程。 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('hap')
    .description('Hermes 多智能体平台：任意模型、任意智能体、手机端下发指令')
    .version(VERSION)
    .option('-c, --config <path>', '配置文件路径（缺省按 HAP_CONFIG → ./hap.toml → ~/.hap/config.toml 探测）')
    .option('-p, --profile <name>', '激活的配置档位')
    .option('--json', '以 JSON 输出，便于脚本消费')
    .enablePositionalOptions()
    .showHelpAfterError();

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();

  registerInit(program, globals);
  registerServe(program, globals);
  registerRun(program, globals);
  registerChat(program, globals);
  registerConfig(program, globals);
  registerOps(program, globals);
  registerProviderCommands(program, globals);
  registerModelCommands(program, globals);
  registerAgentCommands(program, globals);

  return program;
}

// ── init ──

function registerInit(program: Command, globals: () => GlobalOptions): void {
  program
    .command('init')
    .description('写入配置骨架（8 家服务商、若干模型、6 个示例智能体）')
    .option('--force', '覆盖已存在的配置文件')
    .action((options: { force?: boolean }) => {
      const ctx = new CliContext(globals());
      const result = ctx.writer().initScaffold(options.force === true);
      const next = [
        '',
        '接下来：',
        '  1) 导出所用服务商的 Key，如 $env:DEEPSEEK_API_KEY=...',
        '  2) hap doctor            检查凭据与服务商连通性',
        '  3) hap agent list        查看内置示例智能体',
        '  4) $env:TELEGRAM_BOT_TOKEN=...  然后 hap serve 拉起手机端',
      ].join('\n');
      emit(ctx, '✓ ' + result.summary + next, result);
    });
}

// ── serve ──

function registerServe(program: Command, globals: () => GlobalOptions): void {
  program
    .command('serve')
    .description('启动常驻服务：Telegram / HTTP 通道 + 编排层')
    .option('--with-cli', '同时在当前终端开启交互 REPL')
    .action(async (options: { withCli?: boolean }) => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      const log = (line: string): void => {
        process.stdout.write('[hap] ' + line + '\n');
      };

      const missing = orchestrator.config.missingCredentials();
      for (const item of missing) {
        log('⚠ 服务商 ' + item.providerId + ' 缺少凭据环境变量 ' + item.envKey + '，涉及它的模型会在调用时失败。');
      }

      const mcp = await orchestrator.loadMcpTools();
      if (mcp.modules.length > 0) {
        log('已加载 ' + String(mcp.modules.length) + ' 个 MCP 工具模块。');
      }
      for (const failure of mcp.failures) {
        log('⚠ MCP 服务器 ' + failure.serverId + ' 加载失败：' + failure.message);
      }

      const manager = new ChannelManager({
        orchestrator,
        env: process.env,
        log,
        ...(options.withCli === true ? { includeCli: true } : {}),
      });
      await manager.start();
      const enabled = manager.enabled();
      log(enabled.length === 0 ? '没有启用任何通道。' : '已启动通道：' + enabled.join('、'));
      log('按 Ctrl+C 退出。');

      await waitForShutdown(async () => {
        log('正在停止……');
        await manager.stop();
        await ctx.close();
        log('已停止。');
      });
    });
}

/** 等待 SIGINT / SIGTERM，并保证清理只跑一次。 */
async function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const handler = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      void cleanup().then(resolve, resolve);
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  });
}

// ── run ──

function registerRun(program: Command, globals: () => GlobalOptions): void {
  program
    .command('run <prompt...>')
    .description('单次执行一条指令并把过程打在终端上')
    .option('-a, --agent <id>', '指定智能体')
    .option('-s, --session <key>', '会话键；缺省 cli:<agent>')
    .option('--quiet', '只输出最终结果，不打印过程')
    .option('--no-persist', '不落 SQLite，本次会话用内存存储')
    .action(async (parts: string[], options: RunOptions) => {
      const ctx = new CliContext(globals());
      const prompt = parts.join(' ');
      const orchestrator = options.persist === false
        ? ctx.orchestratorWith({ memoryStore: true })
        : ctx.orchestrator();
      await orchestrator.loadMcpTools();
      const quiet = options.quiet === true || ctx.json;
      try {
        const request: Parameters<typeof orchestrator.runTask>[0] = { input: prompt };
        if (options.agent !== undefined) {
          request.agentId = options.agent;
        }
        if (options.session !== undefined) {
          request.sessionKey = options.session;
        }
        if (!quiet) {
          request.onEvent = (event: TaskEvent) => printEvent(event);
        }
        const outcome = await orchestrator.runTask(request);
        const summary = [
          '',
          '── 结果 ──',
          outcome.text.length === 0 ? '（模型未产出正文）' : outcome.text,
          '',
          renderPairs([
            ['任务', outcome.taskId],
            ['智能体', outcome.agentId],
            ['模型', outcome.model],
            ['协议', outcome.protocol],
            ['轮数', String(outcome.iterations)],
            ['停止原因', outcome.stopReason],
            ['token', String(outcome.usage.totalTokens)],
            ['trace', outcome.tracePath],
            ['错误', orDash(outcome.error)],
          ]),
        ].join('\n');
        emit(ctx, quiet ? outcome.text : summary, outcome);
        if (outcome.status === 'failed') {
          process.exitCode = 1;
        }
      } finally {
        await ctx.close();
      }
    });
}

interface RunOptions {
  agent?: string;
  session?: string;
  quiet?: boolean;
  /** commander 的 --no-persist 会把 persist 置为 false */
  persist?: boolean;
}

/** 把任务事件打成终端可读的一行行。工具参数只留摘要，避免刷屏。 */
function printEvent(event: TaskEvent): void {
  switch (event.type) {
    case 'iteration':
      process.stdout.write('· 第 ' + String(event.index) + ' 轮\n');
      break;
    case 'text':
      process.stdout.write(event.text);
      break;
    case 'reasoning':
      process.stdout.write('\u001b[2m' + event.text + '\u001b[0m');
      break;
    case 'tool_start':
      process.stdout.write('\n→ ' + event.name + ' ' + briefArgs(event.args) + '\n');
      break;
    case 'tool_end':
      process.stdout.write((event.result.isError ? '✗ ' : '← ') + firstLine(event.result.content) + '\n');
      break;
    case 'model_switch':
      process.stdout.write('\n⇄ ' + event.from + ' → ' + event.to + '（' + event.reason + '）\n');
      break;
    case 'notice':
      process.stdout.write('\n⚠ ' + event.message + '\n');
      break;
    case 'usage':
      break;
    default:
      break;
  }
}

function briefArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length <= 160 ? text : text.slice(0, 157) + '...';
}

function firstLine(content: string): string {
  const line = content.split('\n', 1)[0] ?? '';
  return line.length <= 200 ? line : line.slice(0, 197) + '...';
}

// ── chat ──

function registerChat(program: Command, globals: () => GlobalOptions): void {
  program
    .command('chat')
    .description('进入交互式 REPL（与 Telegram 共用同一套指令语义）')
    .action(async () => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      await orchestrator.loadMcpTools();
      const resolver = orchestrator.config;
      const channel = new CliChannel({
        host: createChannelHost(orchestrator),
        channels: resolver.resolveChannels(),
        limits: resolver.resolveLimits(),
        paths: orchestrator.resolvedPaths,
      });
      await channel.start();
      await waitForShutdown(async () => {
        await channel.stop();
        await ctx.close();
      });
    });
}

// ── config ──

function registerConfig(program: Command, globals: () => GlobalOptions): void {
  const config = program.command('config').description('查看配置解析结果');

  config
    .command('path')
    .description('显示当前生效的配置文件路径与数据目录')
    .action(() => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const paths = resolver.resolvePaths();
      const pairs: Array<readonly [string, string]> = [
        ['配置文件', ctx.configPath],
        ['档位', orDash(resolver.profileName)],
        ['数据目录', paths.dataDir],
        ['trace 目录', paths.traceDir],
        ['溢出目录', paths.overflowDir],
        ['出站缓冲', paths.spoolDir],
      ];
      emit(ctx, renderPairs(pairs), { configPath: ctx.configPath, profile: resolver.profileName, paths });
    });

  config
    .command('keys')
    .description('列出全部可解析的配置键')
    .action(() => {
      const ctx = new CliContext(globals());
      const keys = ctx.resolver().keys();
      emit(ctx, keys.join('\n'), keys);
    });

  config
    .command('explain <key>')
    .description('展示某个配置键的六层取值与胜出层（FR-CFG-006）')
    .option('-a, --agent <id>', '按某个智能体的视角解析')
    .action((key: string, options: { agent?: string }) => {
      const ctx = new CliContext(globals());
      const result = ctx.resolver().explain(key, options.agent);
      const rows = result.candidates.map((item) => [
        item.layer + (item.layer === result.winner ? ' *' : ''),
        item.present ? '有' : '-',
        item.present ? format(item.value) : '-',
        item.source,
      ]);
      const head = renderPairs([
        ['键', result.key],
        ['智能体', orDash(result.agentId)],
        ['生效值', format(result.value)],
        ['胜出层', result.winner],
      ]);
      emit(ctx, head + '\n\n' + renderTable(['层', '声明', '取值', '出处'], rows), result);
    });

  config
    .command('limits')
    .description('显示生效的配额上限')
    .action(() => {
      const ctx = new CliContext(globals());
      const limits = ctx.resolver().resolveLimits();
      const pairs = Object.entries(limits).map(
        ([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)] as const,
      );
      emit(ctx, renderPairs(pairs), limits);
    });

  config
    .command('channels')
    .description('显示通道配置')
    .action(() => {
      const ctx = new CliContext(globals());
      const channels = ctx.resolver().resolveChannels();
      const pairs: Array<readonly [string, string]> = [
        ['编辑节流', String(channels.editIntervalMs) + 'ms'],
        ['异步阈值', String(channels.asyncThresholdMs) + 'ms'],
        ['Telegram', yesNo(channels.telegram.enabled) + '（' + channels.telegram.mode + '，token 取自 ' + channels.telegram.tokenEnv + '）'],
        ['Telegram 默认智能体', orDash(channels.telegram.defaultAgent)],
        ['Telegram 唤起词', channels.telegram.mentionPatterns.join(' / ')],
        ['WhatsApp', yesNo(channels.whatsapp.enabled) + '（凭据目录 ' + channels.whatsapp.authDir + '）'],
        ['WhatsApp 默认智能体', orDash(channels.whatsapp.defaultAgent)],
        ['WhatsApp 唤起词', channels.whatsapp.mentionPatterns.join(' / ')],
        ['HTTP', yesNo(channels.http.enabled) + '（' + channels.http.bind + '）'],
        ['CLI', yesNo(channels.cli.enabled)],
      ];
      emit(ctx, renderPairs(pairs), channels);
    });
}

function format(value: unknown): string {
  if (value === undefined) {
    return '-';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// ── status / trace / stop / usage / doctor ──

function registerOps(program: Command, globals: () => GlobalOptions): void {
  program
    .command('status [session]')
    .description('查看会话状态、降级链与今日用量')
    .action(async (session: string | undefined) => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      try {
        const key = session ?? 'cli:' + orchestrator.config.resolveDefaultAgentId();
        const status = orchestrator.status(key);
        emit(ctx, renderStatus(status), status);
      } finally {
        await ctx.close();
      }
    });

  program
    .command('trace <taskId>')
    .description('查看任务执行轨迹摘要')
    .action(async (taskId: string) => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      try {
        const summary = orchestrator.trace(taskId);
        if (summary === undefined) {
          fail('没有找到任务 ' + taskId);
        }
        emit(ctx, renderTrace(summary), summary);
      } finally {
        await ctx.close();
      }
    });

  program
    .command('stop <session>')
    .description('中止某会话正在执行的任务')
    .action(async (session: string) => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      try {
        const stopped = orchestrator.abortSession(session);
        emit(
          ctx,
          stopped.length === 0 ? '该会话没有正在执行的任务。' : '✓ 已中止 ' + String(stopped.length) + ' 个任务：' + stopped.join(', '),
          { sessionKey: session, stopped },
        );
      } finally {
        await ctx.close();
      }
    });

  program
    .command('usage')
    .description('按智能体与模型聚合 token 用量')
    .option('-d, --days <n>', '统计天数，默认 7', (value: string) => Number.parseInt(value, 10), 7)
    .action(async (options: { days: number }) => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      try {
        const days = Number.isFinite(options.days) && options.days > 0 ? options.days : 7;
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const rows = orchestrator.usageSince(since);
        emit(ctx, renderUsage(rows, days), rows);
      } finally {
        await ctx.close();
      }
    });

  program
    .command('prune')
    .description('清理超过保留期的会话与任务记录')
    .option('-d, --days <n>', '保留天数，缺省取 limits.session_retention_days', (value: string) => Number.parseInt(value, 10))
    .action(async (options: { days?: number }) => {
      const ctx = new CliContext(globals());
      const orchestrator = ctx.orchestrator();
      try {
        const removed = orchestrator.prune(options.days);
        emit(ctx, '✓ 已清理 ' + String(removed) + ' 条过期记录。', { removed });
      } finally {
        await ctx.close();
      }
    });

  program
    .command('doctor')
    .description('体检：配置可解析性、凭据缺失、服务商连通性、MCP 加载')
    .option('--skip-network', '跳过服务商连通性探测')
    .action(async (options: { skipNetwork?: boolean }) => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const lines: string[] = [];
      const report: DoctorReport = { configPath: ctx.configPath, agents: [], missingCredentials: [], providers: [], mcp: [] };

      lines.push('配置文件 ' + ctx.configPath);

      const agents = resolver.resolveAllAgents();
      report.agents = agents.map((agent) => ({ id: agent.id, model: agent.model.primary, fallbacks: agent.model.fallbacks }));
      lines.push('✓ ' + String(agents.length) + ' 个智能体可解析：' + agents.map((agent) => agent.id).join('、'));

      const missing = resolver.missingCredentials();
      report.missingCredentials = missing;
      if (missing.length === 0) {
        lines.push('✓ 被引用的服务商凭据齐全');
      } else {
        for (const item of missing) {
          lines.push('✗ 服务商 ' + item.providerId + ' 缺少环境变量 ' + item.envKey);
        }
      }

      if (options.skipNetwork !== true) {
        const referenced = resolver.referencedProviderIds();
        const registry = new ProviderRegistry(resolver.resolveProviders(), { env: process.env });
        const results = await Promise.all(
          [...referenced].map(async (id) => {
            try {
              return await registry.client(id).check();
            } catch (error) {
              return { providerId: id, reachable: false, handshakeMs: 0, models: [], error: describeError(error) };
            }
          }),
        );
        report.providers = results;
        for (const result of results) {
          lines.push(
            (result.reachable ? '✓ ' : '✗ ') +
              result.providerId +
              (result.reachable
                ? '（' + String(result.handshakeMs) + 'ms，' + String(result.models.length) + ' 个模型可见）'
                : '：' + (result.error ?? '不可达')),
          );
        }
      }

      const mcp = await ctx.orchestrator().loadMcpTools();
      report.mcp = mcp.failures.map((failure) => ({ serverId: failure.serverId, message: failure.message }));
      if (mcp.modules.length > 0) {
        lines.push('✓ MCP 工具模块 ' + String(mcp.modules.length) + ' 个');
      }
      for (const failure of mcp.failures) {
        lines.push('✗ MCP 服务器 ' + failure.serverId + '：' + failure.message);
      }
      await ctx.close();

      const bad = report.missingCredentials.length + report.providers.filter((item) => !item.reachable).length + report.mcp.length;
      lines.push('');
      lines.push(bad === 0 ? '体检通过。' : '发现 ' + String(bad) + ' 处问题，见上。');
      if (bad > 0) {
        process.exitCode = 1;
      }
      emit(ctx, lines.join('\n'), report);
    });
}

interface DoctorReport {
  configPath: string;
  agents: Array<{ id: string; model: string; fallbacks: string[] }>;
  missingCredentials: Array<{ providerId: string; envKey: string }>;
  providers: Array<{ providerId: string; reachable: boolean; handshakeMs: number; models: string[]; error?: string }>;
  mcp: Array<{ serverId: string; message: string }>;
}

/**
 * 进程入口。
 *
 * HapError 已带面向用户的说明，直接打印；其余异常打完整信息，
 * 因为那属于「不该发生」的分支，堆栈对定位更有价值。
 */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CliExit) {
      return;
    }
    if (error instanceof HapError) {
      process.stderr.write('✗ [' + error.code + '] ' + (error.userMessage ?? error.message) + '\n');
      process.exitCode = 1;
      return;
    }
    process.stderr.write('✗ ' + describeError(error) + '\n');
    process.exitCode = 1;
  }
}
