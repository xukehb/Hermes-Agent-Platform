/**
 * 智能体注册表与生命周期管理（FR-AGT-001/002/003/005/006/008）。
 *
 * 职责：
 * - 把配置解析器输出的 ResolvedAgent 实例化为运行时条目（workspace + agentDir 初始化）。
 * - 按 id 索引，统一提供「取一个 / 全部 ids / 全部条目」三种查询。
 * - 通过 ConfigWriter 提供「创建 / 更新 / 移除」三种写操作；写后立即重新加载。
 * - 唯一性约束：createAgent 时若 id 已存在抛 ConfigError（FR-AGT-008）。
 * - 移除时保留会话库与目录，仅修改配置（FR-AGT-006）。
 *
 * AgentRegistry 持有 ConfigResolver 快照：热重载时调用 reload(newResolver)，
 * 进行中的任务持有旧的 ResolvedAgent 值对象，不受影响（FR-CFG-005 语义）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { mkdirSync } from 'node:fs';
import { ConfigError } from '../domain/index.js';
import { ConfigResolver, ConfigWriter, loadConfig } from '../config/index.js';
import type { ResolvedAgent } from '../config/index.js';
import type { AgentPatch, WriteResult } from '../config/writer.js';

/** 注册表构造参数。 */
export interface AgentRegistryOptions {
  /**
   * 初始配置解析器。热重载时由调用方负责传入新解析器并调用 registry.reload()。
   * 若不传，注册表在需要时自行从 configPath 加载（用于测试场景）。
   */
  resolver: ConfigResolver;
  /** 配置文件绝对路径，供 ConfigWriter 写回使用。 */
  configPath: string;
}

/**
 * 智能体注册表。
 *
 * 设计取舍：注册表本身不监听文件变更，由 Orchestrator / CLI 负责在
 * 配置变更时调用 reload()，让测试可以绕过文件系统。
 */
export class AgentRegistry {
  private resolver: ConfigResolver;
  readonly writer: ConfigWriter;
  /** 已初始化目录的 id 集合，避免重复 mkdirSync。 */
  private readonly initialized = new Set<string>();

  constructor(options: AgentRegistryOptions) {
    this.resolver = options.resolver;
    this.writer = new ConfigWriter(options.configPath);
  }

  /**
   * 取某个智能体的解析结果。
   *
   * 内部委托给 resolver.resolveAgent()，id 不存在时抛 ConfigError('AGENT_NOT_FOUND')。
   */
  agent(id: string): ResolvedAgent {
    return this.resolver.resolveAgent(id);
  }

  /** 所有已声明的智能体 id，顺序与配置文件一致。 */
  agentIds(): string[] {
    return this.resolver.listAgentIds();
  }

  /** 所有智能体的解析结果，按 id 字典序。 */
  allAgents(): ResolvedAgent[] {
    return this.resolver.resolveAllAgents();
  }

  /**
   * 确保智能体的 workspace 与 agentDir 存在（FR-AGT-002）。
   *
   * 每个 id 在进程生命周期内只初始化一次；热重载后若路径变更则
   * 需先调用 reload() 再调用本方法。
   */
  ensureDirectories(agentId: string): void {
    if (this.initialized.has(agentId)) return;
    const agent = this.resolver.resolveAgent(agentId);
    mkdirSync(agent.workspace, { recursive: true });
    mkdirSync(agent.agentDir, { recursive: true });
    this.initialized.add(agentId);
  }

  /**
   * 热重载：用新的解析器替换当前实例（FR-CFG-005）。
   *
   * 进行中的任务持有旧 ResolvedAgent 值对象，不受影响。
   * 已初始化的目录集合保留，不清空。
   */
  reload(resolver: ConfigResolver): void {
    this.resolver = resolver;
  }

  /**
   * 新建智能体（FR-AGT-001/004/005/008）。
   *
   * id 已存在时抛 ConfigError('AGENT_CONFLICT')（FR-AGT-008）。
   * 写入配置后立即初始化目录，调用方可随即建会话库。
   *
   * @param id       唯一标识，建议 kebab-case，如 coder / my-agent
   * @param patch    字段覆盖；name 缺省时取 id
   * @param template 可选内置模板（coder/researcher/writer/ops/vision）（FR-AGT-005）
   */
  createAgent(id: string, patch: AgentPatch, template?: string): WriteResult & { agent: ResolvedAgent } {
    if (this.resolver.listAgentIds().includes(id)) {
      throw new ConfigError(
        'CONFIG_CONFLICT',
        '智能体 "' + id + '" 已存在（FR-AGT-008）。如需更新请用 updateAgent。',
        { agentId: id },
      );
    }
    const patchWithName: AgentPatch = { ...patch };
    if (patchWithName.name === undefined) patchWithName.name = id;
    const result = this.writer.upsertAgent(id, patchWithName, template);
    this.resolverReloadFromDisk();
    this.ensureDirectories(id);
    const agent = this.resolver.resolveAgent(id);
    return { ...result, agent };
  }

  /**
   * 更新已有智能体（FR-AGT-006）。
   *
   * 仅覆盖 patch 中非 undefined 的字段，其余保留原值。
   * id 不存在时抛 ConfigError('AGENT_NOT_FOUND')。
   */
  updateAgent(id: string, patch: AgentPatch): WriteResult & { agent: ResolvedAgent } {
    if (!this.resolver.listAgentIds().includes(id)) {
      throw new ConfigError('AGENT_NOT_FOUND', '找不到智能体 "' + id + '"。', { agentId: id });
    }
    const result = this.writer.upsertAgent(id, patch);
    this.resolverReloadFromDisk();
    const agent = this.resolver.resolveAgent(id);
    return { ...result, agent };
  }

  /**
   * 移除智能体（FR-AGT-006）。
   *
   * 仅写配置，不删目录与会话库——会话库归档供历史查阅。
   * ConfigWriter.removeAgent 自动清理该 id 的交叉引用。
   *
   * @returns WriteResult 附带 archivedDir——agentDir 路径，供 CLI 告知用户
   */
  removeAgent(id: string): WriteResult & { archivedDir: string } {
    const agent = this.resolver.resolveAgent(id); // 先取，移除后无法再解析
    const archivedDir = agent.agentDir;
    const result = this.writer.removeAgent(id);
    this.resolverReloadFromDisk();
    this.initialized.delete(id);
    return { ...result, archivedDir };
  }

  /**
   * 写操作后从磁盘重新加载配置，刷新 resolver。
   *
   * 仅在 createAgent / updateAgent / removeAgent 后调用。
   * 不对外暴露——外部热重载走 reload(resolver)，由调用方管理生命周期。
   */
  private resolverReloadFromDisk(): void {
    const loaded = loadConfig({ path: this.writer.path });
    // 保持与当前 resolver 相同的 CLI overrides（空）和 env（process.env）：
    // 写操作通常来自 CLI 命令，无需携带运行时覆盖。
    this.resolver = new ConfigResolver(loaded);
  }
}
