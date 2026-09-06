import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import {
  generateRemoteDaemonScript,
  RemoteServerStore,
  RemoteClientManager,
  type RemoteServerConfig,
} from '../src/remote/index.js';


describe('Remote Server Management & Protocol', () => {
  const roots: string[] = [];

  function tempFile(): string {
    const root = mkdtempSync(join(tmpdir(), 'hap-remote-test-'));
    roots.push(root);
    return join(root, 'servers.json');
  }

  afterAll(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {}
    }
  });

  it('generates a valid, self-contained remote daemon script', () => {
    const script = generateRemoteDaemonScript({ port: 9527, token: 'test-secret-token' });
    expect(script).toContain('PORT = 9527');
    expect(script).toContain('AUTH_TOKEN = "test-secret-token"');
    expect(script).toContain('getSystemInfo()');
    expect(script).toContain('server.listen(PORT');
  });

  it('uses a PID file instead of pkill pattern matching when restarting the daemon', () => {
    const installerPath = fileURLToPath(new URL('../src/remote/ssh-installer.ts', import.meta.url));
    const installerSource = readFileSync(installerPath, 'utf-8');

    expect(installerSource).toContain('PID_FILE="$HAP_DIR/daemon.pid"');
    expect(installerSource).not.toContain('pkill -9 -f');
    expect(installerSource).toContain('if (startRes.code !== 0)');
  });

  it('omits an undefined bind when constructing daemon script options', () => {
    const installerPath = fileURLToPath(new URL('../src/remote/ssh-installer.ts', import.meta.url));
    const installerSource = readFileSync(installerPath, 'utf-8');

    expect(installerSource).toContain('...(options.bind !== undefined ? { bind: options.bind } : {})');
    expect(installerSource).not.toContain('generateRemoteDaemonScript({ port: daemonPort, token, bind: options.bind })');
  });

  it('performs CRUD on RemoteServerStore in isolation', () => {
    const storeFile = tempFile();
    const store = new RemoteServerStore(storeFile);

    expect(store.list()).toEqual([]);

    // 1. Upsert (Create)
    const server1 = store.upsert({
      id: 'srv-1',
      name: 'Development Server',
      host: '192.168.1.100',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'mypassword',
      daemonPort: 9527,
    });

    expect(server1.id).toBe('srv-1');
    expect(server1.name).toBe('Development Server');
    expect(server1.status).toBe('uninstalled');

    // 2. List
    const all = store.list();
    expect(all.length).toBe(1);
    expect(all[0]?.id).toBe('srv-1');

    // 3. Get
    const fetched = store.get('srv-1');
    expect(fetched?.host).toBe('192.168.1.100');

    // 4. Update Status
    store.updateStatus('srv-1', {
      status: 'online',
      token: 'tok-abc',
      systemInfo: {
        hostname: 'node-dev',
        platform: 'linux',
        arch: 'x64',
        osRelease: 'Ubuntu 24.04 LTS',
        uptimeSeconds: 3600,
        cpuCount: 8,
        cpuModel: 'Intel Xeon',
        cpuUsagePercent: 12.5,
        totalMemBytes: 16 * 1024 * 1024 * 1024,
        freeMemBytes: 8 * 1024 * 1024 * 1024,
        usedMemPercent: 50,
        loadAvg: [0.5, 0.3, 0.1],
        timestamp: Date.now(),
      },
    });

    const updated = store.get('srv-1');
    expect(updated?.status).toBe('online');
    expect(updated?.token).toBe('tok-abc');
    expect(updated?.systemInfo?.hostname).toBe('node-dev');

    // 5. Remove
    const removed = store.remove('srv-1');
    expect(removed).toBe(true);
    expect(store.list().length).toBe(0);

    const fileMode = statSync(storeFile).mode & 0o777;
    const dirMode = statSync(dirname(storeFile)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    }
  });

  describe('Remote Daemon RPC Simulation', () => {
    let mockServer: http.Server;
    let mockPort = 0;
    const MOCK_TOKEN = 'mock-secret-token-123';

    beforeAll(async () => {
      mockServer = http.createServer((req, res) => {
        const auth = req.headers['authorization'] || req.headers['x-hap-token'];
        const isAuth = auth === `Bearer ${MOCK_TOKEN}` || auth === MOCK_TOKEN;

        if (req.url === '/health' || req.url === '/ping') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'online', uptime: 5000 }));
          return;
        }

        if (!isAuth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }

        if (req.url === '/api/sysinfo' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            data: {
              hostname: 'mock-vps',
              platform: 'linux',
              arch: 'x64',
              osRelease: 'Debian GNU/Linux 12',
              uptimeSeconds: 12000,
              cpuCount: 4,
              cpuModel: 'AMD EPYC',
              cpuUsagePercent: 25.0,
              totalMemBytes: 8589934592,
              freeMemBytes: 4294967296,
              usedMemPercent: 50.0,
              loadAvg: [0.2, 0.4, 0.1],
              timestamp: Date.now(),
            },
          }));
          return;
        }

        if (req.url === '/api/exec' && req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', () => {
            const { command } = JSON.parse(body || '{}');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              data: {
                code: 0,
                stdout: `Executed: ${command}\nOutput: Linux mock-vps 6.1.0-x86_64`,
                stderr: '',
                durationMs: 15,
              },
            }));
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address() as { port: number };
          mockPort = addr.port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        mockServer.close(() => resolve());
      });
    });

    it('successfully connects to daemon, queries sysinfo and executes command', async () => {
      const client = RemoteClientManager.getInstance();
      const config: RemoteServerConfig = {
        id: 'mock-1',
        name: 'Mock Daemon Server',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        daemonPort: mockPort,
        token: MOCK_TOKEN,
        status: 'online',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Test connection
      const conn = await client.testConnection(config);
      expect(conn.ok).toBe(true);
      expect(conn.mode).toBe('daemon');
      expect(conn.systemInfo?.hostname).toBe('mock-vps');
      expect(conn.systemInfo?.cpuCount).toBe(4);

      // Get sysinfo
      const sysinfo = await client.getSystemInfo(config);
      expect(sysinfo.hostname).toBe('mock-vps');
      expect(sysinfo.osRelease).toBe('Debian GNU/Linux 12');
      expect(sysinfo.cpuUsagePercent).toBe(25.0);

      // Exec command
      const execResult = await client.execCommand(config, 'uname -a');
      expect(execResult.code).toBe(0);
      expect(execResult.stdout).toContain('Executed: uname -a');
      expect(execResult.stdout).toContain('Linux mock-vps');
    });

    it('allows AI Agents to invoke remote tools (remote_list_servers, remote_exec, remote_sysinfo)', async () => {
      const store = RemoteServerStore.getInstance();
      store.upsert({
        id: 'agent-node',
        name: 'Agent Test Node',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        daemonPort: mockPort,
        token: MOCK_TOKEN,
        status: 'online',
      });

      const { remoteListServersTool, remoteExecTool, remoteSysinfoTool } = await import('../src/tools/builtin/remote-tools.js');

      // 1. remote_list_servers
      const listRes = await remoteListServersTool.handler({}, {} as any);
      expect(listRes.content).toContain('Agent Test Node');
      expect(listRes.content).toContain('agent-node');

      // 2. remote_exec
      const execRes = await remoteExecTool.handler({ command: 'docker ps', server: 'agent-node' }, {} as any);
      expect(execRes.isError).toBeFalsy();
      expect(execRes.content).toContain('Executed: docker ps');

      // 3. remote_sysinfo
      const sysinfoRes = await remoteSysinfoTool.handler({ server: 'agent-node' }, {} as any);
      expect(sysinfoRes.isError).toBeFalsy();
      expect(sysinfoRes.content).toContain('实时硬件状态');
      expect(sysinfoRes.content).toContain('mock-vps');

      // 4. remote_upgrade_daemon (error case on invalid SSH credentials handled cleanly)
      const { remoteUpgradeDaemonTool } = await import('../src/tools/builtin/remote-tools.js');
      const upgradeRes = await remoteUpgradeDaemonTool.handler({ server: 'agent-node' }, {} as any);
      expect(upgradeRes.content).toBeDefined();

      // Clean up
      store.remove('agent-node');
    });

    it('persists and retrieves dedicated ops agent (agentId) on RemoteServerConfig', () => {
      const storeFile = tempFile();
      const store = new RemoteServerStore(storeFile);

      const server = store.upsert({
        id: 'gpu-server-1',
        host: '10.0.0.8',
        agentId: 'coder',
      });

      expect(server.agentId).toBe('coder');
      const retrieved = store.get('gpu-server-1');
      expect(retrieved?.agentId).toBe('coder');

      const serverDefault = store.upsert({
        id: 'vps-2',
        host: '10.0.0.9',
      });
      expect(serverDefault.agentId).toBe('ops');
    });
  });
});
