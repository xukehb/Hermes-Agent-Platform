import { describe, it, expect } from 'vitest';
import { getHostSystemInfo, formatBytes, formatUptime } from '../src/system/index.js';
import { hostSysinfoTool } from '../src/tools/builtin/host-tools.js';
import { createWebApp } from '../src/web/server.js';

describe('Host System Status & Diagnostics', () => {
  it('collects host system info with non-empty fields', () => {
    const info = getHostSystemInfo();

    // OS
    expect(info.os).toBeDefined();
    expect(info.os.platform).toBeTruthy();
    expect(info.os.nodeVersion).toBeTruthy();
    expect(info.os.pid).toBeGreaterThan(0);
    expect(info.os.uptimeSeconds).toBeGreaterThan(0);

    // CPU
    expect(info.cpu).toBeDefined();
    expect(info.cpu.cores).toBeGreaterThan(0);
    expect(info.cpu.model).toBeTruthy();
    expect(info.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(info.cpu.usagePercent).toBeLessThanOrEqual(100);

    // Memory
    expect(info.memory).toBeDefined();
    expect(info.memory.totalBytes).toBeGreaterThan(0);
    expect(info.memory.freeBytes).toBeGreaterThan(0);
    expect(info.memory.usedBytes).toBeGreaterThan(0);
    expect(info.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(info.memory.usedPercent).toBeLessThanOrEqual(100);
    expect(info.memory.processRssBytes).toBeGreaterThan(0);

    // Network
    expect(info.network).toBeDefined();
    expect(info.network.hostname).toBeTruthy();
    expect(Array.isArray(info.network.ips)).toBe(true);

    // Unix process collection must work on both GNU/Linux and BSD/macOS ps.
    if (process.platform !== 'win32') {
      expect(info.topProcesses.length).toBeGreaterThan(0);
      expect(info.topProcesses[0]?.pid).toBeGreaterThan(0);
      expect(info.topProcesses[0]?.memoryBytes).toBeGreaterThan(0);
    }
  });

  it('formats bytes and uptime into human-readable strings', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 16)).toBe('16 GB');

    expect(formatUptime(45)).toBe('45秒');
    expect(formatUptime(3665)).toBe('1小时 1分 5秒');
    expect(formatUptime(90065)).toBe('1天 1小时 1分 5秒');
  });

  it('hostSysinfoTool executes successfully and outputs markdown diagnostics', async () => {
    const res = await hostSysinfoTool.handler({}, {} as any);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('宿主主机系统状态');
    expect(res.content).toContain('CPU 状态');
    expect(res.content).toContain('内存状态');
  });

  it('web server provides /api/host/sysinfo endpoint', async () => {
    const app = createWebApp();
    const res = await app.request('/api/host/sysinfo');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.cpu.cores).toBeGreaterThan(0);
    expect(json.data.memory.totalBytes).toBeGreaterThan(0);
  });
});
