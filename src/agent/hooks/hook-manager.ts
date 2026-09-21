/**
 * 智能体生命周期钩子管理器 (HookManager)
 *
 * 借鉴 Reasonix.io 架构，为智能体执行提供完整的可扩展生命周期钩子：
 * - pre_task: 任务启动前（环境准备、参数审查、权限初筛）
 * - post_task: 任务完成后（执行审计、自动留痕、外部集成）
 * - pre_tool: 工具调用前（沙箱拦截、破坏性命令阻断、动态放行裁决）
 * - post_tool: 工具调用后（副作用跟踪、结果脱敏、耗时统计）
 * - on_error: 运行异常时（错误处理、自愈与告警）
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { WorkspaceSandbox, type SandboxCheckResult } from '../../tools/sandbox/workspace-sandbox.js';

export type HookName = 'pre_task' | 'post_task' | 'pre_tool' | 'post_tool' | 'on_error';

export interface PreTaskPayload {
  taskId: string;
  agentId: string;
  input: string;
  workspace?: string | undefined;
}

export interface PostTaskPayload {
  taskId: string;
  agentId: string;
  durationMs?: number | undefined;
  iterations?: number | undefined;
  status: string;
}

export interface PreToolPayload {
  taskId: string;
  agentId?: string | undefined;
  toolName?: string | undefined;
  params?: Record<string, unknown> | undefined;
  call?: { name: string; args: Record<string, unknown> } | undefined;
  workspace?: string | undefined;
}

export interface PostToolPayload {
  taskId: string;
  name: string;
  isError: boolean;
  contentLength: number;
}

export interface OnErrorPayload {
  taskId: string;
  error: Error;
  phase: string;
}

export type HookCallback<T = unknown> = (payload: T) => Promise<unknown> | unknown;

export class HookManager {
  private static instance: HookManager | null = null;
  private listeners: Map<HookName, Set<HookCallback<any>>> = new Map();

  constructor() {
    // 注册内置默认 pre_tool 钩子：工作区沙箱安全守护
    this.on<PreToolPayload>('pre_tool', (payload) => {
      const toolName = payload.call?.name || payload.toolName || '';
      const params = payload.call?.args || payload.params || {};
      const workspace = payload.workspace || process.cwd();
      const check = WorkspaceSandbox.check(toolName, params, workspace);
      if (!check.allow) {
        return check;
      }
      return { allow: true, allowed: true };
    });
  }

  static getInstance(): HookManager {
    if (!HookManager.instance) {
      HookManager.instance = new HookManager();
    }
    return HookManager.instance;
  }

  /** 注册生命周期监听器 */
  on<T = unknown>(name: HookName, callback: HookCallback<T>): () => void {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Set());
    }
    this.listeners.get(name)!.add(callback as HookCallback<any>);
    return () => {
      this.listeners.get(name)?.delete(callback as HookCallback<any>);
    };
  }

  /** 别名：注册生命周期监听器 */
  registerHook<T = unknown>(name: HookName, callback: HookCallback<T>): () => void {
    return this.on(name, callback);
  }

  /** 触发 pre_task 钩子 */
  async triggerPreTask(payload: PreTaskPayload): Promise<void> {
    await this.runCallbacks('pre_task', payload);
    await this.runExternalScripts('pre_task', payload.workspace, payload);
  }

  /** 触发 post_task 钩子 */
  async triggerPostTask(payload: PostTaskPayload, workspace?: string): Promise<void> {
    await this.runCallbacks('post_task', payload);
    await this.runExternalScripts('post_task', workspace, payload);
  }

  /** 触发 pre_tool 钩子，返回是否放行 */
  async triggerPreTool(payload: PreToolPayload): Promise<SandboxCheckResult> {
    const cbs = this.listeners.get('pre_tool');
    if (cbs) {
      for (const cb of cbs) {
        try {
          const res = (await cb(payload)) as SandboxCheckResult | undefined;
          if (res && (res.allow === false || res.allowed === false)) {
            return {
              allow: false,
              allowed: false,
              reason: res.reason,
              isReadOnly: res.isReadOnly,
            };
          }
        } catch (err) {
          return {
            allow: false,
            allowed: false,
            reason: `pre_tool 钩子执行异常: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
    return { allow: true, allowed: true };
  }

  /** 触发 post_tool 钩子 */
  async triggerPostTool(payload: PostToolPayload, workspace?: string): Promise<void> {
    await this.runCallbacks('post_tool', payload);
    await this.runExternalScripts('post_tool', workspace, payload);
  }

  /** 触发 on_error 钩子 */
  async triggerOnError(payload: OnErrorPayload, workspace?: string): Promise<void> {
    await this.runCallbacks('on_error', payload);
    await this.runExternalScripts('on_error', workspace, payload);
  }

  private async runCallbacks(name: HookName, payload: unknown): Promise<void> {
    const cbs = this.listeners.get(name);
    if (!cbs || cbs.size === 0) return;
    for (const cb of cbs) {
      try {
        await cb(payload);
      } catch {
        // 外部钩子执行异常不阻断主流程
      }
    }
  }

  /** 扫描 ~/.hap/hooks/ 与 <workspace>/.hap/hooks/ 中的外部脚本并执行 */
  private async runExternalScripts(name: HookName, workspace: string | undefined, payload: unknown): Promise<void> {
    const hookDirs: string[] = [join(homedir(), '.hap', 'hooks')];
    if (workspace && existsSync(workspace)) {
      hookDirs.unshift(join(workspace, '.hap', 'hooks'));
    }

    const payloadJson = JSON.stringify(payload);
    for (const dir of hookDirs) {
      if (!existsSync(dir)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        // 匹配前缀名，例如 pre_tool.sh, pre_tool.js, post_task.py
        if (file.startsWith(name)) {
          const fullPath = join(dir, file);
          try {
            if (file.endsWith('.sh')) {
              await execa('sh', [fullPath, payloadJson], { timeout: 5000, reject: false });
            } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
              await execa('node', [fullPath, payloadJson], { timeout: 5000, reject: false });
            } else if (file.endsWith('.py')) {
              await execa('python3', [fullPath, payloadJson], { timeout: 5000, reject: false });
            }
          } catch {
            // 脚本超时或出错容错
          }
        }
      }
    }
  }
}
