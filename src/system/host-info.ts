import os from 'node:os';
import process from 'node:process';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

export interface HostCpuCore {
  coreIndex: number;
  model: string;
  speedMHz: number;
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

export interface HostCpuInfo {
  model: string;
  cores: number;
  speedMHz: number;
  usagePercent: number;
  loadAvg: number[];
  perCore: HostCpuCore[];
}

export interface HostMemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  processRssBytes: number;
  processHeapTotalBytes: number;
  processHeapUsedBytes: number;
  processExternalBytes: number;
  processArrayBuffersBytes: number;
}

export interface HostDiskPartition {
  mount: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface HostDiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  mount: string;
  partitions: HostDiskPartition[];
}

export interface HostNetworkInterfaceItem {
  interface: string;
  address: string;
  family: string;
  mac: string;
  netmask: string;
  internal: boolean;
}

export interface HostNetworkInfo {
  hostname: string;
  ips: HostNetworkInterfaceItem[];
}

export interface HostProcessVersions {
  node: string;
  v8: string;
  uv: string;
  zlib: string;
  openssl: string;
}

export interface HostOsInfo {
  platform: string; // win32, darwin, linux
  type: string; // Windows_NT, Darwin, Linux
  release: string;
  arch: string;
  endianness: string;
  uptimeSeconds: number;
  processUptimeSeconds: number;
  nodeVersion: string;
  pid: number;
  ppid: number;
  user: string;
  homedir: string;
  tmpdir: string;
  execPath: string;
  cwd: string;
  versions: HostProcessVersions;
}

export interface HostTopProcess {
  pid: number;
  name: string;
  memoryBytes: number;
  memoryFormatted: string;
}

export interface HostSystemInfo {
  os: HostOsInfo;
  cpu: HostCpuInfo;
  memory: HostMemoryInfo;
  disk: HostDiskInfo;
  network: HostNetworkInfo;
  topProcesses: HostTopProcess[];
  loadAvg: number[];
  timestamp: number;
}

/** 计算 CPU 实时使用率（基于多核空闲与非空闲时钟滴答数） */
function calculateCpuUsage(): number {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;

  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += (cpu.times as any)[type];
    }
    totalIdle += cpu.times.idle;
  }

  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const usage = 1 - idle / (total || 1);
  return Math.min(100, Math.max(0, Math.round(usage * 100)));
}

/** 获取局域网与物理网卡详细列表 */
function getNetworkIps(): HostNetworkInterfaceItem[] {
  const interfaces = os.networkInterfaces();
  const results: HostNetworkInterfaceItem[] = [];

  for (const name of Object.keys(interfaces)) {
    const netList = interfaces[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4') {
        results.push({
          interface: name,
          address: net.address,
          family: net.family,
          mac: net.mac || 'N/A',
          netmask: net.netmask || '',
          internal: net.internal,
        });
      }
    }
  }

  return results;
}

let cachedPartitions: HostDiskPartition[] = [];
let lastPartitionsScanTime = 0;

/** 探测本机所有磁盘卷与分区挂载 (带 15 秒轻量缓存) */
function getDiskPartitions(): HostDiskPartition[] {
  const now = Date.now();
  if (cachedPartitions.length > 0 && now - lastPartitionsScanTime < 15000) {
    return cachedPartitions;
  }

  const partitions: HostDiskPartition[] = [];
  if (typeof fs.statfsSync !== 'function') return partitions;

  const candidateMounts: string[] = [];
  if (process.platform === 'win32') {
    const letters = ['C:\\', 'D:\\', 'E:\\'];
    candidateMounts.push(...letters);
  } else {
    candidateMounts.push('/', '/home', '/var', '/tmp', '/Volumes');
  }

  const seen = new Set<string>();

  for (const mount of candidateMounts) {
    try {
      if (!fs.existsSync(mount)) continue;
      const stat = fs.statfsSync(mount);
      if (stat.blocks <= 0) continue;
      const total = stat.bsize * stat.blocks;
      const free = stat.bsize * stat.bfree;
      const used = total - free;
      const key = `${total}_${free}`;
      if (seen.has(key)) continue; // 去重相同物理挂载
      seen.add(key);

      partitions.push({
        mount,
        totalBytes: total,
        freeBytes: free,
        usedBytes: used,
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
      });
    } catch {}
  }

  cachedPartitions = partitions;
  lastPartitionsScanTime = now;
  return partitions;
}

let cachedTopProcesses: HostTopProcess[] = [];
let lastTopProcessesScanTime = 0;

/** 探测本机高内存消耗活跃进程 Top 榜单 (带 30 秒缓存，杜绝频繁 execSync 阻塞) */
function getTopProcesses(limit = 6): HostTopProcess[] {
  const now = Date.now();
  if (cachedTopProcesses.length > 0 && now - lastTopProcessesScanTime < 30000) {
    return cachedTopProcesses.slice(0, limit);
  }

  const list: HostTopProcess[] = [];
  try {
    if (process.platform === 'win32') {
      const output = execSync('tasklist /FO CSV /NH', { timeout: 600, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const rows = output.trim().split('\n');
      for (const row of rows) {
        const parts = row.split('","').map(s => s.replace(/"/g, '').trim());
        if (parts.length >= 5) {
          const name = parts[0] || 'Unknown';
          const pid = parseInt(parts[1] || '0', 10);
          const rawMem = parts[4] || '0';
          const memKb = parseInt(rawMem.replace(/[^0-9]/g, ''), 10) || 0;
          if (!isNaN(pid) && pid > 0 && memKb > 0) {
            list.push({
              pid,
              name,
              memoryBytes: memKb * 1024,
              memoryFormatted: formatBytes(memKb * 1024),
            });
          }
        }
      }
      list.sort((a, b) => b.memoryBytes - a.memoryBytes);
      cachedTopProcesses = list;
      lastTopProcessesScanTime = now;
      return list.slice(0, limit);
    } else {
      const output = execSync('ps -axo pid=,rss=,comm=', { timeout: 600, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const rows = output.trim().split('\n');
      for (const row of rows) {
        const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
        if (!match) continue;
        const pid = parseInt(match[1] || '0', 10);
        const rssKb = parseInt(match[2] || '0', 10) || 0;
        const name = match[3] || 'Unknown';
        if (pid <= 0 || rssKb <= 0) continue;
        list.push({
          pid,
          name,
          memoryBytes: rssKb * 1024,
          memoryFormatted: formatBytes(rssKb * 1024),
        });
      }
      list.sort((a, b) => b.memoryBytes - a.memoryBytes);
      cachedTopProcesses = list;
      lastTopProcessesScanTime = now;
      return list.slice(0, limit);
    }
  } catch {}
  return cachedTopProcesses.slice(0, limit);
}

/** 获取当前宿主主机的超详细实时系统与硬件指标 */
export function getHostSystemInfo(): HostSystemInfo {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const procMem = process.memoryUsage();

  let username = 'unknown';
  try {
    username = os.userInfo().username;
  } catch {}

  const partitions = getDiskPartitions();
  let diskTotal = 0;
  let diskFree = 0;
  let diskUsed = 0;
  let diskUsedPercent = 0;
  let mountPoint = process.cwd();

  if (partitions.length > 0) {
    const mainDisk = partitions[0]!;
    diskTotal = mainDisk.totalBytes;
    diskFree = mainDisk.freeBytes;
    diskUsed = mainDisk.usedBytes;
    diskUsedPercent = mainDisk.usedPercent;
    mountPoint = mainDisk.mount;
  }

  const perCoreCpus: HostCpuCore[] = (cpus || []).map((c, i) => ({
    coreIndex: i,
    model: c.model,
    speedMHz: c.speed,
    times: c.times,
  }));

  const versions: HostProcessVersions = {
    node: process.versions.node || '',
    v8: process.versions.v8 || '',
    uv: process.versions.uv || '',
    zlib: process.versions.zlib || '',
    openssl: process.versions.openssl || '',
  };

  return {
    os: {
      platform: process.platform,
      type: os.type(),
      release: os.release(),
      arch: process.arch,
      endianness: os.endianness(),
      uptimeSeconds: Math.floor(os.uptime()),
      processUptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      pid: process.pid,
      ppid: process.ppid || 0,
      user: username,
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
      execPath: process.execPath,
      cwd: process.cwd(),
      versions,
    },
    cpu: {
      model: cpus[0]?.model || 'Generic CPU',
      cores: cpus.length,
      speedMHz: cpus[0]?.speed || 0,
      usagePercent: calculateCpuUsage(),
      loadAvg: os.loadavg(),
      perCore: perCoreCpus,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: Math.round((usedMem / (totalMem || 1)) * 100),
      processRssBytes: procMem.rss,
      processHeapTotalBytes: procMem.heapTotal,
      processHeapUsedBytes: procMem.heapUsed,
      processExternalBytes: procMem.external || 0,
      processArrayBuffersBytes: procMem.arrayBuffers || 0,
    },
    disk: {
      totalBytes: diskTotal,
      freeBytes: diskFree,
      usedBytes: diskUsed,
      usedPercent: diskUsedPercent,
      mount: mountPoint,
      partitions,
    },
    network: {
      hostname: os.hostname(),
      ips: getNetworkIps(),
    },
    topProcesses: getTopProcesses(6),
    loadAvg: os.loadavg(),
    timestamp: Date.now(),
  };
}

/** 格式化字节为易读的人类可读字符串 (KB, MB, GB, TB) */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/** 格式化运行时间为 天/时/分/秒 */
export function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return '0秒';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0 || d > 0) parts.push(`${h}小时`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join(' ');
}
