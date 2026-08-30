import type { ControlExecutionContext } from './types.js';

const remoteToolNames = new Set(['remote_exec', 'remote_sysinfo', 'remote_upgrade_daemon']);
const mutatingRemoteToolNames = new Set(['remote_exec', 'remote_upgrade_daemon']);

export function scopeToolArgsForControl(
  toolName: string,
  args: Record<string, unknown>,
  control: ControlExecutionContext | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  if (control === undefined) return { ok: true, args };
  if (!remoteToolNames.has(toolName)) return { ok: true, args };
  if (mutatingRemoteToolNames.has(toolName) && (control.role === 'viewer' || control.capabilityProfile === 'observe')) {
    return {
      ok: false,
      message: 'CONTROL_FORBIDDEN: 当前 Bot 绑定只允许观察，不能执行会改变服务器状态的远程工具。',
    };
  }
  return {
    ok: true,
    args: { ...args, server: control.serverId },
  };
}
