/**
 * 任务编排器（FR-TASK-001~008、FR-ROUTE-003/007、FR-CFG-005）。
 *
 * 这是平台的中枢：把「一条用户指令」变成「一次带完整留痕的任务执行」。
 * 一次 runTask 的固定流程：
 *
 *   路由 → 目录就绪 → 取历史 → 组装 system 提示 → 日预算闸门 → 建任务记录
 *     → AgentLoop.run（内部含降级、压缩、工具执行）→ trace 落盘
 *     → 追加消息 + 记录用量 + 更新任务状态
 *
 * 三条关键设计：
 * 1. trace 事件边收边攒进内存数组，任务收尾时一次性落 JSONL。任务中途进程崩溃时
 *    内存数组会丢，但 SQLite 里的 running 记录还在，重启后由 recoverInterrupted()
 *    标记为 interrupted（FR-TASK-008），用户至少知道发生了什么。
 * 2. 取消分两层：外部 signal（通道 /stop）与内部 AbortController 联动，
 *    内部 controller 存进 running 表，abort(taskId) 直接触发（FR-TASK-003）。
 * 3. 编排器不碰通道协议，只发 TaskEvent；通道层订阅事件流自行决定渲染方式。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FatalError, HapError, describeError, emptyUsage } from '../domain/index.js';
import type { AgentMessage, TokenUsage, TraceEvent } from '../domain/index.js';
import { ConfigResolver, loadConfig } from '../config/index.js';
import type { LoadedConfig, ResolvedAgent, ResolvedPaths } from '../config/index.js';
import { ProviderRegistry, providerGateRegistry } from '../providers/index.js';
import type { EnvLike, ProviderFactory } from '../providers/index.js';
import { McpManager, ToolRegistry, resolveMcpServers } from '../tools/index.js';
import type { McpLoadResult, SubagentSpawner } from '../tools/index.js';
import { MemorySessionStore, SessionStoreRegistry, usageDay } from '../storage/index.js';
import { AgentLoop } from './loop.js';
import { AgentRegistry } from './registry.js';
import { AgentRouter, planModelChain } from './router.js';
import { composeSystemPrompt } from './system-prompt.js';
import { createSubagentSpawner } from './subagent.js';
import { recallRelevantMemories } from '../memory/index.js';
import type {
  LoopRequest,
  RunTaskRequest,
  SessionStore,
  TaskEvent,
  TaskOutcome,
  TaskRow,
  TaskStatus,
  UsageAggregate,
} from './types.js';

/** 编排器构造参数。 */
export interface OrchestratorOptions {
  /** 配置文件路径；缺省走 resolveConfigPath 的探测顺序 */
  configPath?: string;
  /** 环境变量视图。测试传自造对象，避免读到本机第三方端点配置 */
  env?: EnvLike;
  /** 注入自定义 ProviderClient 工厂；测试用 MockProviderClient */
  factory?: ProviderFactory;
  /** true 时用内存存储，不落 SQLite（hap run --no-persist） */
  memoryStore?: boolean;
  /** 会话历史读取条数上限；缺省不限（由压缩机制兜住上下文） */
  historyLimit?: number;
}

/** 进行中任务的运行时句柄。 */
interface RunningTask {
  taskId: string;
  agentId: string;
  sessionKey: string;
  controller: AbortController;
  startedAt: string;
  /** 边收边攒的 trace 事件，收尾时落盘 */
  events: TraceEvent[];
}

/** /status 的回复载荷（FR-TASK-004）。 */
export interface SessionStatus {
  sessionKey: string;
  agentId: string;
  /** 生效的主模型全名 */
  model: string;
  /** 降级链（含主模型） */
  chain: string[];
  running: TaskRow[];
  recent: TaskRow[];
  /** 今日已用 token */
  todayTokens: number;
  dailyTokenBudget: number;
}

/** /trace 的回复载荷（FR-TASK-006）。 */
export interface TraceSummary {
  taskId: string;
  status: TaskStatus;
  filePath: string;
  /** 逐类事件计数，供快速判断卡在哪一环 */
  counts: Record<string, number>;
  route: string | undefined;
  protocol: string | undefined;
  models: string[];
  tools: Array<{ name: string; durationMs: number; isError: boolean }>;
  switches: Array<{ from: string; to: string; reason: string }>;
  usage: TokenUsage;
  iterations: number;
  error: string | undefined;
}

/** trace 事件按 kind 计数。 */
function countEvents(events: readonly TraceEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return counts;
}

/** 把 trace 事件流折叠成摘要（FR-TASK-006）。 */
export function summarizeTrace(taskId: string, row: TaskRow, events: readonly TraceEvent[]): TraceSummary {
  const models: string[] = [];
  const tools: Array<{ name: string; durationMs: number; isError: boolean }> = [];
  const switches: Array<{ from: string; to: string; reason: string }> = [];
  let route: string | undefined;
  let protocol: string | undefined;
  for (const event of events) {
    switch (event.kind) {
      case 'route':
        route = event.agentId + '（' + event.layer + (event.detail === undefined ? '' : '：' + event.detail) + '）';
        break;
      case 'protocol':
        protocol = event.protocol + '（来源 ' + event.source + '）';
        break;
      case 'request':
        if (!models.includes(event.model)) models.push(event.model);
        break;
      case 'tool':
        tools.push({ name: event.name, durationMs: event.durationMs, isError: event.isError });
        break;
      case 'model-switch':
        switches.push({ from: event.from, to: event.to, reason: event.reason });
        break;
      default:
        break;
    }
  }
  const summary: TraceSummary = {
    taskId,
    status: row.status,
    filePath: row.tracePath ?? '',
    counts: countEvents(events),
    route,
    protocol,
    models,
    tools,
    switches,
    usage: row.usage,
    iterations: row.iterations,
    error: row.error,
  };
  return summary;
}

export class AgentOrchestrator {
  private loaded: LoadedConfig;
  private resolver: ConfigResolver;
  readonly agents: AgentRegistry;
  private router: AgentRouter;
  private providers: ProviderRegistry;
  private readonly tools: ToolRegistry;
  private mcp: McpManager | undefined;
  /** MCP 加载结果；失败的服务器不阻断启动（FR-TOOL-002） */
  mcpResult: McpLoadResult | undefined;
  private readonly stores: SessionStoreRegistry;
  private readonly memoryStores = new Map<string, SessionStore>();
  private readonly options: OrchestratorOptions;
  private readonly env: EnvLike;
  private readonly running = new Map<string, RunningTask>();
  private paths: ResolvedPaths;
  private loop: AgentLoop;

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    const loadArgs: { path?: string } = {};
    if (options.configPath !== undefined) loadArgs.path = options.configPath;
    this.loaded = loadConfig(loadArgs);
    this.resolver = new ConfigResolver(this.loaded, {}, this.env as NodeJS.ProcessEnv);
    this.paths = this.resolver.resolvePaths();
    this.agents = new AgentRegistry({ resolver: this.resolver, configPath: this.loaded.path });
    this.router = new AgentRouter(this.resolver);
    this.providers = this.buildProviders();
    this.tools = ToolRegistry.builtin();
    this.stores = new SessionStoreRegistry((agentId) => this.agents.agent(agentId).agentDir);
    this.loop = new AgentLoop({ resolver: this.resolver, providers: this.providers, tools: this.tools });
    this.ensurePathDirs();
  }

  private ensurePathDirs(): void {
    for (const dir of [this.paths.dataDir, this.paths.traceDir, this.paths.overflowDir, this.paths.spoolDir]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** 配置文件绝对路径，供 CLI 打印。 */
  get configPath(): string {
    return this.loaded.path;
  }

  /** 当前解析器，供 CLI 的 explain / agent list 等只读命令复用。 */
  get config(): ConfigResolver {
    return this.resolver;
  }

  /** 提供商注册表，供 hap provider check 复用同一套凭据解析。 */
  get providerRegistry(): ProviderRegistry {
    return this.providers;
  }

  /** 工具注册表，供工具清单类命令复用。 */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** 已解析的数据目录。 */
  get resolvedPaths(): ResolvedPaths {
    return this.paths;
  }

  /**
   * 装载 MCP 工具（FR-TOOL-002）。
   *
   * 与构造函数分离是因为 MCP 要起子进程、必须异步；构造函数保持同步，
   * 让只读配置的 CLI 命令无需付启动 MCP 的代价。
   */
  async loadMcpTools(): Promise<McpLoadResult> {
    const specs = resolveMcpServers(this.loaded.config);
    if (specs.length === 0) {
      this.mcpResult = { modules: [], failures: [] };
      return this.mcpResult;
    }
    this.mcp = new McpManager(specs, this.env);
    const result = await this.mcp.listAll();
    this.tools.registerAll(result.modules);
    this.mcpResult = result;
    return result;
  }

  /**
   * 热重载配置（FR-CFG-005）。
   *
   * 进行中的任务持有旧 ResolvedAgent 值对象与旧 ProviderRegistry 引用，不受影响；
   * 新任务用新配置。提供商客户端整体重建，因为 base_url 与请求头可能已变。
   * 工具注册表不重建：MCP 子进程重启代价高，且工具集裁剪是按 agent 在
   * definitionsFor 时动态计算的，配置变更立即生效。
   */
  reload(): void {
    const loadArgs: { path?: string } = {};
    if (this.options.configPath !== undefined) loadArgs.path = this.options.configPath;
    this.loaded = loadConfig(loadArgs);
    this.resolver = new ConfigResolver(this.loaded, {}, this.env as NodeJS.ProcessEnv);
    this.paths = this.resolver.resolvePaths();
    this.agents.reload(this.resolver);
    this.router = new AgentRouter(this.resolver);
    this.providers = this.buildProviders();
    this.loop = new AgentLoop({ resolver: this.resolver, providers: this.providers, tools: this.tools });
    this.ensurePathDirs();
  }

  private buildProviders(): ProviderRegistry {
    const limits = this.resolver.resolveLimits();
    const registryOptions: {
      env: EnvLike;
      gates: ReturnType<typeof providerGateRegistry>;
      factory?: ProviderFactory;
    } = {
      env: this.env,
      gates: providerGateRegistry(limits),
    };
    if (this.options.factory !== undefined) registryOptions.factory = this.options.factory;
    return new ProviderRegistry(this.resolver.resolveProviders(), registryOptions);
  }

  /** 取某智能体的会话存储。memoryStore 模式下走内存实现。 */
  store(agentId: string): SessionStore {
    if (this.options.memoryStore !== true) return this.stores.store(agentId);
    const cached = this.memoryStores.get(agentId);
    if (cached !== undefined) return cached;
    const created = new MemorySessionStore();
    this.memoryStores.set(agentId, created);
    return created;
  }
  /**
   * 执行一次任务（FR-TASK-001/002/005/007）。
   *
   * 失败不抛异常而是返回 status 非 done 的 TaskOutcome：通道层只需要
   * 「有东西可回给用户」，把 HapError 的 userMessage 转成正文比让通道各自
   * try/catch 更省事。真正的编程错误（非 HapError）仍然向上抛。
   */
  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
    const decision = this.router.route(this.routeInput(request));
    const agent = this.agents.agent(decision.agentId);
    this.agents.ensureDirectories(agent.id);

    const sessionKey = request.sessionKey ?? 'cli:' + agent.id;
    const store = this.store(agent.id);
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    const events: TraceEvent[] = [];
    const onTrace = (event: TraceEvent): void => {
      events.push(event);
    };

    onTrace({
      kind: 'route',
      at: startedAt,
      agentId: agent.id,
      layer: decision.layer,
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    });

    const controller = new AbortController();
    const external = request.signal;
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const handle: RunningTask = {
      taskId,
      agentId: agent.id,
      sessionKey,
      controller,
      startedAt,
      events,
    };
    this.running.set(taskId, handle);

    const effectiveAgent: ResolvedAgent = { ...agent };
    if (request.model !== undefined && request.model !== '') {
      effectiveAgent.model = {
        primary: request.model,
        fallbacks: [],
      };
    }
    if (request.workspace !== undefined && request.workspace !== '') {
      effectiveAgent.workspace = request.workspace;
    }
    if (request.tools !== undefined) {
      effectiveAgent.tools = request.tools;
    }

    const chain = planModelChain(this.resolver, effectiveAgent);
    const primary = chain[0];
    const primaryName = primary === undefined ? '' : primary.fullName;

    const userMessage: AgentMessage = {
      role: 'user',
      content: decision.input,
      createdAt: startedAt,
    };
    if (request.attachments !== undefined && request.attachments.length > 0) {
      userMessage.attachments = request.attachments;
    }

    const row: TaskRow = {
      taskId,
      agentId: agent.id,
      sessionKey,
      status: 'running',
      startedAt,
      iterations: 0,
      usage: emptyUsage(),
      model: primaryName,
    };

    try {
      this.assertWithinDailyBudget(agent, store);
      store.beginTask(row);
      store.appendMessages(sessionKey, agent.id, [userMessage]);

      const history = [
        ...this.readHistory(store, sessionKey).filter((message) => message !== userMessage),
      ];
      // readHistory 已含刚写入的用户消息（同一 SQLite 事务已提交），无需重复追加；
      // 内存实现同理。这里再兜一层：历史为空说明存储未回读成功，则手工补上。
      if (history.length === 0) history.push(userMessage);

      let basePrompt = this.systemPromptFor(effectiveAgent);
      try {
        const memoryPrompt = await recallRelevantMemories(request.input, request.workspace);
        if (memoryPrompt) {
          basePrompt = `${memoryPrompt}\n${basePrompt}`;
        }
      } catch {
        // 记忆检索失败不阻断主流程
      }

      const loopRequest: LoopRequest = {
        agent: effectiveAgent,
        history,
        systemPrompt: basePrompt,
        taskId,
        signal: controller.signal,
        depth: request.depth ?? 0,
        paths: this.paths,
        env: this.env,
        spawn: this.spawner(),
        onTrace,
      };
      if (request.onEvent !== undefined) loopRequest.onEvent = request.onEvent;

      const result = await this.loop.run(loopRequest);
      const finishedAt = new Date().toISOString();

      store.appendMessages(sessionKey, agent.id, result.messages);
      this.recordUsage(store, effectiveAgent, result.model, result.usage, finishedAt);
      const tracePath = this.writeTrace(taskId, agent.id, sessionKey, startedAt, finishedAt, 'done', events);
      store.updateTask(taskId, {
        status: 'done',
        finishedAt,
        iterations: result.iterations,
        usage: result.usage,
        model: result.model,
        tracePath,
      });

      return { ...result, taskId, agentId: agent.id, sessionKey, status: 'done', tracePath };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const aborted = error instanceof HapError && error.code === 'TASK_ABORTED';
      const status: TaskStatus = aborted ? 'aborted' : 'failed';
      const reason = error instanceof HapError
        ? error.userMessage ?? error.message
        : describeError(error);
      onTrace({ kind: 'note', at: finishedAt, message: '任务终止：' + reason, data: { status } });
      const tracePath = this.writeTrace(taskId, agent.id, sessionKey, startedAt, finishedAt, status, events);
      store.updateTask(taskId, { status, finishedAt, error: reason, tracePath });
      if (!(error instanceof HapError)) throw error;
      return {
        text: '',
        reasoning: '',
        messages: [],
        usage: emptyUsage(),
        iterations: 0,
        model: primaryName,
        protocol: primary === undefined ? 'hermes-native' : primary.protocol,
        finishReason: 'error',
        stopReason: aborted ? 'aborted' : 'fallback_exhausted',
        retranslations: 0,
        taskId,
        agentId: agent.id,
        sessionKey,
        status,
        tracePath,
        error: reason,
      };
    } finally {
      this.running.delete(taskId);
    }
  }

  /** 把 RunTaskRequest 折成路由入参（FR-ROUTE-003 的四级优先级在 AgentRouter 内实现）。 */
  private routeInput(request: RunTaskRequest): {
    text: string;
    channelDefaultAgent?: string;
    explicitAgent?: string;
    mentionPatterns?: string[];
  } {
    const input: {
      text: string;
      channelDefaultAgent?: string;
      explicitAgent?: string;
      mentionPatterns?: string[];
    } = { text: request.input };
    if (request.agentId !== undefined) input.explicitAgent = request.agentId;
    if (request.channelDefaultAgent !== undefined) input.channelDefaultAgent = request.channelDefaultAgent;
    return input;
  }

  /** 组装 system 提示：身份段 + 职责段 + 子智能体段 + 环境段（FR-AGT-007）。 */
  private systemPromptFor(agent: ResolvedAgent): string {
    const subagents: Array<{ id: string; description: string }> = [];
    for (const id of agent.subagentAllow) {
      try {
        const child = this.agents.agent(id);
        subagents.push({ id: child.id, description: child.description });
      } catch {
        // 白名单里的智能体已被删除：跳过而不是让整个任务起不来
        continue;
      }
    }
    const options: { subagents?: Array<{ id: string; description: string }> } = {};
    if (subagents.length > 0) options.subagents = subagents;
    return composeSystemPrompt(agent, options);
  }

  /** 读会话历史，按 historyLimit 截断。 */
  private readHistory(store: SessionStore, sessionKey: string): AgentMessage[] {
    const limit = this.options.historyLimit;
    return limit === undefined ? store.history(sessionKey) : store.history(sessionKey, limit);
  }

  /** 日预算闸门（FR-TASK-007）。预算为 0 视为不限。 */
  private assertWithinDailyBudget(agent: ResolvedAgent, store: SessionStore): void {
    const budget = agent.limits.dailyTokenBudget;
    if (budget <= 0) return;
    const today = usageDay(new Date().toISOString());
    const used = store.dailyTokens(agent.id, today);
    if (used < budget) return;
    throw new FatalError(
      'BUDGET_EXHAUSTED',
      '智能体 ' + agent.id + ' 今日 token 预算已用尽：' + String(used) + '/' + String(budget),
      {
        userMessage: '智能体 ' + agent.id + ' 今日 token 预算已用尽（' + String(used) + '/' + String(budget)
          + '）。可调高 limits.daily_token_budget 或改派其他智能体。',
        context: { agentId: agent.id, used, budget },
      },
    );
  }

  /** 记录用量（FR-TASK-007 的三维度）。零用量不落行，避免统计表被空调用灌满。 */
  private recordUsage(
    store: SessionStore,
    agent: ResolvedAgent,
    modelFullName: string,
    usage: TokenUsage,
    at: string,
  ): void {
    if (usage.totalTokens <= 0 && usage.promptTokens <= 0 && usage.completionTokens <= 0) return;
    const slash = modelFullName.indexOf('/');
    const providerId = slash > 0 ? modelFullName.slice(0, slash) : modelFullName;
    store.recordUsage({ at, agentId: agent.id, providerId, model: modelFullName, usage });
  }
  /**
   * 构造子智能体派生器（FR-ROUTE-007）。
   *
   * 直接把自身当 runner 传给 createSubagentSpawner：派生出的子任务和顶层任务
   * 走完全相同的 runTask 路径，因此子智能体一样有降级、压缩、trace、用量统计。
   */
  private spawner(): SubagentSpawner {
    return createSubagentSpawner({ runTask: (request) => this.runTask(request) });
  }

  /**
   * 把 trace 落成 JSONL（FR-TASK-005/006）。
   *
   * 用 JSONL 而不是单个 JSON 对象：事件是追加型数据，逐行写在排查时可以
   * 直接 grep / tail，也不会因为文件写一半而整体不可解析。
   * 首行是任务级元信息，其后每行一个事件。
   */
  private writeTrace(
    taskId: string,
    agentId: string,
    sessionKey: string,
    startedAt: string,
    finishedAt: string,
    status: TaskStatus,
    events: readonly TraceEvent[],
  ): string {
    const filePath = join(this.paths.traceDir, taskId + '.jsonl');
    const header = { taskId, agentId, sessionKey, startedAt, finishedAt, status, filePath };
    const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    return filePath;
  }

  /**
   * 中止任务（FR-TASK-003）。
   *
   * 只触发 AbortController：未完成的工具执行由 ToolExecutor 在信号上取消，
   * 已产生的中间结果与 trace 由 runTask 的 catch 分支落盘。
   *
   * @returns 是否确有该进行中任务
   */
  abort(taskId: string): boolean {
    const handle = this.running.get(taskId);
    if (handle === undefined) return false;
    handle.controller.abort();
    return true;
  }

  /**
   * 中止某会话的全部进行中任务（/stop 的实际语义：用户不知道 taskId）。
   *
   * @returns 被中止的任务 id 列表
   */
  abortSession(sessionKey: string): string[] {
    const stopped: string[] = [];
    for (const handle of this.running.values()) {
      if (handle.sessionKey !== sessionKey) continue;
      handle.controller.abort();
      stopped.push(handle.taskId);
    }
    return stopped;
  }

  /** 当前进程内进行中的任务快照。 */
  runningTasks(): Array<{ taskId: string; agentId: string; sessionKey: string; startedAt: string }> {
    return [...this.running.values()].map((handle) => ({
      taskId: handle.taskId,
      agentId: handle.agentId,
      sessionKey: handle.sessionKey,
      startedAt: handle.startedAt,
    }));
  }

  /**
   * 会话状态（FR-TASK-004）。
   *
   * agentId 的取法：优先用该会话最近一次任务的智能体，没有历史任务时
   * 回落到路由结果（空指令走通道绑定或全局默认）。这样 /status 在会话刚建立、
   * 还没跑过任务时也有合理答案。
   */
  status(sessionKey: string, channelDefaultAgent?: string): SessionStatus {
    const routeArgs: { text: string; channelDefaultAgent?: string } = { text: '' };
    if (channelDefaultAgent !== undefined) routeArgs.channelDefaultAgent = channelDefaultAgent;
    let agentId = this.router.route(routeArgs).agentId;

    // 会话历史里最近一次任务的智能体优先：会话是绑在智能体上的
    for (const candidate of this.agents.agentIds()) {
      const rows = this.store(candidate).tasksBySession(sessionKey);
      const first = rows[0];
      if (first !== undefined) {
        agentId = first.agentId;
        break;
      }
    }

    const agent = this.agents.agent(agentId);
    const store = this.store(agentId);
    const chain = planModelChain(this.resolver, agent).map((plan) => plan.fullName);
    const all = store.tasksBySession(sessionKey);
    const running = all.filter((row) => row.status === 'running');
    const today = usageDay(new Date().toISOString());
    return {
      sessionKey,
      agentId,
      model: chain[0] ?? '',
      chain,
      running,
      recent: all.slice(0, 5),
      todayTokens: store.dailyTokens(agentId, today),
      dailyTokenBudget: agent.limits.dailyTokenBudget,
    };
  }

  /**
   * 取任务的 trace 摘要（FR-TASK-006）。
   *
   * 进行中任务读内存里的事件数组（还没落盘），已结束任务读 JSONL。
   * 找不到任务时返回 undefined，由调用方决定提示文案。
   */
  trace(taskId: string): TraceSummary | undefined {
    const live = this.running.get(taskId);
    if (live !== undefined) {
      const row: TaskRow = {
        taskId,
        agentId: live.agentId,
        sessionKey: live.sessionKey,
        status: 'running',
        startedAt: live.startedAt,
        iterations: 0,
        usage: emptyUsage(),
        model: '',
        tracePath: join(this.paths.traceDir, taskId + '.jsonl'),
      };
      return summarizeTrace(taskId, row, live.events);
    }
    for (const agentId of this.agents.agentIds()) {
      const row = this.store(agentId).task(taskId);
      if (row === undefined) continue;
      const events = readTraceFile(row.tracePath);
      return summarizeTrace(taskId, row, events);
    }
    return undefined;
  }

  /** 找任务记录，跨全部智能体的会话库查找。 */
  findTask(taskId: string): TaskRow | undefined {
    for (const agentId of this.agents.agentIds()) {
      const row = this.store(agentId).task(taskId);
      if (row !== undefined) return row;
    }
    return undefined;
  }

  /**
   * 崩溃恢复（FR-TASK-008）。
   *
   * 启动期调用：把各智能体会话库里残留的 running 任务标记为 interrupted。
   * 返回被标记的记录，由通道层向其来源会话发出中断通知。
   */
  recoverInterrupted(): TaskRow[] {
    if (this.options.memoryStore === true) return [];
    return this.stores.markInterrupted(this.agents.agentIds());
  }

  /** 用量统计（FR-TASK-007）。since 为 ISO 时间戳。 */
  usageSince(since: string): UsageAggregate[] {
    if (this.options.memoryStore !== true) return this.stores.usageSince(since, this.agents.agentIds());
    const merged: UsageAggregate[] = [];
    for (const agentId of this.agents.agentIds()) merged.push(...this.store(agentId).usageSince(since));
    return merged.sort((left, right) => right.totalTokens - left.totalTokens);
  }

  /** 清理过期会话数据，返回删除的消息条数。 */
  prune(retentionDays?: number): number {
    const days = retentionDays ?? this.resolver.resolveLimits().sessionRetentionDays;
    if (this.options.memoryStore === true) {
      let removed = 0;
      for (const agentId of this.agents.agentIds()) removed += this.store(agentId).prune(days);
      return removed;
    }
    return this.stores.prune(days, this.agents.agentIds());
  }

  /** 关闭全部资源：MCP 子进程、SQLite 连接。 */
  async close(): Promise<void> {
    for (const handle of this.running.values()) handle.controller.abort();
    this.running.clear();
    if (this.mcp !== undefined) await this.mcp.close();
    this.stores.close();
    for (const store of this.memoryStores.values()) store.close();
    this.memoryStores.clear();
  }
}

/** 读回落盘的 trace JSONL。首行是元信息，跳过。 */
function readTraceFile(filePath: string | undefined): TraceEvent[] {
  if (filePath === undefined || filePath === '') return [];
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const events: TraceEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // 单行损坏不应让整个 trace 读不出来
      continue;
    }
  }
  return events;
}

/** 从事件流里抽出全部通知类文本，供通道层拼「过程说明」。 */
export function noticesOf(events: readonly TaskEvent[]): string[] {
  return events.filter((event): event is Extract<TaskEvent, { type: 'notice' }> => event.type === 'notice')
    .map((event) => event.message);
}
