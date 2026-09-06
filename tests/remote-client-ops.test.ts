import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/remote/ssh-installer.js', () => ({
  execSshCommand: vi.fn(),
  testSshConnection: vi.fn(),
}));

import { execSshCommand } from '../src/remote/ssh-installer.js';
import { RemoteClientManager } from '../src/remote/client.js';
import type { RemoteServerConfig } from '../src/remote/types.js';

const mockedExecSshCommand = vi.mocked(execSshCommand);

function config(port: number, platform = 'linux'): RemoteServerConfig {
  return {
    id: 'srv-client',
    name: 'Client node',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    daemonPort: port,
    token: 'token',
    status: 'online',
    systemInfo: {
      hostname: 'remote-node',
      platform,
      arch: 'x64',
      osRelease: 'test',
      uptimeSeconds: 1,
      cpuCount: 2,
      cpuModel: 'test',
      cpuUsagePercent: 1,
      totalMemBytes: 2,
      freeMemBytes: 1,
      usedMemPercent: 50,
      loadAvg: [0, 0, 0],
      timestamp: Date.now(),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const DF_BEFORE = [
  'Filesystem 1024-blocks Used Available Capacity Mounted on',
  '/dev/root 100000 40000 60000 40% /',
].join('\n');

const DU_BEFORE = [
  '12000\t/var/log',
  '8000\t/tmp',
  '5000\t/root/.npm/_cacache',
].join('\n');

describe('RemoteClientManager diagnostics and disk operations', () => {
  afterEach(() => {
    mockedExecSshCommand.mockReset();
    vi.restoreAllMocks();
  });

  it('reads a structured process list from the daemon', async () => {
    let requestedPath = '';
    const { server, port } = await listen((req, res) => {
      requestedPath = req.url || '';
      json(res, 200, {
        ok: true,
        data: {
          processes: [{ pid: 42, ppid: 1, user: 'root', cpuPercent: 1.5, memPercent: 2, elapsedSeconds: 10, command: 'node app.js' }],
          limit: 25,
          timestamp: 1,
        },
      });
    });

    try {
      const result = await new RemoteClientManager().listProcesses(config(port), { limit: 25 });
      expect(requestedPath).toBe('/api/processes?limit=25');
      expect(result.processes[0]?.pid).toBe(42);
      expect(result.limit).toBe(25);
    } finally {
      await close(server);
    }
  });

  it('filters unsafe daemon process records before exposing them to callers', async () => {
    const { server, port } = await listen((_req, res) => json(res, 200, {
      ok: true,
      data: {
        processes: [
          { pid: 42, ppid: 1, user: 'root', cpuPercent: 1, memPercent: 2, command: 'worker' },
          { pid: Number.MAX_SAFE_INTEGER + 1, ppid: 1, cpuPercent: 1, memPercent: 2, command: 'unsafe pid' },
          { pid: 45, ppid: Number.MAX_SAFE_INTEGER + 1, cpuPercent: 1, memPercent: 2, command: 'unsafe ppid' },
          { pid: 43, ppid: 1, cpuPercent: -1, memPercent: 2, command: 'negative cpu' },
          { pid: 44, ppid: 1, cpuPercent: 1, memPercent: -2, command: 'negative mem' },
        ],
      },
    }));

    try {
      const result = await new RemoteClientManager().listProcesses(config(port), { limit: 10 });
      expect(result.processes).toHaveLength(1);
      expect(result.processes[0]).toMatchObject({ pid: 42, command: 'worker' });
    } finally {
      await close(server);
    }
  });

  it('falls back to a bounded, machine-readable SSH ps command when the daemon returns 404', async () => {
    mockedExecSshCommand.mockResolvedValue({
      code: 0,
      stdout: '42 1 root 1.5 2.0 10 node app.js\n43 1 app 0.1 0.2 20 worker\n',
      stderr: '',
    });
    const { server, port } = await listen((_req, res) => json(res, 404, { ok: false, error: 'Endpoint not found' }));

    try {
      const result = await new RemoteClientManager().listProcesses(config(port), { limit: 1 });
      expect(result.processes).toHaveLength(1);
      expect(result.processes[0]?.command).toBe('node app.js');
      expect(mockedExecSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('ps -eo'), expect.any(Number));
    } finally {
      await close(server);
    }
  });

  it('preserves elapsed runtime when the SSH process row includes etimes and lstart', async () => {
    mockedExecSshCommand.mockResolvedValue({
      code: 0,
      stdout: '42 1 root 1.5 2.0 99 Wed Sep  2 20:38:53 2026 node app.js\n',
      stderr: '',
    });
    const { server, port } = await listen((_req, res) => json(res, 404, { ok: false, error: 'Endpoint not found' }));

    try {
      const result = await new RemoteClientManager().listProcesses(config(port), { limit: 10 });
      expect(result.processes[0]).toMatchObject({
        pid: 42,
        elapsedSeconds: 99,
        startTime: 'Wed Sep 2 20:38:53 2026',
        command: 'node app.js',
      });
      expect(mockedExecSshCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('etimes=,lstart='),
        expect.any(Number),
      );
    } finally {
      await close(server);
    }
  });

  it('rejects malformed start tokens and unsafe numeric fields from SSH output', async () => {
    mockedExecSshCommand.mockResolvedValue({
      code: 0,
      stdout: [
        '42 1 root 1.0 2.0 10 Xxx Sep 2 20:38:53 2026 malformed-weekday',
        '9007199254740992 1 root 1.0 2.0 10 Wed Sep 2 20:38:53 2026 unsafe-pid',
        '43 9007199254740992 root 1.0 2.0 10 Wed Sep 2 20:38:53 2026 unsafe-ppid',
      ].join('\n'),
      stderr: '',
    });
    const { server, port } = await listen((_req, res) => json(res, 404, { ok: false, error: 'Endpoint not found' }));

    try {
      const result = await new RemoteClientManager().listProcesses(config(port), { limit: 10 });
      expect(result.processes).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it('sends a guarded TERM request to the daemon', async () => {
    let body = '';
    const { server, port } = await listen((req, res) => {
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => json(res, 200, { ok: true, data: { pid: 42, signal: 'TERM', killed: true } }));
    });

    try {
      const result = await new RemoteClientManager().killProcess(config(port), 42, 'TERM', '2026-09-05T00:00:00.000Z');
      expect(JSON.parse(body)).toEqual({ signal: 'TERM', expectedStartTime: '2026-09-05T00:00:00.000Z' });
      expect(result).toMatchObject({ pid: 42, signal: 'TERM', killed: true });
    } finally {
      await close(server);
    }
  });

  it('keeps expectedStartTime stable across list then kill', async () => {
    const startTime = '2026-09-05T00:00:00.000Z';
    const requests: string[] = [];
    const { server, port } = await listen((req, res) => {
      requests.push(req.url || '');
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          data: { processes: [{ pid: 42, ppid: 1, user: 'root', cpuPercent: 0, memPercent: 0, startTime, command: 'worker' }], timestamp: 1 },
        });
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        expect(JSON.parse(body).expectedStartTime).toBe(startTime);
        json(res, 200, { ok: true, data: { pid: 42, signal: 'TERM', killed: true } });
      });
    });

    try {
      const client = new RemoteClientManager();
      const listed = await client.listProcesses(config(port));
      const result = await client.killProcess(config(port), 42, 'TERM', listed.processes[0]?.startTime);
      expect(result.killed).toBe(true);
      expect(requests).toEqual(['/api/processes?limit=100', '/api/processes/42/kill']);
    } finally {
      await close(server);
    }
  });

  it('rejects non-decimal and protected PIDs before making a request', async () => {
    const client = new RemoteClientManager();
    await expect(client.killProcess(config(1), '1e3' as unknown as number, 'TERM')).rejects.toThrow('Invalid PID');
    await expect(client.killProcess(config(1), 1, 'TERM')).rejects.toThrow('Protected PID');
    await expect(client.killProcess(config(1), 42, 'HUP' as unknown as 'TERM')).rejects.toThrow('Invalid signal');
    expect(mockedExecSshCommand).not.toHaveBeenCalled();
  });

  it('does not SSH-kill a PID when a daemon 404 reports a missing process', async () => {
    const { server, port } = await listen((_req, res) => json(res, 404, { ok: false, error: 'No such process' }));
    try {
      const result = await new RemoteClientManager().killProcess(config(port), 42, 'TERM');
      expect(result).toMatchObject({ pid: 42, killed: false });
      expect(mockedExecSshCommand).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('uses a validated SSH kill command after a missing daemon endpoint', async () => {
    mockedExecSshCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const { server, port } = await listen((_req, res) => json(res, 404, { ok: false, error: 'Endpoint not found' }));

    try {
      const result = await new RemoteClientManager().killProcess(config(port), 42, 'KILL');
      expect(result).toMatchObject({ pid: 42, signal: 'KILL', killed: true });
      expect(mockedExecSshCommand).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/kill\s+-KILL\s+42/), expect.any(Number));
    } finally {
      await close(server);
    }
  });

  it('checks the expected start time and kills in one SSH transaction', async () => {
    const sshCommands: string[] = [];
    mockedExecSshCommand.mockImplementation(async (_config, command) => {
      sshCommands.push(command);
      // The pre-fix implementation performs a separate `ps -eo` list call
      // before issuing the kill. Returning a valid row for that call makes
      // the race observable while keeping the final command successful.
      if (command.includes('ps -eo')) {
        return {
          code: 0,
          stdout: '42 1 root 0.0 0.0 Wed Sep  2 20:38:53 2026 worker\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const { server, port } = await listen((_req, res) => json(res, 404, { ok: false, error: 'Endpoint not found' }));

    try {
      const result = await new RemoteClientManager().killProcess(
        config(port),
        42,
        'TERM',
        'Wed Sep 2 20:38:53 2026',
      );
      expect(result).toMatchObject({ pid: 42, signal: 'TERM', killed: true });
      expect(sshCommands).toHaveLength(1);
      expect(sshCommands[0]).toContain('CURRENT_START');
      expect(sshCommands[0]).toMatch(/ps -p 42/);
      expect(sshCommands[0]).toMatch(/kill -TERM 42/);
    } finally {
      await close(server);
    }
  });

  it('rejects invalid process list limits before contacting the daemon or SSH', async () => {
    const client = new RemoteClientManager();
    const invalidLimits = [0, -1, 1.5, 501, Number.NaN, Number.POSITIVE_INFINITY];
    for (const limit of invalidLimits) {
      await expect(client.listProcesses(config(1), { limit })).rejects.toThrow('Invalid process limit');
    }
    expect(mockedExecSshCommand).not.toHaveBeenCalled();
  });

  it('parses actual df/du values into stable remote item ids', async () => {
    const { server, port } = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        const command = JSON.parse(body).command as string;
        json(res, 200, {
          ok: true,
          data: { code: 0, stdout: command.includes('df -kP') ? DF_BEFORE : DU_BEFORE, stderr: '', durationMs: 1 },
        });
      });
    });

    try {
      const report = await new RemoteClientManager().scanDisk(config(port));
      expect(report.target).toBe('srv-client');
      expect(report.items.find((item) => item.id === 'remote_logs')?.sizeBytes).toBe(12000 * 1024);
      expect(report.items.find((item) => item.id === 'remote_tmp')?.sizeBytes).toBe(8000 * 1024);
      expect(report.totalCleanableBytes).toBe((12000 + 8000 + 5000) * 1024);
      expect(report.safeCleanableBytes).toBe((12000 + 5000) * 1024);
      expect(report.platform).toBe('linux');
      expect(report.platformLabel).toBe('Linux');
    } finally {
      await close(server);
    }
  });

  it('cleans only selected known ids and reports the measured before/after delta', async () => {
    let du = DU_BEFORE;
    const commands: string[] = [];
    const client = new RemoteClientManager();
    vi.spyOn(client, 'execCommand').mockImplementation(async (_config, command) => {
      commands.push(command);
      if (command.includes('df -kP')) return { code: 0, stdout: DF_BEFORE, stderr: '', durationMs: 1 };
      if (command.includes('du -sk')) return { code: 0, stdout: du, stderr: '', durationMs: 1 };
      du = ['0\t/var/log', '8000\t/tmp', '5000\t/root/.npm/_cacache'].join('\n');
      return { code: 0, stdout: '', stderr: '', durationMs: 1 };
    });

    const result = await client.cleanDisk(config(1), ['remote_logs', 'unknown-item']);

    expect(result.cleanedBytes).toBe(12000 * 1024);
    expect(result.deletedItems).toEqual([expect.stringContaining('系统与服务日志 (/var/log)')]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe('unknown-item');
    expect(result.errors[0]?.error.toLowerCase()).toContain('unknown');
    const cleanupCommands = commands.filter((command) => command.includes('/var/log') && command.includes('find '));
    expect(cleanupCommands).toHaveLength(1);
    expect(cleanupCommands[0]).toContain('/var/log');
    expect(cleanupCommands[0]).not.toContain('/tmp');
  });

  it('does not retry a destructive cleanup over SSH after a daemon transport error', async () => {
    const cleanupCommands: string[] = [];
    const { server, port } = await listen((req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/exec') {
        json(res, 404, { ok: false, error: 'Endpoint not found' });
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        const command = JSON.parse(body).command as string;
        if (command.includes('df -kP')) {
          json(res, 200, { ok: true, data: { code: 0, stdout: DF_BEFORE, stderr: '', durationMs: 1 } });
          return;
        }
        if (command.includes('du -sk')) {
          json(res, 200, { ok: true, data: { code: 0, stdout: DU_BEFORE, stderr: '', durationMs: 1 } });
          return;
        }
        cleanupCommands.push(command);
        // The remote command may have run even though its HTTP response was
        // lost. The client must surface the uncertainty, not issue it again.
        req.socket.destroy();
      });
    });
    mockedExecSshCommand.mockImplementation(async (_config, command) => ({
      code: 0,
      stdout: `UNEXPECTED SSH FALLBACK: ${command}`,
      stderr: '',
    }));

    try {
      const result = await new RemoteClientManager().cleanDisk(config(port), ['remote_logs']);
      expect(cleanupCommands).toHaveLength(1);
      expect(mockedExecSshCommand).not.toHaveBeenCalled();
      expect(result.cleanedBytes).toBe(0);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'remote_logs' }),
      ]));
    } finally {
      await close(server);
    }
  });

  it('parses real SSH system metrics instead of returning placeholder values', async () => {
    mockedExecSshCommand.mockResolvedValue({
      code: 0,
      stdout: [
        '__HAP_HOSTNAME__', 'edge-1',
        '__HAP_PLATFORM__', 'Linux',
        '__HAP_ARCH__', 'x86_64',
        '__HAP_OS_RELEASE__', 'Ubuntu 24.04.1 LTS',
        '__HAP_UPTIME__', '9876.5',
        '__HAP_CPU_COUNT__', '8',
        '__HAP_CPU_MODEL__', 'AMD EPYC 7B13',
        '__HAP_CPU_USAGE__', '37.5',
        '__HAP_MEM_TOTAL__', '17179869184',
        '__HAP_MEM_FREE__', '4294967296',
        '__HAP_LOADAVG__', '1.2 0.8 0.6',
        '__HAP_DISK__', '107374182400 53687091200 53687091200 50% /',
      ].join('\n'),
      stderr: '',
    });

    const info = await (new RemoteClientManager() as any).fetchSshSysInfo(config(1));

    expect(info).toMatchObject({
      hostname: 'edge-1',
      platform: 'linux',
      arch: 'x86_64',
      osRelease: 'Ubuntu 24.04.1 LTS',
      uptimeSeconds: 9876,
      cpuCount: 8,
      cpuModel: 'AMD EPYC 7B13',
      cpuUsagePercent: 37.5,
      totalMemBytes: 17179869184,
      freeMemBytes: 4294967296,
      usedMemPercent: 75,
      loadAvg: [1.2, 0.8, 0.6],
      diskTotalBytes: 107374182400,
      diskUsedBytes: 53687091200,
      diskFreeBytes: 53687091200,
      diskUsedPercent: 50,
    });
    expect(info.cpuModel).not.toBe('Remote CPU');
    expect(info.loadAvg).not.toEqual([0.1, 0.1, 0.1]);
  });
});
