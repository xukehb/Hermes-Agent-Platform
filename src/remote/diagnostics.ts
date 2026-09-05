import type { RemoteProcess, RemoteProcessList } from './types.js';

export const REMOTE_CLEANUP_COMMANDS = Object.freeze({
  safe: 'rm -rf "$HOME/.cache"/* "$HOME/.npm/_cacache"/* "$HOME/.pnpm-store/v3/files"/* 2>/dev/null',
  all: 'rm -rf "$HOME/.cache"/* "$HOME/.npm/_cacache"/* "$HOME/.pnpm-store"/* /tmp/* 2>/dev/null',
});

export function parseRemoteProcessOutput(output: string, limit = 100): RemoteProcessList {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit) || 100));
  const processes: RemoteProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]), ppid: Number(match[2]), user: match[3]!,
      cpuPercent: Number(match[4]), memPercent: Number(match[5]),
      elapsedSeconds: Number(match[6]), startTime: new Date(Date.now() - Number(match[6]) * 1000).toISOString(), command: match[7] || '',
    });
    if (processes.length >= bounded) break;
  }
  return { processes, limit: bounded, timestamp: Date.now() };
}

export function parseRemoteDiskOutput(dfOutput: string, duOutput = '') {
  const lines = dfOutput.trim().split(/\r?\n/).filter(Boolean);
  let totalBytes = 0; let usedBytes = 0; let freeBytes = 0; let usedPercent = 0; let mount = '';
  for (const line of lines.slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (m) { totalBytes = Number(m[2]) * 1024; usedBytes = Number(m[3]) * 1024; freeBytes = Number(m[4]) * 1024; usedPercent = Number(m[5]); mount = m[6]!; break; }
  }
  const entries = duOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(\d+)\s+(.+)$/); return m ? { path: m[2]!, sizeBytes: Number(m[1]) * 1024 } : undefined;
  }).filter((x): x is { path: string; sizeBytes: number } => !!x);
  return { totalBytes, usedBytes, freeBytes, usedPercent, mount, entries };
}
