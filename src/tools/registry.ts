/**
 * 工具注册表（FR-TOOL-001/002/003/006）。
 *
 * 注册表只做三件事：收拢工具、消解撞名、按智能体裁剪。
 * 撞名策略是后来者退让并改名为 <source>__<name>，而不是覆盖或直接报错，
 * 因为 MCP 服务器的工具名不受本地控制，一次撞名就让整个进程起不来是不可接受的。
 * 所有改名进入 renames() 供 trace 记录。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ResolvedAgent } from '../config/resolved.js';
import type { ToolDefinition } from '../domain/index.js';
import { builtinTools } from './builtin/index.js';
import { MCP_NAME_SEPARATOR } from './mcp.js';
import { selectToolNames } from './selection.js';
import type { ToolModule, ToolRename } from './types.js';

export class ToolRegistry {
  private readonly modules = new Map<string, ToolModule>();
  /** 注册顺序即注入模型的顺序，内置工具先于 MCP 工具 */
  private readonly order: string[] = [];
  private readonly renameLog: ToolRename[] = [];

  /** 只含内置工具的注册表，测试与不配 MCP 的场景直接用它。 */
  static builtin(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerAll(builtinTools());
    return registry;
  }

  /** 注册单个工具，返回真正落库的模块（可能已改名）。 */
  register(module: ToolModule): ToolModule {
    const requested = module.definition.name;
    const source = module.definition.source;
    const original = module.renamedFrom ?? requested;

    if (module.renamedFrom !== undefined && module.renamedFrom !== requested) {
      this.renameLog.push({ from: module.renamedFrom, to: requested, source, reason: 'mcp-namespace' });
    }

    let finalName = requested;
    if (this.modules.has(finalName)) {
      finalName = this.disambiguate(requested, source);
      this.renameLog.push({ from: requested, to: finalName, source, reason: 'collision' });
    }

    const stored: ToolModule = finalName === requested
      ? module
      : { ...module, definition: { ...module.definition, name: finalName }, renamedFrom: original };
    this.modules.set(finalName, stored);
    this.order.push(finalName);
    return stored;
  }

  registerAll(modules: readonly ToolModule[]): ToolModule[] {
    return modules.map((module) => this.register(module));
  }

  has(name: string): boolean {
    return this.modules.has(name);
  }

  get(name: string): ToolModule | undefined {
    return this.modules.get(name);
  }

  get size(): number {
    return this.modules.size;
  }

  /** 全部工具名，按注册顺序。 */
  names(): string[] {
    return [...this.order];
  }

  /** 全部工具声明，按注册顺序。 */
  definitions(): ToolDefinition[] {
    const list: ToolDefinition[] = [];
    for (const name of this.order) {
      const module = this.modules.get(name);
      if (module !== undefined) list.push(module.definition);
    }
    return list;
  }

  /** 某智能体最终可见的工具名（档位 + allow/deny 裁剪后）。 */
  namesFor(agent: ResolvedAgent): string[] {
    return selectToolNames(agent.tools, this.definitions());
  }

  /** 某智能体最终可见的工具声明，顺序与注册顺序一致。 */
  definitionsFor(agent: ResolvedAgent): ToolDefinition[] {
    const selected = new Set(this.namesFor(agent));
    return this.definitions().filter((definition) => selected.has(definition.name));
  }

  /** 改名记录（前缀注入 + 撞名退让）。 */
  renames(): ToolRename[] {
    return [...this.renameLog];
  }

  /** 撞名时的候选名：先加来源前缀，仍撞则追加序号。 */
  private disambiguate(name: string, source: string): string {
    const prefix = source + MCP_NAME_SEPARATOR;
    const base = name.startsWith(prefix) ? name : prefix + name;
    if (!this.modules.has(base)) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = base + '_' + suffix;
      if (!this.modules.has(candidate)) return candidate;
    }
    return base + '_' + Date.now();
  }
}
