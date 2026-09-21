/**
 * 工作区沙箱与安全守卫 (WorkspaceSandbox)
 *
 * 借鉴 Reasonix 与现代安全 Agent 设计：
 * 1. 约束文件写入必须落在指定工作区目录内部，防止路径遍历逃逸（如 ../../etc/passwd）；
 * 2. 识别并拦截毁灭性系统 Shell 命令（如 rm -rf /、磁盘格式化等）；
 * 3. 区分只读安全工具（自动放行）与具副作用工具（受控审查）。
 */

import { isAbsolute, normalize, relative, resolve } from 'node:path';

export interface SandboxCheckResult {
  allow: boolean;
  allowed?: boolean | undefined;
  reason?: string | undefined;
  isReadOnly?: boolean | undefined;
}

const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'search',
  'http_fetch',
  'find_definition',
  'find_references',
  'list_symbols',
  'host_sysinfo',
  'remote_sysinfo',
  'remote_list_servers',
  'ip_lookup',
  'web_search',
  'activate_skill',
  'browser_get_content',
  'desktop_screen_size',
  'desktop_screenshot',
  'desktop_window_list',
]);

const SENSITIVE_SYSTEM_PATHS = [
  '/etc/shadow',
  '/etc/master.passwd',
  '/System/Library',
  '/System/Volumes',
  '/Windows/System32/config',
];

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-(?:r|rf|fr)\s+[\/\\]\s*$/i,
  /\brm\s+-(?:r|rf|fr)\s+[\/\\]\*/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\/(?:sd|hd|nvme)/i,
  /\bformat\s+[a-z]:\s*\/y/i,
  /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, // Fork bomb
  /\bchmod\s+-R\s+777\s+[\/\\]\s*$/i,
];

export class WorkspaceSandbox {
  /** 校验某路径是否在工作区允许范围内 */
  static isPathAllowed(rawPath: string, workspace: string): { allowed: boolean; reason?: string } {
    if (!rawPath) return { allowed: true };
    const fullPath = isAbsolute(rawPath) ? normalize(rawPath) : resolve(workspace, rawPath);
    const normWorkspace = normalize(workspace);

    // 严禁直接引用系统高度敏感文件
    for (const sens of SENSITIVE_SYSTEM_PATHS) {
      if (fullPath === sens || fullPath.startsWith(sens + '/')) {
        return {
          allowed: false,
          reason: `沙箱高危路径拦截：禁止访问或修改系统核心敏感路径 "${fullPath}"`,
        };
      }
    }

    const rel = relative(normWorkspace, fullPath);
    // 如果路径以 .. 开头或跨驱动器，说明逃逸出了工作区
    if (rel.startsWith('..') || isAbsolute(rel)) {
      const isTmp = fullPath.startsWith('/tmp') || fullPath.startsWith('/private/tmp') || fullPath.includes('Temp') || fullPath.includes('.hap');
      if (!isTmp) {
        return {
          allowed: false,
          reason: `工作区沙箱越界拦截：尝试访问工作区外部路径 "${fullPath}"，当前工作区为 "${normWorkspace}"`,
        };
      }
    }

    return { allowed: true };
  }

  /** 检测是否为毁灭性高危 Shell 指令 */
  static isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
    if (!command) return { dangerous: false };
    for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return {
          dangerous: true,
          reason: `沙箱高危指令拦截：检测到具有毁灭性的系统命令模式 "${command}"，已被拒绝执行。`,
        };
      }
    }
    return { dangerous: false };
  }

  /** 判断工具是否属于只读无副作用安全工具 */
  static isReadOnlyTool(toolName: string): boolean {
    return READ_ONLY_TOOL_NAMES.has(toolName);
  }

  /** 校验工具调用是否符合沙箱安全规范 */
  static check(
    toolName: string,
    args: Record<string, unknown>,
    workspace: string,
  ): SandboxCheckResult {
    const isReadOnly = this.isReadOnlyTool(toolName);

    // 1. 只读工具一律视为安全放行
    if (isReadOnly) {
      return { allow: true, allowed: true, isReadOnly: true };
    }

    // 2. 校验文件写入类工具（write_file, apply_patch）
    if (toolName === 'write_file' || toolName === 'apply_patch') {
      const rawPath = typeof args.path === 'string' ? args.path : '';
      if (rawPath) {
        const pathCheck = this.isPathAllowed(rawPath, workspace);
        if (!pathCheck.allowed) {
          return {
            allow: false,
            allowed: false,
            reason: pathCheck.reason,
            isReadOnly: false,
          };
        }
      }
    }

    // 3. 校验 Shell 命令行危险行为
    if (toolName === 'shell' || toolName === 'remote_exec') {
      const command = typeof args.command === 'string' ? args.command : '';
      const cmdCheck = this.isDangerousCommand(command);
      if (cmdCheck.dangerous) {
        return {
          allow: false,
          allowed: false,
          reason: cmdCheck.reason,
          isReadOnly: false,
        };
      }
    }

    return { allow: true, allowed: true, isReadOnly: false };
  }
}
