import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('../src/system/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/system/index.js')>('../src/system/index.js');
  return {
    ...actual,
    scanLocalDisk: vi.fn(),
    cleanLocalDisk: vi.fn(),
  };
});

import { GuiService } from '../src/gui/service.js';
import { RemoteClientManager, RemoteServerStore, type RemoteProcessList, type RemoteServerConfig } from '../src/remote/index.js';
import * as system from '../src/system/index.js';

function serverConfig(): RemoteServerConfig {
  return {
    id: 'srv-gui',
    name: 'GUI node',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    daemonPort: 9527,
    status: 'online',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('GuiService remote diagnostics boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a server by id or name before delegating a real disk scan', async () => {
    const server = serverConfig();
    vi.spyOn(RemoteServerStore.getInstance(), 'get').mockReturnValue(undefined);
    vi.spyOn(RemoteServerStore.getInstance(), 'list').mockReturnValue([server]);
    const scanDisk = vi.fn(async () => ({
      target: server.id,
      totalCleanableBytes: 123,
      safeCleanableBytes: 123,
      reviewCleanableBytes: 0,
      healthScore: 100,
      aiDiagnosis: 'ok',
      scannedRoots: ['/'],
      items: [],
      scannedAt: Date.now(),
    }));
    vi.spyOn(RemoteClientManager, 'getInstance').mockReturnValue({ scanDisk } as unknown as RemoteClientManager);

    const result = await new GuiService().scanDiskCleanable('GUI node');

    expect(scanDisk).toHaveBeenCalledWith(server);
    expect(result.target).toBe(server.id);
    expect(result.totalCleanableBytes).toBe(123);
  });

  it('delegates selected remote cleanup and process controls through the server id', async () => {
    const server = serverConfig();
    vi.spyOn(RemoteServerStore.getInstance(), 'get').mockImplementation((id) => id === server.id ? server : undefined);
    const cleanDisk = vi.fn(async () => ({
      target: server.id,
      cleanedBytes: 64,
      deletedItems: ['remote_logs'],
      errors: [],
      cleanedAt: Date.now(),
    }));
    const processes: RemoteProcessList = { processes: [], limit: 20, timestamp: Date.now() };
    const listProcesses = vi.fn(async () => processes);
    const killProcess = vi.fn(async () => ({ pid: 42, signal: 'TERM' as const, killed: true }));
    vi.spyOn(RemoteClientManager, 'getInstance').mockReturnValue({ cleanDisk, listProcesses, killProcess } as unknown as RemoteClientManager);

    const service = new GuiService();
    const cleanResult = await service.executeDiskCleanup({ server: server.id, itemIds: ['remote_logs'] });
    const processResult = await service.getServerProcesses(server.id, { limit: 20 });
    const killResult = await service.killServerProcess({ id: server.id, pid: 42, signal: 'TERM', expectedStartTime: '2026-09-05T00:00:00.000Z' });

    expect(cleanDisk).toHaveBeenCalledWith(server, ['remote_logs']);
    expect(cleanResult.cleanedBytes).toBe(64);
    expect(listProcesses).toHaveBeenCalledWith(server, { limit: 20 });
    expect(processResult).toBe(processes);
    expect(killProcess).toHaveBeenCalledWith(server, 42, 'TERM', '2026-09-05T00:00:00.000Z');
    expect(killResult.killed).toBe(true);
  });

  it('treats local and host aliases as local disk operations', async () => {
    const report = {
      target: 'local' as const,
      totalCleanableBytes: 0,
      safeCleanableBytes: 0,
      reviewCleanableBytes: 0,
      healthScore: 100,
      aiDiagnosis: 'ok',
      scannedRoots: ['/'],
      items: [],
      scannedAt: Date.now(),
    };
    const cleaned = { target: 'local' as const, cleanedBytes: 0, deletedItems: [], errors: [], cleanedAt: Date.now() };
    const scanLocalDisk = vi.mocked(system.scanLocalDisk);
    const cleanLocalDisk = vi.mocked(system.cleanLocalDisk);
    scanLocalDisk.mockResolvedValue(report);
    cleanLocalDisk.mockResolvedValue(cleaned);

    const service = new GuiService();
    await service.scanDiskCleanable('local');
    await service.scanDiskCleanable('host');
    await service.executeDiskCleanup({ server: 'local', itemIds: [] });
    await service.executeDiskCleanup({ server: 'host', itemIds: [] });

    expect(scanLocalDisk).toHaveBeenCalledTimes(4);
    expect(cleanLocalDisk).toHaveBeenCalledWith([], report);
  });

  it('supports terminating local processes with PID guards', async () => {
    const service = new GuiService();
    await expect(service.killServerProcess({ serverId: 'local', pid: 1, signal: 'KILL' })).rejects.toThrow('禁止终止系统受保护的核心进程');
    await expect(service.killServerProcess({ serverId: 'local', pid: process.pid, signal: 'KILL' })).rejects.toThrow('禁止终止当前平台管理服务进程');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const result = await service.killServerProcess({ serverId: 'local', pid: 999999, signal: 'KILL' });
    expect(killSpy).toHaveBeenCalledWith(999999, 'SIGKILL');
    expect(result.killed).toBe(true);
    killSpy.mockRestore();
  });
});
