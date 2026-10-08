/**
 * 后台长进程与常驻服务管理器（FR-TOOL-001 增强）。
 *
 * 解决长时间运行的服务（如 npm run dev、docker compose、微服务等）
 * 导致工具调用超时或无法在后台常驻、无法检查状态与标准输入交互的问题。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../define.js';

export interface ManagedProcessInfo {
  id: string;
  command: string;
  cwd: string;
  pid?: number | undefined;
  status: 'running' | 'stopped' | 'failed';
  exitCode?: number | null | undefined;
  startedAt: string;
  endedAt?: string | undefined;
}

export class ManagedProcess {
  public readonly id: string;
  public readonly command: string;
  public readonly cwd: string;
  public pid?: number | undefined;
  public status: 'running' | 'stopped' | 'failed' = 'running';
  public exitCode: number | null = null;
  public readonly startedAt: string;
  public endedAt?: string | undefined;

  private readonly outputLines: string[] = [];
  private readonly maxLines = 1000;
  public child?: ChildProcess;

  constructor(id: string, command: string, cwd: string) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;
    this.startedAt = new Date().toISOString();
  }

  public appendOutput(data: string | Buffer): void {
    const text = data.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0 || this.outputLines.length > 0) {
        this.outputLines.push(line);
        if (this.outputLines.length > this.maxLines) {
          this.outputLines.shift();
        }
      }
    }
  }

  public getRecentLines(count = 50): string[] {
    return this.outputLines.slice(-Math.min(count, this.outputLines.length));
  }

  public getRecentOutput(count = 50): string {
    return this.getRecentLines(count).join('\n');
  }

  public toInfo(): ManagedProcessInfo {
    const info: ManagedProcessInfo = {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      status: this.status,
      startedAt: this.startedAt,
    };
    if (this.pid !== undefined) info.pid = this.pid;
    if (this.exitCode !== null) info.exitCode = this.exitCode;
    if (this.endedAt !== undefined) info.endedAt = this.endedAt;
    return info;
  }
}

export class ProcessManager {
  private static instance: ProcessManager | undefined;
  private processes = new Map<string, ManagedProcess>();
  private counter = 0;

  public static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  public spawnDaemon(command: string, cwd: string, env?: NodeJS.ProcessEnv): ManagedProcess {
    this.counter += 1;
    const id = `proc_${Date.now()}_${this.counter}`;
    const proc = new ManagedProcess(id, command, cwd);

    const isPosix = process.platform !== 'win32';
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: isPosix,
    });

    proc.child = child;
    proc.pid = child.pid;

    child.stdout?.on('data', (data) => proc.appendOutput(data));
    child.stderr?.on('data', (data) => proc.appendOutput(data));

    child.on('close', (code) => {
      proc.status = code === 0 ? 'stopped' : 'failed';
      proc.exitCode = code;
      proc.endedAt = new Date().toISOString();
    });

    child.on('error', (err) => {
      proc.status = 'failed';
      proc.appendOutput(`进程异常: ${err.message}`);
      proc.endedAt = new Date().toISOString();
    });

    this.processes.set(id, proc);
    return proc;
  }

  public list(): ManagedProcessInfo[] {
    return Array.from(this.processes.values()).map((p) => p.toInfo());
  }

  public get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  public kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const proc = this.processes.get(id);
    if (!proc || !proc.child || proc.status !== 'running') {
      return false;
    }
    try {
      if (proc.pid && process.platform !== 'win32') {
        try {
          process.kill(-proc.pid, signal);
        } catch {
          proc.child.kill(signal);
        }
      } else {
        proc.child.kill(signal);
      }
      return true;
    } catch {
      return false;
    }
  }

  public sendInput(id: string, input: string): boolean {
    const proc = this.processes.get(id);
    if (!proc || !proc.child || proc.status !== 'running' || !proc.child.stdin) {
      return false;
    }
    try {
      proc.child.stdin.write(input.endsWith('\n') ? input : input + '\n');
      return true;
    } catch {
      return false;
    }
  }

  public clear(): void {
    for (const proc of this.processes.values()) {
      if (proc.status === 'running' && proc.child) {
        try {
          if (proc.pid && process.platform !== 'win32') {
            try {
              process.kill(-proc.pid, 'SIGKILL');
            } catch {
              proc.child.kill('SIGKILL');
            }
          } else {
            proc.child.kill('SIGKILL');
          }
        } catch {}
      }
    }
    this.processes.clear();
  }
}

export const processManager = ProcessManager.getInstance();

export const processManagerTool = defineTool({
  name: 'process_manager',
  description: '管理后台长常驻进程：列出运行中的进程、查看实时输出日志、向 stdin 发送输入、或终止进程。',
  schema: z.object({
    action: z.enum(['list', 'status', 'kill', 'send_input']).describe('操作类型：list（列出所有常驻进程）、status（查看状态与日志）、kill（终止进程）、send_input（发送标准输入）'),
    process_id: z.string().optional().describe('后台进程 ID（action 为 status/kill/send_input 时必填）'),
    input: z.string().optional().describe('向进程 stdin 发送的文本（action 为 send_input 时必填）'),
    lines: z.number().int().positive().optional().default(50).describe('查看日志时的行数，默认 50 行'),
  }),
  run: async (args) => {
    const pm = ProcessManager.getInstance();

    if (args.action === 'list') {
      const list = pm.list();
      if (list.length === 0) {
        return { content: '当前没有运行或记录的后台常驻进程。' };
      }
      const formatted = list.map((item, index) => {
        return `[${index + 1}] ID: ${item.id} | PID: ${item.pid ?? '未知'} | 状态: ${item.status}\n    命令: ${item.command}\n    目录: ${item.cwd}\n    启动时间: ${item.startedAt}`;
      });
      return { content: `【后台常驻进程列表（共 ${list.length} 个）】\n${formatted.join('\n\n')}` };
    }

    if (!args.process_id) {
      return { content: '错误：缺少必须的 process_id 参数。', isError: true };
    }

    const proc = pm.get(args.process_id);
    if (!proc) {
      return { content: `未找到 ID 为 "${args.process_id}" 的后台进程。`, isError: true };
    }

    if (args.action === 'kill') {
      if (proc.status !== 'running') {
        return { content: `进程 ${args.process_id} 已经处于 ${proc.status} 状态，无需终止。` };
      }
      const ok = pm.kill(args.process_id);
      return {
        content: ok ? `已向进程 ${args.process_id} 发送终止信号。` : `终止进程 ${args.process_id} 失败。`,
        isError: !ok,
      };
    }

    if (args.action === 'send_input') {
      if (!args.input) {
        return { content: '错误：缺少必须的 input 内容。', isError: true };
      }
      if (proc.status !== 'running') {
        return { content: `进程 ${args.process_id} 不在运行状态，无法发送输入。`, isError: true };
      }
      const ok = pm.sendInput(args.process_id, args.input);
      return {
        content: ok ? `已向进程 ${args.process_id} 发送输入内容。` : `发送输入至进程 ${args.process_id} 失败。`,
        isError: !ok,
      };
    }

    // status 操作
    const logs = proc.getRecentOutput(args.lines ?? 50);
    const content = `【进程状态】\nID: ${proc.id}\nPID: ${proc.pid ?? '未知'}\n状态: ${proc.status}\n命令: ${proc.command}\n目录: ${proc.cwd}\n启动时间: ${proc.startedAt}${proc.endedAt ? '\n结束时间: ' + proc.endedAt : ''}${proc.exitCode !== null ? '\n退出码: ' + proc.exitCode : ''}\n\n【最新日志输出（至多 ${args.lines ?? 50} 行）】\n${logs.trim() === '' ? '（暂无输出）' : logs}`;
    return { content };
  },
});
