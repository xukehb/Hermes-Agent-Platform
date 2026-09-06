import type { RemoteProcess, RemoteProcessList } from './types.js';

export const REMOTE_CLEANUP_COMMANDS = Object.freeze({
  safe: 'rm -rf "$HOME/.cache"/* "$HOME/.npm/_cacache"/* "$HOME/.pnpm-store/v3/files"/* 2>/dev/null',
  all: 'rm -rf "$HOME/.cache"/* "$HOME/.npm/_cacache"/* "$HOME/.pnpm-store"/* /tmp/* 2>/dev/null',
});

/**
 * Every remote cleanup command is deliberately static.  The client accepts
 * item ids from the UI, then looks up one of these commands; paths are never
 * copied from an untrusted scan result into a shell command.
 */
export const REMOTE_CLEANUP_ITEM_COMMANDS = Object.freeze({
  remote_logs: 'if [ -d /var/log ]; then find /var/log -xdev -type f -name "*.log" -mtime +7 -delete 2>/dev/null; else :; fi',
  remote_tmp: 'if [ -d /tmp ]; then find /tmp -mindepth 1 -maxdepth 1 -xdev -user "$(id -u)" -mmin +60 -exec rm -rf -- {} + 2>/dev/null; else :; fi',
  remote_cache: 'if [ -d "$HOME/.cache" ]; then rm -rf "$HOME/.cache"/* 2>/dev/null; else :; fi',
  remote_npm_cache: 'if [ -d "$HOME/.npm" ]; then rm -rf "$HOME/.npm"/* 2>/dev/null; else :; fi',
  remote_pnpm_store: 'if [ -d "$HOME/.pnpm-store" ]; then rm -rf "$HOME/.pnpm-store"/* 2>/dev/null; else :; fi',
  remote_docker: 'if command -v docker >/dev/null 2>&1; then docker system prune -f 2>/dev/null; else echo "docker command not found" >&2; exit 127; fi',
});

/** Static commands used by the remote disk scanner. */
export const REMOTE_DISK_SCAN_COMMANDS = Object.freeze({
  df: 'df -kP /',
  du: 'for p in /var/log /tmp "$HOME/.cache" "$HOME/.npm" "$HOME/.pnpm-store" /var/lib/docker; do if [ -e "$p" ]; then du -sk "$p" 2>/dev/null || true; fi; done',
});

const CANONICAL_LSTART = '(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}';
const COMBINED_PROCESS_PATTERN = new RegExp(`^(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+(\\d+)\\s+(${CANONICAL_LSTART})\\s+(.*)$`);
const LSTART_PROCESS_PATTERN = new RegExp(`^(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+(${CANONICAL_LSTART})\\s+(.*)$`);
const ETIMES_PROCESS_PATTERN = /^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
const POSSIBLE_LSTART_PREFIX = /^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?:\s|$)/;

export function parseRemoteProcessOutput(output: string, limit = 100): RemoteProcessList {
  const numericLimit = Number(limit);
  const bounded = Number.isFinite(numericLimit)
    ? Math.max(1, Math.min(500, Math.floor(numericLimit)))
    : 100;
  const processes: RemoteProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Current Daemons use `lstart`, a fixed-width absolute start timestamp;
    // the legacy etimes shape remains supported for older SSH fallbacks.
    const combinedMatch = trimmed.match(COMBINED_PROCESS_PATTERN);
    const lstartMatch = trimmed.match(LSTART_PROCESS_PATTERN);
    const etimesMatch = trimmed.match(ETIMES_PROCESS_PATTERN);
    // A malformed absolute start token must not be reinterpreted as the
    // command text of the legacy etimes format.
    if (!combinedMatch && !lstartMatch && etimesMatch && POSSIBLE_LSTART_PREFIX.test(etimesMatch[7] || '')) continue;
    const match = combinedMatch || lstartMatch || etimesMatch;
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuPercent = Number(match[4]);
    const memPercent = Number(match[5]);
    const process: RemoteProcess = {
      pid,
      ppid,
      user: match[3]!,
      cpuPercent,
      memPercent,
      command: combinedMatch ? (match[8] || '') : (match[7] || ''),
    };
    if (!Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(ppid) || ppid < 0
      || !Number.isFinite(cpuPercent) || cpuPercent < 0
      || !Number.isFinite(memPercent) || memPercent < 0) {
      continue;
    }
    if (combinedMatch) {
      process.elapsedSeconds = Number(match[6]);
      const rawStartTime = match[7]!.replace(/\s+/g, ' ').trim();
      process.startTime = rawStartTime;
    } else if (lstartMatch) {
      // Keep the C-locale lstart text as an opaque identity token. Parsing it
      // through Date.parse would apply the desktop timezone during SSH
      // fallback and make a Daemon token incomparable across hosts.
      const rawStartTime = match[6]!.replace(/\s+/g, ' ').trim();
      process.startTime = rawStartTime;
    } else {
      const elapsedSeconds = Number(match[6]);
      if (Number.isFinite(elapsedSeconds)) process.elapsedSeconds = elapsedSeconds;
      // etimes is relative to the query time and is not a safe identity
      // token; leave startTime unset so kill fallbacks fail closed.
    }
    processes.push(process);
    if (processes.length >= bounded) break;
  }
  return { processes, limit: bounded, timestamp: Date.now() };
}

export interface RemoteDiskEntry {
  path: string;
  sizeBytes: number;
}

export interface RemoteDiskSummary {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  mount: string;
  entries: RemoteDiskEntry[];
}

function parseSize(value: string, bareUnit: 'kb' | 'bytes' = 'kb'): number | undefined {
  const match = value.trim().match(/^([\d.]+)\s*([kmgtpe]?i?b?|)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const suffix = (match[2] || '').toLowerCase();
  if (!suffix) return Math.round(amount * (bareUnit === 'kb' ? 1024 : 1));
  const normalized = suffix.replace('ib', 'b').replace(/b$/, '');
  const powers: Record<string, number> = { k: 1, m: 2, g: 3, t: 4, p: 5, e: 6 };
  const power = powers[normalized] ?? 0;
  return Math.round(amount * 1024 ** power);
}

export function parseRemoteDiskOutput(dfOutput: string, duOutput = ''): RemoteDiskSummary {
  const lines = dfOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let totalBytes = 0;
  let usedBytes = 0;
  let freeBytes = 0;
  let usedPercent = 0;
  let mount = '';

  // `df -P` has a header, but accepting a headerless response keeps the SSH
  // fallback compatible with older BusyBox images as well.
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+([\d.]+(?:[KMGTP]?i?B?)?)\s+([\d.]+(?:[KMGTP]?i?B?)?)\s+([\d.]+(?:[KMGTP]?i?B?)?)\s+(\d+)%\s+(.+)$/i);
    if (!match) continue;
    const total = parseSize(match[2]!);
    const used = parseSize(match[3]!);
    const free = parseSize(match[4]!);
    if (total === undefined || used === undefined || free === undefined) continue;
    totalBytes = total;
    usedBytes = used;
    freeBytes = free;
    usedPercent = Number(match[5]);
    mount = match[6] || '';
    break;
  }

  const entries = duOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^([\d.]+(?:[KMGTP]?i?B?)?)\s+(.+)$/i);
    if (!match) return undefined;
    const sizeBytes = parseSize(match[1]!);
    return sizeBytes === undefined ? undefined : { path: match[2]!, sizeBytes };
  }).filter((entry): entry is RemoteDiskEntry => entry !== undefined);

  return { totalBytes, usedBytes, freeBytes, usedPercent, mount, entries };
}
