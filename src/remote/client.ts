import http from 'node:http';
import {
  RemoteServerConfig,
  RemoteSystemInfo,
  RemoteExecResult,
  RemoteProcess,
  RemoteProcessKillResult,
  RemoteProcessList,
  RemoteProcessSignal,
} from './types.js';
import { execSshCommand, testSshConnection } from './ssh-installer.js';
import { RemoteServerStore } from './storage.js';
import {
  REMOTE_CLEANUP_ITEM_COMMANDS,
  REMOTE_DISK_SCAN_COMMANDS,
  parseRemoteDiskOutput,
  parseRemoteProcessOutput,
} from './diagnostics.js';
import { getPlatformLabel, type DiskCleanResult, type DiskScanReport, type CleanableItem } from '../system/disk-cleaner.js';
import { formatBytes } from '../system/host-info.js';

type ProcessListOptions = { limit?: number };

interface DaemonHttpResponse {
  statusCode: number;
  body: string;
}

interface DaemonEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

const SSH_DIAGNOSTICS_TIMEOUT_MS = 15_000;
const MAX_PROCESS_LIMIT = 500;
const MAX_DAEMON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DAEMON_OUTPUT_BYTES = 1 * 1024 * 1024;

interface RemoteDiskItemSpec {
  id: keyof typeof REMOTE_CLEANUP_ITEM_COMMANDS;
  category: CleanableItem['category'];
  name: string;
  description: string;
  safety: CleanableItem['safety'];
  type: CleanableItem['type'];
  aliases: readonly string[];
}

// These are the only paths that the generated scan command requests.  The
// aliases also let the parser handle `$HOME` being expanded differently by
// different SSH shells.
const REMOTE_DISK_ITEM_SPECS: readonly RemoteDiskItemSpec[] = [
  {
    id: 'remote_logs',
    category: 'temp_logs',
    name: '系统与服务日志 (/var/log)',
    description: '远程 Linux 宿主的过期系统与服务日志',
    safety: 'safe',
    type: 'dir',
    aliases: ['/var/log'],
  },
  {
    id: 'remote_tmp',
    category: 'temp_logs',
    name: '系统临时目录 (/tmp)',
    description: '远程 Linux 宿主的临时文件与残留运行时文件',
    safety: 'review',
    type: 'dir',
    aliases: ['/tmp'],
  },
  {
    id: 'remote_cache',
    category: 'package_cache',
    name: '用户缓存 ($HOME/.cache)',
    description: '用户级应用与工具缓存',
    safety: 'safe',
    type: 'dir',
    aliases: ['/.cache'],
  },
  {
    id: 'remote_npm_cache',
    category: 'package_cache',
    name: 'npm 缓存 ($HOME/.npm)',
    description: 'npm 下载与内容寻址缓存',
    safety: 'safe',
    type: 'dir',
    aliases: ['/.npm/_cacache', '/.npm'],
  },
  {
    id: 'remote_pnpm_store',
    category: 'package_cache',
    name: 'pnpm Store ($HOME/.pnpm-store)',
    description: 'pnpm 全局内容寻址缓存',
    safety: 'safe',
    type: 'dir',
    aliases: ['/.pnpm-store'],
  },
  {
    id: 'remote_docker',
    category: 'docker_prune',
    name: 'Docker 镜像与容器缓存',
    description: 'Docker 未使用的镜像、容器与构建缓存',
    safety: 'review',
    type: 'docker',
    aliases: ['/var/lib/docker', 'docker://system'],
  },
];

function normalizeRemotePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/\/+$/, '');
}

function pathMatchesAlias(path: string, alias: string): boolean {
  const normalizedPath = normalizeRemotePath(path);
  const normalizedAlias = normalizeRemotePath(alias);
  return normalizedPath === normalizedAlias || normalizedPath.endsWith(normalizedAlias);
}

function normalizeRemoteProcess(value: unknown): RemoteProcess | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const pid = typeof record.pid === 'number' ? record.pid : Number(record.pid);
  const cpuPercent = typeof record.cpuPercent === 'number' ? record.cpuPercent : Number(record.cpuPercent);
  const memPercent = typeof record.memPercent === 'number' ? record.memPercent : Number(record.memPercent);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(cpuPercent) || cpuPercent < 0
    || !Number.isFinite(memPercent) || memPercent < 0) return undefined;
  const process: RemoteProcess = {
    pid,
    cpuPercent,
    memPercent,
    command: typeof record.command === 'string' ? record.command : '',
  };
  const ppid = typeof record.ppid === 'number' ? record.ppid : Number(record.ppid);
  if (Object.prototype.hasOwnProperty.call(record, 'ppid')
    && (!Number.isSafeInteger(ppid) || ppid < 0)) return undefined;
  if (Number.isSafeInteger(ppid) && ppid >= 0) process.ppid = ppid;
  if (typeof record.user === 'string' && record.user) process.user = record.user;
  const elapsedSeconds = typeof record.elapsedSeconds === 'number' ? record.elapsedSeconds : Number(record.elapsedSeconds);
  if (Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0) process.elapsedSeconds = elapsedSeconds;
  if (typeof record.startTime === 'string' && record.startTime) process.startTime = record.startTime;
  return process;
}

function normalizeProcessList(value: unknown, limit: number): RemoteProcessList {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawProcesses = Array.isArray(record.processes) ? record.processes : [];
  const processes = rawProcesses.map(normalizeRemoteProcess).filter((item): item is RemoteProcess => item !== undefined).slice(0, limit);
  const timestamp = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) ? record.timestamp : Date.now();
  return { processes, limit, timestamp };
}

function boundedProcessLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROCESS_LIMIT) {
    throw new Error('Invalid process limit');
  }
  return limit;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCanonicalStartToken(value: string): boolean {
  return /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value);
}

function shellQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseDaemonBody<T>(response: DaemonHttpResponse): DaemonEnvelope<T> {
  try {
    const parsed = JSON.parse(response.body || '{}') as DaemonEnvelope<T>;
    return parsed;
  } catch {
    throw new Error(`Daemon 返回了无效 JSON (${response.statusCode})`);
  }
}

function isEndpointMissing(response: DaemonHttpResponse, allowBareNotFound = false): boolean {
  if (response.statusCode !== 404) return false;
  if (!response.body.trim()) return allowBareNotFound;
  try {
    const body = JSON.parse(response.body) as { error?: unknown };
    const message = typeof body.error === 'string' ? body.error.toLowerCase() : '';
    const normalized = message.trim();
    return (allowBareNotFound && normalized.length === 0)
      || (allowBareNotFound && normalized === 'not found')
      || normalized === 'endpoint not found'
      || normalized === 'unknown endpoint'
      || normalized.includes('endpoint not found');
  } catch {
    return allowBareNotFound;
  }
}

export class RemoteClientManager {
  private static instance: RemoteClientManager;
  private store: RemoteServerStore;

  constructor() {
    this.store = RemoteServerStore.getInstance();
  }

  static getInstance(): RemoteClientManager {
    if (!RemoteClientManager.instance) {
      RemoteClientManager.instance = new RemoteClientManager();
    }
    return RemoteClientManager.instance;
  }

  async testConnection(config: RemoteServerConfig): Promise<{
    ok: boolean;
    mode: 'daemon' | 'ssh' | 'offline';
    message: string;
    latencyMs: number;
    systemInfo?: RemoteSystemInfo;
  }> {
    const startTime = Date.now();
    const port = config.daemonPort || 9527;

    // 1. 尝试直连 Daemon 接口
    try {
      const daemonSysInfo = await this.fetchDaemonSysInfo(config);
      const latencyMs = Date.now() - startTime;
      this.store.updateStatus(config.id, {
        status: 'online',
        lastConnectedAt: Date.now(),
        systemInfo: daemonSysInfo,
        lastError: undefined,
      });
      return {
        ok: true,
        mode: 'daemon',
        message: 'HAP Daemon 双向通信正常',
        latencyMs,
        systemInfo: daemonSysInfo,
      };
    } catch {
      // 2. 如果 Daemon 无法访问，测试基础 SSH 连通性
      const sshRes = await testSshConnection(config);
      if (sshRes.ok) {
        this.store.updateStatus(config.id, {
          status: config.status === 'uninstalled' ? 'uninstalled' : 'offline',
          lastConnectedAt: Date.now(),
          lastError: `SSH 可连通，但 Daemon (端口 ${port}) 未响应`,
        });
        return {
          ok: true,
          mode: 'ssh',
          message: `SSH 连通正常 (Daemon 未启动或端口 ${port} 未放行)`,
          latencyMs: sshRes.latencyMs,
        };
      } else {
        this.store.updateStatus(config.id, {
          status: 'offline',
          lastError: sshRes.message,
        });
        return {
          ok: false,
          mode: 'offline',
          message: `连接失败: ${sshRes.message}`,
          latencyMs: sshRes.latencyMs,
        };
      }
    }
  }

  async getSystemInfo(config: RemoteServerConfig): Promise<RemoteSystemInfo> {
    try {
      const info = await this.fetchDaemonSysInfo(config);
      this.store.updateStatus(config.id, {
        status: 'online',
        systemInfo: info,
        lastConnectedAt: Date.now(),
      });
      return info;
    } catch {
      // 回退到 SSH 抓取基础信息
      const sshInfo = await this.fetchSshSysInfo(config);
      this.store.updateStatus(config.id, {
        systemInfo: sshInfo,
        lastConnectedAt: Date.now(),
      });
      return sshInfo;
    }
  }

  /**
   * Return a detailed remote process list.  Newer Daemons expose a structured
   * endpoint; older installations are queried through a fixed `ps` command
   * over SSH.
   */
  async listProcesses(config: RemoteServerConfig, options: ProcessListOptions = {}): Promise<RemoteProcessList> {
    const limit = boundedProcessLimit(options.limit);
    const path = `/api/processes?limit=${limit}`;
    let response: DaemonHttpResponse;
    try {
      response = await this.requestDaemon(config, path, 'GET', undefined, SSH_DIAGNOSTICS_TIMEOUT_MS);
    } catch {
      return this.listProcessesViaSsh(config, limit);
    }

    if (isEndpointMissing(response, true)) {
      return this.listProcessesViaSsh(config, limit);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const envelope = parseDaemonBody<{ processes?: unknown[] }>(response);
      throw new Error(envelope.error || `Daemon 进程列表请求失败 (${response.statusCode})`);
    }

    const envelope = parseDaemonBody<unknown>(response);
    if (!envelope.ok || envelope.data === undefined) {
      throw new Error(envelope.error || 'Daemon 未返回进程列表');
    }
    return normalizeProcessList(envelope.data, limit);
  }

  /** Terminate a remote process using TERM/KILL only. */
  async killProcess(
    config: RemoteServerConfig,
    pid: number,
    signal: RemoteProcessSignal,
    expectedStartTime?: string,
  ): Promise<RemoteProcessKillResult> {
    if (typeof pid !== 'number') throw new Error('Invalid PID');
    const pidText = String(pid);
    if (!/^\d+$/.test(pidText) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) <= 0) {
      throw new Error('Invalid PID');
    }
    const normalizedPid = Number(pidText);
    if (normalizedPid === 1) throw new Error('Protected PID');
    if (signal !== 'TERM' && signal !== 'KILL') throw new Error('Invalid signal');
    if (expectedStartTime !== undefined && typeof expectedStartTime !== 'string') {
      throw new Error('Invalid expected start time');
    }
    const normalizedExpectedStartTime = expectedStartTime?.trim() || undefined;

    const payload: { signal: RemoteProcessSignal; expectedStartTime?: string } = { signal };
    if (normalizedExpectedStartTime !== undefined) payload.expectedStartTime = normalizedExpectedStartTime;

    let response: DaemonHttpResponse;
    try {
      response = await this.requestDaemon(
        config,
        `/api/processes/${pidText}/kill`,
        'POST',
        payload,
        SSH_DIAGNOSTICS_TIMEOUT_MS,
      );
    } catch (error) {
      // A transport error leaves the remote outcome unknown. Do not retry a
      // destructive signal over SSH, since the Daemon may already have killed
      // the PID before the response was lost.
      return {
        pid: normalizedPid,
        signal,
        killed: false,
        message: `无法确认远程进程状态：${errorMessage(error)}`,
      };
    }

    if (isEndpointMissing(response)) {
      return this.killProcessViaSsh(config, normalizedPid, signal, normalizedExpectedStartTime);
    }

    let envelope: DaemonEnvelope<unknown>;
    try {
      envelope = parseDaemonBody<unknown>(response);
    } catch (error) {
      if (response.statusCode === 404) {
        return {
          pid: normalizedPid,
          signal,
          killed: false,
          message: errorMessage(error),
        };
      }
      throw error;
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (!envelope.ok || envelope.data === undefined) {
        throw new Error(envelope.error || 'Daemon 未确认进程终止');
      }
      return this.normalizeKillResult(envelope.data, normalizedPid, signal);
    }

    // Protected PIDs and stale expected-start checks are represented as a
    // structured, non-throwing result so callers can show a precise message.
    if (response.statusCode === 403 || response.statusCode === 409 || response.statusCode === 404) {
      return {
        pid: normalizedPid,
        signal,
        killed: false,
        ...(response.statusCode === 403 ? { protected: true } : {}),
        message: envelope.error || `Daemon 拒绝终止进程 (${response.statusCode})`,
      };
    }
    throw new Error(envelope.error || `Daemon 进程终止请求失败 (${response.statusCode})`);
  }

  /**
   * Scan the remote root filesystem and known cache directories.  All sizes
   * come from the remote `df`/`du` output; no estimates are substituted.
   */
  async scanDisk(config: RemoteServerConfig): Promise<DiskScanReport> {
    const dfResult = await this.execCommand(config, REMOTE_DISK_SCAN_COMMANDS.df);
    if (dfResult.code !== 0) {
      throw new Error(dfResult.stderr || `远程 df 执行失败 (${dfResult.code})`);
    }
    const duResult = await this.execCommand(config, REMOTE_DISK_SCAN_COMMANDS.du);
    if (duResult.code !== 0) {
      throw new Error(duResult.stderr || `远程 du 执行失败 (${duResult.code})`);
    }

    const parsed = parseRemoteDiskOutput(dfResult.stdout, duResult.stdout);
    if (!Number.isFinite(parsed.totalBytes) || parsed.totalBytes <= 0
      || !Number.isFinite(parsed.usedBytes) || !Number.isFinite(parsed.freeBytes)
      || parsed.usedBytes < 0 || parsed.freeBytes < 0) {
      throw new Error('无法解析远程 df 磁盘摘要');
    }
    const itemById = new Map<string, CleanableItem>();
    for (const entry of parsed.entries) {
      if (!Number.isFinite(entry.sizeBytes) || entry.sizeBytes < 0) continue;
      const spec = REMOTE_DISK_ITEM_SPECS.find((candidate) =>
        candidate.aliases.some((alias) => pathMatchesAlias(entry.path, alias))
      );
      if (!spec) continue;

      const existing = itemById.get(spec.id);
      // A shell may report both `$HOME/.npm` and its `_cacache` child. Keep
      // one stable item and use the largest observed value rather than
      // double-counting nested paths.
      if (existing && existing.sizeBytes >= entry.sizeBytes) continue;
      itemById.set(spec.id, {
        id: spec.id,
        category: spec.category,
        name: spec.name,
        path: entry.path,
        description: spec.description,
        sizeBytes: Math.round(entry.sizeBytes),
        safety: spec.safety,
        type: spec.type,
      });
    }

    const items = [...itemById.values()];
    const totalCleanableBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
    const safeCleanableBytes = items.filter((item) => item.safety === 'safe')
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    const reviewCleanableBytes = items.filter((item) => item.safety === 'review')
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    const hasDisk = parsed.totalBytes > 0;
    const healthScore = hasDisk
      ? Math.max(20, Math.min(100, 100 - Math.round(parsed.usedPercent)))
      : 0;
    const mount = parsed.mount || '/';
    const aiDiagnosis = hasDisk
      ? `远程根文件系统 ${mount} 当前已使用 ${parsed.usedPercent}%，扫描到 ${formatBytes(totalCleanableBytes)} 可清理数据。`
      : '远程根文件系统容量暂不可用，已返回可识别的目录扫描结果。';
    // The command set targets POSIX/Linux paths. Prefer the cached daemon
    // platform when available, and use Linux as the protocol default.
    const platform = config.systemInfo?.platform || 'linux';

    return {
      target: config.id,
      platform,
      platformLabel: getPlatformLabel(platform, '远程主机'),
      totalCleanableBytes,
      safeCleanableBytes,
      reviewCleanableBytes,
      healthScore,
      aiDiagnosis,
      scannedRoots: [...new Set([mount, ...items.map((item) => item.path)])],
      items,
      scannedAt: Date.now(),
    };
  }

  /**
   * Clean only IDs present in a fresh scan, then rescan and report measured
   * byte deltas. Unknown IDs are returned as errors and never reach a shell.
   */
  async cleanDisk(config: RemoteServerConfig, itemIds: string[]): Promise<DiskCleanResult> {
    const errors: Array<{ id: string; error: string }> = [];
    const deletedItems: string[] = [];
    let before: DiskScanReport;
    try {
      before = await this.scanDisk(config);
    } catch (error) {
      return {
        target: config.id,
        cleanedBytes: 0,
        deletedItems,
        errors: [{ id: 'scan-before', error: errorMessage(error) }],
        cleanedAt: Date.now(),
      };
    }

    const requested = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
    const allRequested = requested.includes('all');
    const selectedIds = allRequested
      ? before.items.map((item) => item.id)
      : [...new Set(requested)];
    const beforeById = new Map(before.items.map((item) => [item.id, item]));
    const successfulIds = new Set<string>();

    // Preserve explicit unknown IDs even when the caller also requested all;
    // they are reported below and never become shell commands.
    if (allRequested) {
      for (const id of new Set(requested.filter((candidate) => candidate !== 'all'))) {
        if (!beforeById.has(id)) errors.push({ id, error: 'Unknown remote cleanup item' });
      }
    }

    for (const id of selectedIds) {
      const item = beforeById.get(id);
      const hasCommand = Object.prototype.hasOwnProperty.call(REMOTE_CLEANUP_ITEM_COMMANDS, id);
      const command = hasCommand
        ? REMOTE_CLEANUP_ITEM_COMMANDS[id as keyof typeof REMOTE_CLEANUP_ITEM_COMMANDS]
        : undefined;
      if (!item || command === undefined) {
        errors.push({ id, error: 'Unknown remote cleanup item' });
        continue;
      }
      try {
        const result = await this.execCommand(config, command, undefined, { fallbackToSsh: false });
        if (result.code !== 0) {
          errors.push({ id, error: result.stderr || result.stdout || `远程清理返回状态码 ${result.code}` });
          continue;
        }
        successfulIds.add(id);
      } catch (error) {
        errors.push({ id, error: errorMessage(error) });
      }
    }

    let after: DiskScanReport | undefined;
    try {
      after = await this.scanDisk(config);
    } catch (error) {
      errors.push({ id: 'scan-after', error: errorMessage(error) });
    }

    const afterById = new Map((after?.items || []).map((item) => [item.id, item]));
    let cleanedBytes = 0;
    for (const id of selectedIds) {
      const previous = beforeById.get(id);
      if (!previous) continue;
      if (after === undefined) continue;
      const current = afterById.get(id);
      if (!current) {
        errors.push({ id, error: 'Unable to measure remote item after cleanup' });
        continue;
      }
      const delta = Math.max(0, previous.sizeBytes - current.sizeBytes);
      if (successfulIds.has(id)) cleanedBytes += delta;
      if (successfulIds.has(id)) {
        deletedItems.push(`${previous.name} (${formatBytes(delta)})`);
      }
    }

    return {
      target: config.id,
      cleanedBytes,
      deletedItems,
      errors,
      cleanedAt: Date.now(),
    };
  }

  async execCommand(
    config: RemoteServerConfig,
    command: string,
    onStream?: (chunk: { type: 'stdout' | 'stderr' | 'exit' | 'error'; text?: string; code?: number }) => void,
    options: { fallbackToSsh?: boolean } = {},
  ): Promise<RemoteExecResult> {
    const startTime = Date.now();

    // 优先尝试 HTTP Daemon 执行 (支持低开销和流式)
    try {
      return await this.execViaDaemon(config, command, onStream);
    } catch (error) {
      if (options.fallbackToSsh === false) throw error;
      // 回退到 SSH Exec
      return await this.execViaSsh(config, command, onStream);
    }
  }

  private requestDaemon(
    config: RemoteServerConfig,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    timeoutMs = 5000,
  ): Promise<DaemonHttpResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = {
        'X-HAP-Token': config.token || '',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(payload));
      }

      const req = http.request(
        {
          hostname: config.host,
          port: config.daemonPort || 9527,
          path,
          method,
          timeout: timeoutMs,
          headers,
        },
        (res) => {
          let responseBody = '';
          let responseBytes = 0;
          let oversized = false;
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (oversized) return;
            responseBytes += Buffer.byteLength(chunk);
            if (responseBytes > MAX_DAEMON_RESPONSE_BYTES) {
              oversized = true;
              res.destroy(new Error('Daemon 响应超过大小上限'));
              return;
            }
            responseBody += chunk;
          });
          res.on('end', () => {
            if (!oversized) resolve({ statusCode: res.statusCode || 0, body: responseBody });
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Daemon 请求超时'));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private async listProcessesViaSsh(config: RemoteServerConfig, limit: number): Promise<RemoteProcessList> {
    const command = 'LC_ALL=C ps -eo pid=,ppid=,user=,%cpu=,%mem=,etimes=,lstart=,args=';
    const result = await execSshCommand(config, command, SSH_DIAGNOSTICS_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `SSH 进程列表请求失败 (${result.code})`);
    }
    return parseRemoteProcessOutput(result.stdout, limit);
  }

  private async killProcessViaSsh(
    config: RemoteServerConfig,
    pid: number,
    signal: RemoteProcessSignal,
    expectedStartTime?: string,
  ): Promise<RemoteProcessKillResult> {
    if (expectedStartTime !== undefined) {
      if (!isCanonicalStartToken(expectedStartTime)) {
        return {
          pid,
          signal,
          killed: false,
          message: '无法验证远程进程启动时间',
        };
      }
    }

    // `pid` and `signal` have already passed strict validation in killProcess;
    // only these fixed tokens are interpolated into the shell command. The
    // guards protect the SSH shell and a daemon launched by the installer.
    const command = [
      'set -e',
      `if [ "${pid}" -eq 1 ] || [ "${pid}" -eq "$$" ] || [ "${pid}" -eq "\${PPID:-0}" ]; then exit 77; fi`,
      `DAEMON_PID=$(cat "$HOME/.hap-daemon/daemon.pid" 2>/dev/null || cat "/opt/hap-daemon/daemon.pid" 2>/dev/null || true)`,
      `if [ -n "$DAEMON_PID" ] && [ "$DAEMON_PID" = "${pid}" ]; then exit 77; fi`,
      ...(expectedStartTime === undefined ? [] : [
        `CURRENT_START=$(LC_ALL=C ps -p ${pid} -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr -s ' ')`,
        `if [ "$CURRENT_START" != ${shellQuoteLiteral(expectedStartTime)} ]; then exit 78; fi`,
      ]),
      `kill -${signal} ${pid}`,
    ].join('; ');
    const result = await execSshCommand(config, command, SSH_DIAGNOSTICS_TIMEOUT_MS);
    if (result.code === 0) {
      return { pid, signal, killed: true };
    }
    return {
      pid,
      signal,
      killed: false,
      message: result.stderr || result.stdout || `SSH kill 返回状态码 ${result.code}`,
    };
  }

  private normalizeKillResult(value: unknown, pid: number, signal: RemoteProcessSignal): RemoteProcessKillResult {
    const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
    const result: RemoteProcessKillResult = {
      pid,
      signal,
      killed: record.killed === true,
    };
    if (record.protected === true) result.protected = true;
    if (typeof record.message === 'string' && record.message) result.message = record.message;
    return result;
  }

  private fetchDaemonSysInfo(config: RemoteServerConfig, timeoutMs = 5000): Promise<RemoteSystemInfo> {
    return new Promise((resolve, reject) => {
      const port = config.daemonPort || 9527;
      const req = http.request(
        {
          hostname: config.host,
          port,
          path: '/api/sysinfo',
          method: 'GET',
          timeout: timeoutMs,
          headers: {
            'X-HAP-Token': config.token || '',
            'Authorization': config.token ? `Bearer ${config.token}` : '',
          },
        },
        (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.ok && json.data) {
                resolve(json.data as RemoteSystemInfo);
              } else {
                reject(new Error(json.error || '获取系统信息失败'));
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('获取系统信息超时'));
      });
      req.end();
    });
  }

  private execViaDaemon(
    config: RemoteServerConfig,
    command: string,
    onStream?: (chunk: { type: 'stdout' | 'stderr' | 'exit' | 'error'; text?: string; code?: number }) => void,
    timeoutMs = 120000
  ): Promise<RemoteExecResult> {
    return new Promise((resolve, reject) => {
      const port = config.daemonPort || 9527;
      const payload = JSON.stringify({ command, stream: !!onStream });
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: config.host,
          port,
          path: '/api/exec',
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-HAP-Token': config.token || '',
            'Authorization': config.token ? `Bearer ${config.token}` : '',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorBody = '';
            res.on('data', c => { errorBody += c; });
            res.on('end', () => {
              reject(new Error(`Daemon 响应异常 (${res.statusCode}): ${errorBody}`));
            });
            return;
          }

          if (onStream) {
            let fullStdout = '';
            let fullStderr = '';
            let outputBytes = 0;
            let exitCode = 0;

            let buffer = '';
            res.on('data', chunk => {
              buffer += chunk.toString('utf-8');
              const lines = buffer.split('\n\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const event = JSON.parse(line.slice(6));
                    if (event.type === 'stdout') {
                      const text = typeof event.text === 'string' ? event.text : '';
                      const remaining = MAX_DAEMON_OUTPUT_BYTES - outputBytes;
                      if (remaining > 0) {
                        const clipped = text.slice(0, remaining);
                        fullStdout += clipped;
                        outputBytes += Buffer.byteLength(clipped);
                      }
                      onStream(event);
                    } else if (event.type === 'stderr') {
                      const text = typeof event.text === 'string' ? event.text : '';
                      const remaining = MAX_DAEMON_OUTPUT_BYTES - outputBytes;
                      if (remaining > 0) {
                        const clipped = text.slice(0, remaining);
                        fullStderr += clipped;
                        outputBytes += Buffer.byteLength(clipped);
                      }
                      onStream(event);
                    } else if (event.type === 'exit') {
                      exitCode = event.code;
                      onStream(event);
                    } else if (event.type === 'error') {
                      onStream(event);
                    }
                  } catch {}
                }
              }
            });

            res.on('end', () => {
              resolve({
                code: exitCode,
                stdout: fullStdout,
                stderr: fullStderr,
                durationMs: Date.now() - startTime,
              });
            });
          } else {
            let data = '';
            let responseBytes = 0;
            res.on('data', chunk => {
              const text = chunk.toString('utf8');
              const remaining = MAX_DAEMON_RESPONSE_BYTES - responseBytes;
              if (remaining <= 0) return;
              const clipped = text.slice(0, remaining);
              data += clipped;
              responseBytes += Buffer.byteLength(clipped);
            });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                // The Daemon uses `ok: false` for a completed shell command
                // with a non-zero exit code, while still returning the full
                // RemoteExecResult. Preserve that result instead of retrying
                // a potentially destructive command over SSH.
                if (json.data && typeof json.data.code === 'number'
                  && typeof json.data.stdout === 'string' && typeof json.data.stderr === 'string') {
                  resolve(json.data as RemoteExecResult);
                } else if (json.ok && json.data) {
                  resolve(json.data);
                } else {
                  reject(new Error(json.error || '执行命令失败'));
                }
              } catch (err) {
                reject(err);
              }
            });
          }
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('命令执行超时'));
      });
      req.write(payload);
      req.end();
    });
  }

  private async execViaSsh(
    config: RemoteServerConfig,
    command: string,
    onStream?: (chunk: { type: 'stdout' | 'stderr' | 'exit' | 'error'; text?: string; code?: number }) => void
  ): Promise<RemoteExecResult> {
    const startTime = Date.now();
    const res = await execSshCommand(config, command);
    if (onStream) {
      if (res.stdout) onStream({ type: 'stdout', text: res.stdout });
      if (res.stderr) onStream({ type: 'stderr', text: res.stderr });
      onStream({ type: 'exit', code: res.code });
    }
    return {
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - startTime,
    };
  }

  private async fetchSshSysInfo(config: RemoteServerConfig): Promise<RemoteSystemInfo> {
    // Use explicit markers so multiline files such as /etc/os-release and
    // /proc/meminfo cannot shift the position of later fields. Every value is
    // collected from the remote host; unavailable metrics remain zero/empty
    // instead of being replaced by plausible-looking local placeholders.
    const cmd = [
      "printf '__HAP_HOSTNAME__\\n'; uname -n 2>/dev/null || true",
      "printf '__HAP_PLATFORM__\\n'; uname -s 2>/dev/null || true",
      "printf '__HAP_ARCH__\\n'; uname -m 2>/dev/null || true",
      "printf '__HAP_OS_RELEASE__\\n'; if [ -r /etc/os-release ]; then sed -n 's/^PRETTY_NAME=//p' /etc/os-release | head -n 1 | sed 's/^\"//;s/\"$//'; else uname -r 2>/dev/null || true; fi",
      "printf '__HAP_UPTIME__\\n'; if [ -r /proc/uptime ]; then awk 'NR==1 {print $1; exit}' /proc/uptime; else uptime -s 2>/dev/null || true; fi",
      "printf '__HAP_CPU_COUNT__\\n'; if command -v nproc >/dev/null 2>&1; then nproc; elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.ncpu 2>/dev/null || echo 0; else grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0; fi",
      "printf '__HAP_CPU_MODEL__\\n'; if [ -r /proc/cpuinfo ]; then awk -F: '/model name|Hardware/ {gsub(/^[ \\t]+/, \"\", $2); print $2; exit}' /proc/cpuinfo; elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.model 2>/dev/null || uname -p 2>/dev/null || true; else uname -p 2>/dev/null || true; fi",
      "printf '__HAP_CPU_USAGE__\\n'; cpu_count=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1); ps -A -o %cpu= 2>/dev/null | awk -v c=\"$cpu_count\" '{sum += $1} END {if (c > 0) print sum / c; else print 0}'",
      "printf '__HAP_MEM_TOTAL__\\n'; if [ -r /proc/meminfo ]; then awk '/^MemTotal:/ {print $2 * 1024; exit}' /proc/meminfo; elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.memsize 2>/dev/null || echo 0; else echo 0; fi",
      "printf '__HAP_MEM_FREE__\\n'; if [ -r /proc/meminfo ]; then awk '/^MemAvailable:/ {print $2 * 1024; exit} /^MemFree:/ {free = $2 * 1024} END {if (free) print free}' /proc/meminfo; elif command -v vm_stat >/dev/null 2>&1; then vm_stat 2>/dev/null | awk '/Pages free/ {free += $3} /Pages inactive/ {free += $3} END {gsub(/\\./, \"\", free); print free * 4096}'; else echo 0; fi",
      "printf '__HAP_LOADAVG__\\n'; if [ -r /proc/loadavg ]; then awk '{print $1, $2, $3; exit}' /proc/loadavg; elif command -v sysctl >/dev/null 2>&1; then sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' || true; else echo ''; fi",
      "printf '__HAP_DISK__\\n'; df -kP / 2>/dev/null | awk 'NR==2 {print $2 * 1024, $3 * 1024, $4 * 1024, $5, $6; exit}' || true",
    ].join('\n');
    // 系统信息是监控页面的轻量探测，不能沿用命令执行的 120 秒默认超时。
    const res = await execSshCommand(config, cmd, 15000);
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new Error(res.stderr || `SSH 系统信息请求失败 (${res.code})`);
    }

    const lines = res.stdout.split(/\r?\n/);
    const markerPattern = /^__HAP_[A-Z_]+__$/;
    const markerValues = new Map<string, string>();
    for (let i = 0; i < lines.length; i += 1) {
      const marker = lines[i]?.trim() || '';
      if (!markerPattern.test(marker)) continue;
      let value = '';
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j]?.trim() || '';
        if (markerPattern.test(candidate)) break;
        if (candidate) {
          value = candidate;
          break;
        }
      }
      markerValues.set(marker.slice('__HAP_'.length, -'__'.length), value);
    }
    const marker = (name: string): string => markerValues.get(name) || '';
    const legacyLines = lines.map(line => line.trim()).filter(line => line && !markerPattern.test(line));
    const parseFinite = (value: string): number | undefined => {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const normalizePlatform = (value: string): string => {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'darwin' || normalized === 'macos' || normalized === 'mac') return 'darwin';
      if (normalized === 'windows' || normalized === 'windows_nt' || normalized === 'win32') return 'win32';
      if (normalized === 'linux') return 'linux';
      return normalized || 'unknown';
    };

    const hostname = marker('HOSTNAME') || legacyLines[0] || config.host;
    const platform = normalizePlatform(marker('PLATFORM') || legacyLines[1] || 'unknown');
    const arch = marker('ARCH') || legacyLines[2] || 'unknown';
    const rawRelease = marker('OS_RELEASE') || legacyLines[3] || 'unknown';
    const osRelease = rawRelease.replace(/^PRETTY_NAME=/, '').replace(/^\"|\"$/g, '') || 'unknown';

    const rawUptime = marker('UPTIME');
    let uptimeSeconds = parseFinite(rawUptime);
    if (uptimeSeconds === undefined) {
      const procUptime = res.stdout.match(/(?:^|\n)(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?(?:\s|$)/);
      uptimeSeconds = procUptime?.[1] ? parseFinite(procUptime[1]) : undefined;
    }
    if (uptimeSeconds === undefined) {
      const bootTime = Date.parse(rawUptime);
      uptimeSeconds = Number.isFinite(bootTime) ? Math.max(0, (Date.now() - bootTime) / 1000) : 0;
    }

    const rawCpuCount = marker('CPU_COUNT') || legacyLines.find(line => /^\d+$/.test(line)) || '';
    const parsedCpuCount = parseFinite(rawCpuCount);
    const cpuCount = parsedCpuCount !== undefined && Number.isSafeInteger(parsedCpuCount) && parsedCpuCount > 0
      ? parsedCpuCount
      : 0;
    const cpuModel = marker('CPU_MODEL') || res.stdout.match(/(?:model name|Hardware)\s*:\s*(.+)/i)?.[1]?.trim() || 'Unknown CPU';
    const parsedCpuUsage = parseFinite(marker('CPU_USAGE'));
    const cpuUsagePercent = parsedCpuUsage === undefined ? 0 : Math.max(0, Math.min(100, parsedCpuUsage));

    const legacyTotal = res.stdout.match(/MemTotal:\s+(\d+)\s+kB/i)?.[1];
    const legacyFree = res.stdout.match(/MemAvailable:\s+(\d+)\s+kB/i)?.[1]
      || res.stdout.match(/MemFree:\s+(\d+)\s+kB/i)?.[1];
    const parsedTotal = parseFinite(marker('MEM_TOTAL')) ?? (legacyTotal ? Number(legacyTotal) * 1024 : 0);
    const parsedFree = parseFinite(marker('MEM_FREE')) ?? (legacyFree ? Number(legacyFree) * 1024 : 0);
    const totalMemBytes = parsedTotal !== undefined && parsedTotal > 0 ? parsedTotal : 0;
    const freeMemBytes = parsedFree !== undefined && parsedFree >= 0
      ? Math.min(parsedFree, totalMemBytes || parsedFree)
      : 0;
    const usedMemPercent = totalMemBytes > 0
      ? Number(Math.max(0, Math.min(100, ((totalMemBytes - freeMemBytes) / totalMemBytes) * 100)).toFixed(1))
      : 0;

    const loadValues = (marker('LOADAVG') || '').replace(/[{}]/g, '').match(/[\d.]+/g)?.map(Number).filter(Number.isFinite) || [];
    const diskRaw = marker('DISK');
    const diskMatch = diskRaw.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)%\s+(.+)$/);
    const info: RemoteSystemInfo = {
      hostname,
      platform,
      arch,
      osRelease,
      uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)),
      cpuCount,
      cpuModel,
      cpuUsagePercent,
      totalMemBytes,
      freeMemBytes,
      usedMemPercent,
      loadAvg: loadValues.slice(0, 3),
      timestamp: Date.now(),
    };
    if (diskMatch) {
      info.diskTotalBytes = Number(diskMatch[1]);
      info.diskUsedBytes = Number(diskMatch[2]);
      info.diskFreeBytes = Number(diskMatch[3]);
      info.diskUsedPercent = Number(diskMatch[4]);
    }
    return info;
  }
}
