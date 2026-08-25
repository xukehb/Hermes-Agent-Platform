/**
 * CLI 运行上下文。
 *
 * 大多数命令都需要「一个编排器 + 一个配置写入器」，但只读命令不该为了
 * 打印一张表就去连 MCP、建 SQLite。因此这里做惰性装配：
 * writer() 只碰配置文件，orchestrator() 才真正拉起完整运行时。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { AgentOrchestrator } from '../agent/index.js';
import { ConfigResolver, ConfigWriter, loadConfig, resolveConfigPath } from '../config/index.js';

/** 全局选项，来自 commander 的根命令。 */
export interface GlobalOptions {
  config?: string;
  profile?: string;
  json?: boolean;
}

/** CLI 上下文。 */
export class CliContext {
  readonly configPath: string;
  private readonly options: GlobalOptions;
  private orchestratorCache: AgentOrchestrator | undefined;

  constructor(options: GlobalOptions) {
    this.options = options;
    this.configPath = resolveConfigPath(options.config, process.env);
  }

  get json(): boolean {
    return this.options.json === true;
  }

  /** 只读配置解析器：不建目录、不连 provider。 */
  resolver(): ConfigResolver {
    const loaded = loadConfig({ path: this.configPath, env: process.env });
    const cli = this.options.profile === undefined ? {} : { profile: this.options.profile };
    return new ConfigResolver(loaded, cli, process.env);
  }

  /** 只写配置文件的入口，供 provider/model/agent 的增删改使用。 */
  writer(): ConfigWriter {
    return new ConfigWriter(this.configPath);
  }

  /** 完整运行时。同一进程内复用，避免重复建库。 */
  orchestrator(): AgentOrchestrator {
    if (this.orchestratorCache === undefined) {
      this.orchestratorCache = new AgentOrchestrator({ configPath: this.configPath });
    }
    return this.orchestratorCache;
  }

  /**
   * 带额外构造参数的运行时。
   *
   * hap run --no-persist 需要内存存储，但仍要复用同一份配置路径解析；
   * 与 orchestrator() 共享同一个缓存槽，因此一个进程内只会有一个编排器。
   */
  orchestratorWith(extra: { memoryStore?: boolean; historyLimit?: number }): AgentOrchestrator {
    if (this.orchestratorCache === undefined) {
      this.orchestratorCache = new AgentOrchestrator({ configPath: this.configPath, ...extra });
    }
    return this.orchestratorCache;
  }

  async close(): Promise<void> {
    if (this.orchestratorCache !== undefined) {
      await this.orchestratorCache.close();
      this.orchestratorCache = undefined;
    }
  }
}

/** 统一输出：--json 时打印结构化数据，否则打印人读文本。 */
export function emit(ctx: CliContext, text: string, data: unknown): void {
  if (ctx.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  process.stdout.write(text + '\n');
}

/** 错误输出并以非零码退出，供命令层复用。 */
export function fail(message: string): never {
  process.stderr.write('✗ ' + message + '\n');
  process.exitCode = 1;
  throw new CliExit(message);
}

/** CLI 主动终止信号：入口捕获后静默退出，不再打印堆栈。 */
export class CliExit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliExit';
  }
}
