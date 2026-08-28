import os from 'node:os';
import process from 'node:process';
import fs from 'node:fs';

export interface HostCpuInfo {
  model: string;
  cores: number;
  speedMHz: number;
  usagePercent: number;
}

export interface HostMemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  processRssBytes: number;
  processHeapTotalBytes: number;
  processHeapUsedBytes: number;
}

export interface HostNetworkInfo {
  hostname: string;
  ips: Array<{ interface: string; address: string; family: string }>;
}

export interface HostOsInfo {
  platform: string; // win32, darwin, linux
  type: string; // Windows_NT, Darwin, Linux
  release: string;
  arch: string;
  uptimeSeconds: number;
  processUptimeSeconds: number;
  nodeVersion: string;
  pid: number;
  user: string;
}

export interface HostDiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  mount: string;
}

export interface HostSystemInfo {
  os: HostOsInfo;
  cpu: HostCpuInfo;
  memory: HostMemoryInfo;
  disk: HostDiskInfo;
  network: HostNetworkInfo;
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

/** 获取局域网与物理网卡 IPv4 列表 */
function getNetworkIps(): Array<{ interface: string; address: string; family: string }> {
  const interfaces = os.networkInterfaces();
  const results: Array<{ interface: string; address: string; family: string }> = [];

  for (const name of Object.keys(interfaces)) {
    const netList = interfaces[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({
          interface: name,
          address: net.address,
          family: net.family,
        });
      }
    }
  }

  return results;
}

/** 获取当前宿主主机的实时系统与硬件指标 */
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

  let diskTotal = 0;
  let diskFree = 0;
  let diskUsed = 0;
  let diskUsedPercent = 0;
  let mountPoint = process.cwd();

  try {
    if (typeof fs.statfsSync === 'function') {
      const rootPath = process.platform === 'win32' ? process.cwd().slice(0, 3) : '/';
      const stat = fs.statfsSync(rootPath);
      diskTotal = stat.bsize * stat.blocks;
      diskFree = stat.bsize * stat.bfree;
      diskUsed = diskTotal - diskFree;
      diskUsedPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
      mountPoint = rootPath;
    }
  } catch {}

  return {
    os: {
      platform: process.platform,
      type: os.type(),
      release: os.release(),
      arch: process.arch,
      uptimeSeconds: Math.floor(os.uptime()),
      processUptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      pid: process.pid,
      user: username,
    },
    cpu: {
      model: cpus[0]?.model || 'Generic CPU',
      cores: cpus.length,
      speedMHz: cpus[0]?.speed || 0,
      usagePercent: calculateCpuUsage(),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: Math.round((usedMem / (totalMem || 1)) * 100),
      processRssBytes: procMem.rss,
      processHeapTotalBytes: procMem.heapTotal,
      processHeapUsedBytes: procMem.heapUsed,
    },
    disk: {
      totalBytes: diskTotal,
      freeBytes: diskFree,
      usedBytes: diskUsed,
      usedPercent: diskUsedPercent,
      mount: mountPoint,
    },
    network: {
      hostname: os.hostname(),
      ips: getNetworkIps(),
    },
    loadAvg: os.loadavg(),
    timestamp: Date.now(),
  };
}

/** 格式化字节为易读的人类可读字符串 (KB, MB, GB) */
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
