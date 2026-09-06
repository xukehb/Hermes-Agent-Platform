import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createWebApp, getLocalIpAddresses, validateWebServerOptions } from '../src/web/server.js';
import { RemoteClientManager, RemoteServerStore, type RemoteServerConfig } from '../src/remote/index.js';

function tempConfigPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hap-web-test-'));
  return { path: join(dir, 'config.toml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('Headless Web Workbench Server', () => {
  it('detects local IP addresses', () => {
    const ips = getLocalIpAddresses();
    expect(Array.isArray(ips)).toBe(true);
  });

  it('serves snapshot REST endpoint successfully', async () => {
    const config = tempConfigPath();
    try {
      const app = createWebApp({ configPath: config.path });
      const res = await app.request('/api/snapshot');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data?.providers)).toBe(true);
      expect(Array.isArray(body.data?.agents)).toBe(true);
      expect(Array.isArray(body.data?.targets)).toBe(true);
      expect(Array.isArray(body.data?.logs)).toBe(true);
      expect(Array.isArray(body.data?.servers)).toBe(true);
      expect(Array.isArray(body.data?.presets)).toBe(true);
      expect(body.data?.permissions).toEqual(expect.any(Object));
      expect(body.data?.telemetry).toEqual(expect.objectContaining({
        totals: expect.any(Object),
        byServer: expect.any(Array),
        byAgent: expect.any(Array),
      }));
    } finally {
      config.cleanup();
    }
  });

  it('enforces token authentication when auth option is provided', async () => {
    const config = tempConfigPath();
    try {
      const app = createWebApp({ auth: 'secret123', configPath: config.path });

      // 无 token 访问被拒绝
      const unauthRes = await app.request('/api/snapshot');
      expect(unauthRes.status).toBe(401);

      // 带正确 token 访问成功
      const authRes = await app.request('/api/snapshot', {
        headers: {
          Authorization: 'Bearer secret123',
        },
      });
      expect(authRes.status).toBe(200);
    } finally {
      config.cleanup();
    }
  });

  it('protects the workbench HTML and static assets without exposing the token', async () => {
    const config = tempConfigPath();
    try {
      const app = createWebApp({ auth: 'secret123', configPath: config.path });

      const redirect = await app.request('/', { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('/login');
      expect((await app.request('/app.js')).status).toBe(401);
      expect((await app.request('/api/snapshot?token=secret123')).status).toBe(401);

      const login = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'secret123' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie');
      expect(cookie).toContain('HttpOnly');

      const res = await app.request('/', { headers: { Cookie: cookie || '' } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('isWebMode');
      expect(html).not.toContain('secret123');
      expect(html).not.toContain('window.authToken');
    } finally {
      config.cleanup();
    }
  });

  it('requires authentication before allowing a non-loopback bind', () => {
    expect(() => validateWebServerOptions({ bind: '0.0.0.0' })).toThrow(/认证/);
    expect(() => validateWebServerOptions({ bind: '127.0.0.1' })).not.toThrow();
    expect(() => validateWebServerOptions({ bind: '0.0.0.0', auth: 'secret123' })).not.toThrow();
  });

  it('rejects oversized JSON bodies before mutating the configuration', async () => {
    const config = tempConfigPath();
    try {
      const app = createWebApp({ auth: 'secret123', configPath: config.path, maxBodyBytes: 32 });
      const res = await app.request('/api/agents', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret123',
          'Content-Type': 'application/json',
          'Content-Length': '1000',
        },
        body: JSON.stringify({ id: 'too-large', create: true }),
      });
      expect(res.status).toBe(413);
    } finally {
      config.cleanup();
    }
  });

  it('serves static root HTML page', async () => {
    const app = createWebApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('isWebMode');
    expect(html).toContain('upsertAgent: async');
    expect(html).toContain('removeAgent: async');
    expect(html).toContain('listBots: async');
    expect(html).toContain('getTelegramConfig: async');
    expect(html).toContain('getWeChatConfig: async');
  });

  it('creates, updates, and removes agents through the web API', async () => {
    const config = tempConfigPath();
    try {
      const app = createWebApp({ configPath: config.path });

      const createRes = await app.request('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'web-agent',
          create: true,
          displayName: 'Web Agent',
          description: 'Created from the web workbench',
        }),
      });
      expect(createRes.status).toBe(200);
      expect((await createRes.json()).ok).toBe(true);

      const createdSnapshot = await app.request('/api/snapshot');
      const createdBody = await createdSnapshot.json();
      expect(createdBody.data.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'web-agent', name: 'Web Agent' }),
      ]));

      const updateRes = await app.request('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'web-agent',
          displayName: 'Updated Web Agent',
        }),
      });
      expect(updateRes.status).toBe(200);
      expect((await updateRes.json()).ok).toBe(true);

      const deleteRes = await app.request('/api/agents/web-agent', { method: 'DELETE' });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).ok).toBe(true);

      const deletedSnapshot = await app.request('/api/snapshot');
      const deletedBody = await deletedSnapshot.json();
      expect(deletedBody.data.agents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'web-agent' }),
      ]));
    } finally {
      config.cleanup();
    }
  });

  it('exposes server-aware disk and process contracts in the web adapter', async () => {
    const app = createWebApp();
    const html = await (await app.request('/')).text();
    const source = readFileSync(join(process.cwd(), 'src/web/server.ts'), 'utf8');

    expect(source).toContain("c.req.query('server')");
    expect(source).toContain("app.get('/api/processes'");
    expect(source).toContain("app.post('/api/processes/:pid/kill'");
    expect(html).toContain('getServerProcesses: async');
    expect(html).toContain('killServerProcess: async');
    expect(html).toContain("/api/disk/scan?server=");
    expect(html).toContain("JSON.stringify(payload)");
  });

  it('does not silently fall back to local disk data for an unknown remote server', async () => {
    const app = createWebApp();
    const scan = await app.request('/api/disk/scan?server=missing-node');
    expect(scan.status).toBe(404);
    expect((await scan.json()).ok).toBe(false);

    const clean = await app.request('/api/disk/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'missing-node', itemIds: ['remote_tmp'] }),
    });
    expect(clean.status).toBe(404);
    expect((await clean.json()).ok).toBe(false);

    const processes = await app.request('/api/processes');
    expect(processes.status).toBe(400);
  });

  it('treats the host alias as local for remote process controls', async () => {
    const app = createWebApp();

    const list = await app.request('/api/processes?server=host');
    expect(list.status).toBe(400);

    const kill = await app.request('/api/processes/1/kill?server=host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal: 'TERM' }),
    });
    expect(kill.status).toBe(400);
  });

  it('maps remote disk service failures to a bad-gateway response', async () => {
    const app = createWebApp();
    const server: RemoteServerConfig = {
      id: 'node-error',
      name: 'Error node',
      host: '192.0.2.11',
      port: 22,
      username: 'root',
      authType: 'password',
      daemonPort: 9527,
      status: 'online',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const storeGet = vi.spyOn(RemoteServerStore.prototype, 'get').mockImplementation((id) => id === server.id ? server : undefined);
    const client = RemoteClientManager.getInstance() as any;
    const originalScan = client.scanDisk;
    const originalClean = client.cleanDisk;
    client.scanDisk = async () => { throw new Error('remote disk unavailable'); };
    client.cleanDisk = async () => { throw new Error('remote cleanup unavailable'); };

    try {
      const scan = await app.request('/api/disk/scan?server=node-error');
      expect(scan.status).toBe(502);

      const clean = await app.request('/api/disk/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: 'node-error', itemIds: ['remote_tmp'] }),
      });
      expect(clean.status).toBe(502);
    } finally {
      storeGet.mockRestore();
      client.scanDisk = originalScan;
      client.cleanDisk = originalClean;
    }
  });

  it('delegates server-aware disk and process requests to the remote client', async () => {
    const app = createWebApp();
    const server: RemoteServerConfig = {
      id: 'node-test',
      name: 'Test node',
      host: '192.0.2.10',
      port: 22,
      username: 'root',
      authType: 'password',
      daemonPort: 9527,
      status: 'online',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const storeGet = vi.spyOn(RemoteServerStore.prototype, 'get').mockImplementation((id) => id === server.id ? server : undefined);
    const client = RemoteClientManager.getInstance() as any;
    const original = {
      scanDisk: client.scanDisk,
      cleanDisk: client.cleanDisk,
      listProcesses: client.listProcesses,
      killProcess: client.killProcess,
    };
    const calls = { scan: 0, clean: 0, list: 0, kill: 0 };
    client.scanDisk = async (config: RemoteServerConfig) => {
      expect(config).toBe(server);
      calls.scan += 1;
      return { target: server.id, items: [], totalCleanableBytes: 0 };
    };
    client.cleanDisk = async (config: RemoteServerConfig, itemIds: string[]) => {
      expect(config).toBe(server);
      expect(itemIds).toEqual(['remote_tmp']);
      calls.clean += 1;
      return { target: server.id, cleanedBytes: 12, deletedItems: ['remote_tmp'], errors: [] };
    };
    client.listProcesses = async (config: RemoteServerConfig, options?: { limit?: number }) => {
      expect(config).toBe(server);
      expect(options).toEqual({ limit: 25 });
      calls.list += 1;
      return { processes: [{ pid: 321, command: 'node worker.js' }], limit: 25 };
    };
    client.killProcess = async (config: RemoteServerConfig, pid: number, signal: string, expectedStartTime?: string) => {
      expect(config).toBe(server);
      expect(pid).toBe(321);
      expect(signal).toBe('TERM');
      expect(expectedStartTime).toBe('2026-09-05T00:00:00.000Z');
      calls.kill += 1;
      return { pid, signal, killed: true };
    };

    try {
      const scan = await app.request('/api/disk/scan?server=node-test');
      expect(scan.status).toBe(200);
      expect((await scan.json()).data.target).toBe(server.id);

      const clean = await app.request('/api/disk/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: server.id, itemIds: ['remote_tmp'] }),
      });
      expect(clean.status).toBe(200);
      expect((await clean.json()).data.cleanedBytes).toBe(12);

      const list = await app.request('/api/processes?server=node-test&limit=25');
      expect(list.status).toBe(200);
      expect((await list.json()).data.processes[0].pid).toBe(321);

      const kill = await app.request('/api/processes/321/kill?server=node-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal: 'TERM', expectedStartTime: '2026-09-05T00:00:00.000Z' }),
      });
      expect(kill.status).toBe(200);
      expect((await kill.json()).data.killed).toBe(true);
      expect(calls).toEqual({ scan: 1, clean: 1, list: 1, kill: 1 });
    } finally {
      storeGet.mockRestore();
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete client[name];
        else client[name] = value;
      }
    }
  });

  it('preserves zero-valued process limits and PIDs in the web polyfill', async () => {
    const app = createWebApp();
    const html = await (await app.request('/')).text();
    const match = html.match(/<script>\s*(window\.isWebMode = true;[\s\S]*?)\s*<\/script>/);
    expect(match).not.toBeNull();

    const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const context = {
      window: {},
      encodeURIComponent,
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ ok: true, data: { accepted: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      Response,
      JSON,
      String,
      Error,
    };
    const polyfillScript = match?.[1];
    if (polyfillScript === undefined) throw new Error('Web polyfill script was not found');
    vm.runInNewContext(polyfillScript, context);

    await (context.window as any).hap.getServerProcesses('node-test', { limit: 0 });
    await (context.window as any).hap.killServerProcess({ serverId: 'node-test', pid: 0, signal: 'TERM' });

    expect(requests[0]?.url).toBe('/api/processes?server=node-test&limit=0');
    expect(requests[1]?.url).toBe('/api/processes/0/kill?server=node-test');
  });

  it('maps the host alias to local system info in the web polyfill', async () => {
    const app = createWebApp();
    const html = await (await app.request('/')).text();
    const match = html.match(/<script>\s*(window\.isWebMode = true;[\s\S]*?)\s*<\/script>/);
    expect(match).not.toBeNull();

    const requests: string[] = [];
    const context = {
      window: {},
      encodeURIComponent,
      fetch: async (url: string) => {
        requests.push(url);
        return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
      },
      Response,
      JSON,
      String,
      Error,
    };
    const polyfillScript = match?.[1];
    if (polyfillScript === undefined) throw new Error('Web polyfill script was not found');
    vm.runInNewContext(polyfillScript, context);

    await (context.window as any).hap.getServerInfo('host');

    expect(requests).toEqual(['/api/host/sysinfo']);
  });
});
