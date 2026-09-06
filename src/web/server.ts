import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { AgentOrchestrator } from '../agent/index.js';
import { BUILTIN_PROVIDERS, ConfigResolver, loadConfig, resolveConfigPath } from '../config/index.js';
import { removeAgent, upsertAgent, type GuiAgentInput } from '../gui/agent-operations.js';
import { ScheduleStore, SchedulerEngine } from '../scheduler/index.js';
import { MemoryStore } from '../memory/index.js';
import { RemoteClientManager, RemoteServerStore, type RemoteServerConfig } from '../remote/index.js';
import { getHostSystemInfo, scanLocalDisk, cleanLocalDisk, lookupIpGeo } from '../system/index.js';
import { parseUnifiedDiff } from '../tools/diff-parser.js';
import { execa } from 'execa';

export interface WebServerOptions {
  port?: number;
  bind?: string;
  auth?: string;
  corsOrigins?: string[];
  maxBodyBytes?: number;
  configPath?: string;
  rendererDir?: string;
  log?: (msg: string) => void;
}

const DEFAULT_WEB_BIND = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const SESSION_COOKIE = 'hap_web_session';

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === 'ip6-localhost') return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith('127.');
  if (family === 6) return normalized === '::1' || normalized.startsWith('::ffff:127.');
  return false;
}

function sessionToken(authToken: string): string {
  return createHmac('sha256', authToken).update('hap-web-session-v1').digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie');
  if (raw === null) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function authorized(request: Request, authToken: string): boolean {
  const bearer = bearerToken(request);
  if (bearer !== undefined && safeEqual(bearer, authToken)) return true;
  const session = cookieValue(request, SESSION_COOKIE);
  return session !== undefined && safeEqual(session, sessionToken(authToken));
}

function requestContentLength(request: Request): number | undefined {
  const value = request.headers.get('content-length');
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function exceedsBodyLimit(request: Request, limit: number): Promise<boolean> {
  const declared = requestContentLength(request);
  if (declared !== undefined && declared > limit) return true;
  if (request.body === null) return false;

  const reader = request.clone().body?.getReader();
  if (reader === undefined) return false;
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function validateWebServerOptions(options: WebServerOptions = {}): void {
  const bind = options.bind?.trim() || DEFAULT_WEB_BIND;
  if (!isLoopbackHost(bind) && !options.auth?.trim()) {
    throw new Error('非回环 Web 监听必须配置 auth 认证 Token');
  }
  if (options.maxBodyBytes !== undefined && (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)) {
    throw new Error('maxBodyBytes 必须是正整数');
  }
}

interface RemoteDiagnosticsClient {
  getSystemInfo(config: RemoteServerConfig): Promise<unknown>;
  scanDisk(config: RemoteServerConfig): Promise<unknown>;
  cleanDisk(config: RemoteServerConfig, itemIds: string[]): Promise<unknown>;
  listProcesses(config: RemoteServerConfig, options?: { limit?: number }): Promise<unknown>;
  killProcess(config: RemoteServerConfig, pid: number, signal: 'TERM' | 'KILL', expectedStartTime?: string): Promise<unknown>;
}

export function getLocalIpAddresses(): string[] {
  const nets = networkInterfaces();
  const results: string[] = [];

  for (const name of Object.keys(nets)) {
    const netList = nets[name];
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }

  return results;
}

function resolveRemoteServer(serverId: string | undefined): RemoteServerConfig | undefined {
  if (!serverId || serverId === 'local') return undefined;
  const store = RemoteServerStore.getInstance();
  return store.get(serverId) || store.list().find((server) => server.name === serverId || server.host === serverId);
}

function publicRemoteServer(server: RemoteServerConfig): Record<string, unknown> {
  const { password: _password, privateKey: _privateKey, passphrase: _passphrase, token: _token, botConfig, ...safe } = server;
  return {
    ...safe,
    ...(botConfig === undefined ? {} : {
      botConfig: {
        ...botConfig,
        secret: undefined,
        webhookUrl: undefined,
      },
    }),
    credentialsConfigured: Boolean(server.password || server.privateKey || server.passphrase || server.token),
  };
}

function remoteDiagnosticsClient(): RemoteDiagnosticsClient {
  return RemoteClientManager.getInstance() as unknown as RemoteDiagnosticsClient;
}

export function createWebApp(options: WebServerOptions = {}): Hono {
  const app = new Hono();
  const configPath = options.configPath;
  const authToken = options.auth;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rendererDir = options.rendererDir || join(process.cwd(), 'src', 'gui', 'renderer');

  if (options.corsOrigins !== undefined && options.corsOrigins.length > 0) {
    app.use('*', cors({
      origin: options.corsOrigins,
      allowHeaders: ['Authorization', 'Content-Type'],
      credentials: true,
    }));
  }

  // 认证和请求体上限必须覆盖 API、HTML 和静态资源。
  if (authToken) {
    app.use('*', async (c, next) => {
      if (c.req.path === '/login' || c.req.path === '/auth/login') {
        await next();
        return;
      }
      if (c.req.method === 'OPTIONS') {
        await next();
        return;
      }
      if (authorized(c.req.raw, authToken)) {
        await next();
        return;
      }
      if (c.req.path === '/' && c.req.method === 'GET') {
        return c.redirect('/login', 302);
      }
      return c.json({ ok: false, error: 'Unauthorized: 无效的安全访问凭据' }, 401);
    });
  }

  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
      if (await exceedsBodyLimit(c.req.raw, maxBodyBytes)) {
        return c.json({ ok: false, error: '请求体过大' }, 413);
      }
    }
    await next();
  });

  if (authToken) {
    app.get('/login', (c) => c.html(`<!doctype html>
      <html lang="zh-CN"><head><meta charset="utf-8"><title>HAP 登录</title></head>
      <body><main><h1>HAP Web 工作台</h1>
      <form id="login"><label>访问 Token <input name="token" type="password" autocomplete="current-password" required></label>
      <button type="submit">登录</button><p id="error" role="alert"></p></form>
      <script>
        document.getElementById('login').addEventListener('submit', async (event) => {
          event.preventDefault();
          const token = new FormData(event.currentTarget).get('token');
          const response = await fetch('/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ token }) });
          if (response.ok) { window.location.href = '/'; return; }
          document.getElementById('error').textContent = '登录失败';
        });
      </script></main></body></html>`));

    app.post('/auth/login', async (c) => {
      let body: { token?: unknown };
      try {
        body = await c.req.json<{ token?: unknown }>();
      } catch {
        return c.json({ ok: false, error: '请求体必须是 JSON' }, 400);
      }
      if (typeof body.token !== 'string' || !safeEqual(body.token, authToken)) {
        return c.json({ ok: false, error: 'Unauthorized: 无效的安全访问凭据' }, 401);
      }
      c.header('Set-Cookie', `${SESSION_COOKIE}=${sessionToken(authToken)}; Path=/; HttpOnly; SameSite=Strict`);
      return c.json({ ok: true });
    });
  }

  // 1. 系统快照接口
  app.get('/api/snapshot', (c) => {
    try {
      const cfg = loadConfig(configPath ? { path: configPath } : {});
      const resolver = new ConfigResolver(cfg, {}, process.env);
      const providers = [...resolver.resolveProviders().values()].map(p => ({
        id: p.id,
        name: p.name,
        protocol: p.defaultProtocol,
        wire: p.wireApi,
        baseUrl: p.baseUrl,
      }));

      const models = [...resolver.resolveModels().values()].map(m => ({
        id: m.alias,
        fullName: m.fullName,
        alias: m.alias,
        providerId: m.providerId,
        contextWindow: m.contextWindow,
      }));

      const agents = resolver.listAgentIds().map(id => {
        const a = resolver.resolveAgent(id);
        return {
          id: a.id,
          name: a.identity?.displayName || a.name || a.id,
          description: a.description,
          model: a.model.primary,
        };
      });

      const targets = ['codex', 'claude', 'gemini', 'grok', 'openclaw'].map((target) => ({
        target,
        path: '',
        exists: false,
        configuredModel: undefined,
      }));
      const telemetry = {
        status: 'ok',
        totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
        byServer: [],
        byAgent: [],
      };

      return c.json({
        ok: true,
        data: {
          configPath: cfg.path,
          providers,
          models,
          agents,
          projects: [],
          skills: [],
          plugins: [],
          permissions: {
            mode: 'full-access',
            allowShell: true,
            allowFsWrite: true,
            allowNetwork: true,
            allowSpawnSubagent: true,
            autoApproveTools: ['*'],
          },
          targets,
          logs: [],
          servers: RemoteServerStore.getInstance().list().map(publicRemoteServer),
          telemetry,
          presets: Object.keys(BUILTIN_PROVIDERS),
        },
      });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // 1.1 智能体配置接口（与 Electron GUI 共用配置写入逻辑）
  app.post('/api/agents', async (c) => {
    try {
      const body = await c.req.json<GuiAgentInput>();
      const data = upsertAgent(resolveConfigPath(configPath, process.env), body);
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/api/agents/:id', (c) => {
    try {
      const data = removeAgent(resolveConfigPath(configPath, process.env), c.req.param('id'));
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // 2. 聊天与任务下发接口
  app.post('/api/chat', async (c) => {
    try {
      const body = await c.req.json<{ input: string; agent?: string; model?: string; projectPath?: string }>();
      if (!body.input || !body.input.trim()) {
        return c.json({ ok: false, error: '输入指令不能为空' }, 400);
      }

      const orchestrator = new AgentOrchestrator(configPath ? { configPath } : {});
      await orchestrator.loadMcpTools();

      const res = await orchestrator.runTask({
        input: body.input.trim(),
        agentId: body.agent,
        model: body.model,
        workspace: body.projectPath,
      });

      return c.json({
        ok: true,
        data: {
          taskId: res.taskId,
          status: res.status,
          text: res.text,
          reasoning: res.reasoning,
          usage: res.usage,
        },
      });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // 3. Git 操作接口
  app.get('/api/git/diff', async (c) => {
    const projectPath = c.req.query('projectPath');
    const file = c.req.query('file');
    if (!projectPath) return c.json({ ok: false, error: '缺少 projectPath' }, 400);

    try {
      const args = ['diff'];
      if (file) args.push('HEAD', '--', file);
      else args.push('HEAD');

      const res = await execa('git', args, { cwd: projectPath }).catch(() => execa('git', ['diff'], { cwd: projectPath }));
      const rawDiff = res.stdout || '';
      const files = parseUnifiedDiff(rawDiff);
      return c.json({ ok: true, data: { files, rawDiff } });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // 4. 定时任务接口
  app.get('/api/schedules', (c) => {
    const list = ScheduleStore.getInstance().listJobs();
    const history = ScheduleStore.getInstance().getHistory();
    return c.json({ ok: true, data: { jobs: list, history } });
  });

  app.post('/api/schedules', async (c) => {
    const body = await c.req.json();
    const job = ScheduleStore.getInstance().upsertJob(body);
    return c.json({ ok: true, data: job });
  });

  app.post('/api/schedules/:id/run', async (c) => {
    const id = c.req.param('id');
    const engine = SchedulerEngine.getInstance({ configPath });
    const record = await engine.runJobNow(id);
    return c.json({ ok: true, data: record });
  });

  // 5. 记忆库接口
  app.get('/api/memories', (c) => {
    const category = c.req.query('category');
    const list = MemoryStore.getInstance().listMemories(category);
    return c.json({ ok: true, data: list });
  });

  app.post('/api/memories', async (c) => {
    const body = await c.req.json();
    const card = await MemoryStore.getInstance().addMemory(body);
    return c.json({ ok: true, data: card });
  });

  // 6. 远程服务器接口
  app.get('/api/servers', (c) => {
    const list = RemoteServerStore.getInstance().list().map(publicRemoteServer);
    return c.json({ ok: true, data: list });
  });

  // 7. 宿主主机实时系统状态接口
  app.get('/api/host/sysinfo', (c) => {
    try {
      const info = getHostSystemInfo();
      return c.json({ ok: true, data: info });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // 7.1 远程节点实时系统状态接口
  app.get('/api/servers/:id/sysinfo', async (c) => {
    const serverId = c.req.param('id');
    if (serverId === 'local' || serverId === 'host') {
      try {
        return c.json({ ok: true, data: getHostSystemInfo() });
      } catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    const server = resolveRemoteServer(serverId);
    if (!server) return c.json({ ok: false, error: `未找到远程服务器：${serverId}` }, 404);
    try {
      const info = await remoteDiagnosticsClient().getSystemInfo(server);
      return c.json({ ok: true, data: info });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // 8. 磁盘体检与垃圾清理接口
  app.get('/api/disk/scan', async (c) => {
    const serverId = c.req.query('server');
    const remoteRequest = Boolean(serverId && serverId !== 'local' && serverId !== 'host');
    try {
      if (remoteRequest) {
        const server = resolveRemoteServer(serverId);
        if (!server) return c.json({ ok: false, error: `未找到远程服务器：${serverId}` }, 404);
        const report = await remoteDiagnosticsClient().scanDisk(server);
        return c.json({ ok: true, data: report });
      }
      const report = await scanLocalDisk();
      return c.json({ ok: true, data: report });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, remoteRequest ? 502 : 500);
    }
  });

  app.post('/api/disk/clean', async (c) => {
    let remoteRequest = false;
    try {
      const body = await c.req.json<{ server?: string; itemIds?: string[] }>();
      remoteRequest = Boolean(body.server && body.server !== 'local' && body.server !== 'host');
      if (remoteRequest) {
        const server = resolveRemoteServer(body.server);
        if (!server) return c.json({ ok: false, error: `未找到远程服务器：${body.server}` }, 404);
        const itemIds = Array.isArray(body.itemIds) ? body.itemIds : ['all'];
        const result = await remoteDiagnosticsClient().cleanDisk(server, itemIds);
        return c.json({ ok: true, data: result });
      }
      const report = await scanLocalDisk();
      const result = await cleanLocalDisk(body.itemIds || ['all'], report);
      return c.json({ ok: true, data: result });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, remoteRequest ? 502 : 500);
    }
  });

  // 8.1 远程节点详细进程与安全信号接口
  app.get('/api/processes', async (c) => {
    const serverId = c.req.query('server');
    if (!serverId || serverId === 'local' || serverId === 'host') {
      return c.json({ ok: false, error: '远程进程接口需要提供 server 参数' }, 400);
    }
    const server = resolveRemoteServer(serverId);
    if (!server) return c.json({ ok: false, error: `未找到远程服务器：${serverId}` }, 404);

    const rawLimit = c.req.query('limit');
    const parsedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500)) {
      return c.json({ ok: false, error: 'limit 必须是 1-500 的整数' }, 400);
    }

    try {
      const processes = await remoteDiagnosticsClient().listProcesses(server, parsedLimit === undefined ? undefined : { limit: parsedLimit });
      return c.json({ ok: true, data: processes });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.post('/api/processes/:pid/kill', async (c) => {
    let body: { server?: string; serverId?: string; signal?: string; expectedStartTime?: string } = {};
    try {
      body = await c.req.json<typeof body>();
    } catch {
      // The validation below returns a useful 400 response for an empty body.
    }
    const serverId = c.req.query('server') || body.serverId || body.server;
    if (!serverId || serverId === 'local' || serverId === 'host') {
      return c.json({ ok: false, error: '远程进程接口需要提供 server 参数' }, 400);
    }
    const server = resolveRemoteServer(serverId);
    if (!server) return c.json({ ok: false, error: `未找到远程服务器：${serverId}` }, 404);

    const rawPid = c.req.param('pid');
    if (!/^\d+$/.test(rawPid)) return c.json({ ok: false, error: 'PID 必须是正整数' }, 400);
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid < 1) return c.json({ ok: false, error: 'PID 必须是正整数' }, 400);

    try {
      if (body.signal !== 'TERM' && body.signal !== 'KILL') {
        return c.json({ ok: false, error: 'signal 只能是 TERM 或 KILL' }, 400);
      }
      const result = await remoteDiagnosticsClient().killProcess(server, pid, body.signal, body.expectedStartTime);
      return c.json({ ok: true, data: result });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // 9. IP 归属地与网络定位接口
  app.get('/api/ip/lookup', async (c) => {
    try {
      const ip = c.req.query('ip');
      const geo = await lookupIpGeo(ip);
      return c.json({ ok: true, data: geo });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // 静态页面服务与 Web 适配层
  app.get('/', (c) => {
    const htmlPath = join(rendererDir, 'index.html');
    if (!existsSync(htmlPath)) {
      return c.html(`<h1>CodexConnect Web 工作台已启动</h1><p>API 运行正常 (Port: ${options.port || 3000})</p>`);
    }

    let html = readFileSync(htmlPath, 'utf8');

    // 注入 Web Polyfill，使得 app.js 无缝通过 REST 调取数据
    const webPolyfillScript = `
      <script>
        window.isWebMode = true;
        // Authenticated browser requests use the HttpOnly session cookie set by
        // /auth/login.  Never serialize the access token into page source.
        const authHeader = {};
        const readApi = async (response) => {
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error(body.error || ('请求失败 (' + response.status + ')'));
          return body.data;
        };

        window.hap = {
          snapshot: async () => {
            const res = await fetch('/api/snapshot', { headers: authHeader }).then(r => r.json());
            return res.data || {};
          },
          getHostSysInfo: async () => {
            return readApi(await fetch('/api/host/sysinfo', { headers: authHeader }));
          },
          getServerInfo: async (server) => {
            if (!server || server === 'local' || server === 'host') return readApi(await fetch('/api/host/sysinfo', { headers: authHeader }));
            return readApi(await fetch('/api/servers/' + encodeURIComponent(server) + '/sysinfo', { headers: authHeader }));
          },
          scanDiskCleanable: async (server) => {
            const url = server ? '/api/disk/scan?server=' + encodeURIComponent(server) : '/api/disk/scan';
            return readApi(await fetch(url, { headers: authHeader }));
          },
          executeDiskCleanup: async (payload) => {
            return readApi(await fetch('/api/disk/clean', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify(payload)
            }));
          },
          getServerProcesses: async (server, options) => {
            if (!server || server === 'local' || server === 'host') throw new Error('远程进程接口需要提供 server 参数');
            const query = '?server=' + encodeURIComponent(server) + (options?.limit !== undefined ? '&limit=' + encodeURIComponent(options.limit) : '');
            return readApi(await fetch('/api/processes' + query, { headers: authHeader }));
          },
          killServerProcess: async (payload) => {
            const server = payload?.serverId || payload?.id || payload?.server;
            if (!server || server === 'local' || server === 'host') throw new Error('远程进程接口需要提供 server 参数');
            const pid = encodeURIComponent(String(payload?.pid ?? ''));
            return readApi(await fetch('/api/processes/' + pid + '/kill?server=' + encodeURIComponent(server), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify({ signal: payload?.signal, expectedStartTime: payload?.expectedStartTime })
            }));
          },
          getIpGeoInfo: async (ip) => {
            const url = ip ? '/api/ip/lookup?ip=' + encodeURIComponent(ip) : '/api/ip/lookup';
            const res = await fetch(url, { headers: authHeader }).then(r => r.json());
            return res.data || {};
          },
          chat: async (input) => {
            const res = await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify(input)
            }).then(r => r.json());
            if (!res.ok) throw new Error(res.error || '请求失败');
            return res.data;
          },
          upsertAgent: async (input) => {
            const res = await fetch('/api/agents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify(input)
            }).then(r => r.json());
            if (!res.ok) throw new Error(res.error || '智能体保存失败');
            return res.data;
          },
          removeAgent: async (id) => {
            const res = await fetch('/api/agents/' + encodeURIComponent(id), {
              method: 'DELETE',
              headers: authHeader
            }).then(r => r.json());
            if (!res.ok) throw new Error(res.error || '智能体删除失败');
            return res.data;
          },
          listSchedules: async () => {
            const res = await fetch('/api/schedules', { headers: authHeader }).then(r => r.json());
            return res.data?.jobs || [];
          },
          getScheduleHistory: async () => {
            const res = await fetch('/api/schedules', { headers: authHeader }).then(r => r.json());
            return res.data?.history || [];
          },
          upsertSchedule: async (input) => {
            const res = await fetch('/api/schedules', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify(input)
            }).then(r => r.json());
            return res.data;
          },
          runScheduleNow: async (id) => {
            const res = await fetch('/api/schedules/' + id + '/run', {
              method: 'POST',
              headers: authHeader
            }).then(r => r.json());
            return res.data;
          },
          listServers: async () => {
            const res = await fetch('/api/servers', { headers: authHeader }).then(r => r.json());
            return res.data || [];
          },
          listBots: async () => [],
          listMemories: async (category) => {
            const query = category ? '?category=' + encodeURIComponent(category) : '';
            return readApi(await fetch('/api/memories' + query, { headers: authHeader }));
          },
          addMemory: async (input) => {
            return readApi(await fetch('/api/memories', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify(input)
            }));
          },
          getTelegramConfig: async () => ({ enabled: false, mode: 'polling', defaultAgent: 'ops', running: false }),
          getWeChatConfig: async () => ({ enabled: false, mode: 'ilink_bot', defaultAgent: 'ops', running: false, status: 'idle' }),
          gitDiff: async (projectPath, file) => {
            const res = await fetch('/api/git/diff?projectPath=' + encodeURIComponent(projectPath) + (file ? '&file=' + encodeURIComponent(file) : ''), { headers: authHeader }).then(r => r.json());
            return res.data || { diff: '' };
          }
        };
      </script>
    `;

    html = html.replace('</head>', `${webPolyfillScript}</head>`);
    return c.html(html);
  });

  app.get('/styles.css', (c) => {
    const p = join(rendererDir, 'styles.css');
    if (existsSync(p)) {
      c.header('Content-Type', 'text/css');
      return c.body(readFileSync(p, 'utf8'));
    }
    return c.text('', 404);
  });

  app.get('/app.js', (c) => {
    const p = join(rendererDir, 'app.js');
    if (existsSync(p)) {
      c.header('Content-Type', 'application/javascript');
      return c.body(readFileSync(p, 'utf8'));
    }
    return c.text('', 404);
  });

  app.get('/qrcode.js', (c) => {
    const p = join(rendererDir, 'qrcode.js');
    if (existsSync(p)) {
      c.header('Content-Type', 'application/javascript');
      return c.body(readFileSync(p, 'utf8'));
    }
    return c.text('', 404);
  });

  return app;
}

export function startWebServer(options: WebServerOptions = {}) {
  validateWebServerOptions(options);
  const port = options.port || 3000;
  const bind = options.bind || DEFAULT_WEB_BIND;
  const app = createWebApp(options);

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: bind,
  });

  const ips = getLocalIpAddresses();
  const log = options.log || console.log;

  log('\n🌐 ════════════════════════════════════════════════════════════');
  log(`   CodexConnect 局域网 Web 工作台已就绪！`);
  log(`   - 本地访问： http://localhost:${port}`);
  if (!isLoopbackHost(bind)) {
    for (const ip of ips) {
      log(`   - 局域网访问： http://${ip}:${port}`);
    }
  }
  log('════════════════════════════════════════════════════════════\n');

  return server;
}
