import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { AgentOrchestrator } from '../agent/index.js';
import { ConfigResolver, loadConfig, resolveConfigPath } from '../config/index.js';
import { ScheduleStore, SchedulerEngine } from '../scheduler/index.js';
import { MemoryStore } from '../memory/index.js';
import { RemoteServerStore } from '../remote/index.js';
import { getHostSystemInfo, scanLocalDisk, cleanLocalDisk, lookupIpGeo } from '../system/index.js';
import { parseUnifiedDiff } from '../tools/diff-parser.js';
import { execa } from 'execa';

export interface WebServerOptions {
  port?: number;
  bind?: string;
  auth?: string;
  configPath?: string;
  rendererDir?: string;
  log?: (msg: string) => void;
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

export function createWebApp(options: WebServerOptions = {}): Hono {
  const app = new Hono();
  const configPath = options.configPath;
  const authToken = options.auth;
  const rendererDir = options.rendererDir || join(process.cwd(), 'src', 'gui', 'renderer');

  app.use('*', cors());

  // 鉴权中间件
  if (authToken) {
    app.use('/api/*', async (c, next) => {
      const authHeader = c.req.header('Authorization');
      const queryToken = c.req.query('token');
      const token = authHeader?.replace(/^Bearer\s+/i, '') || queryToken;

      if (!token || token !== authToken) {
        return c.json({ ok: false, error: 'Unauthorized: 无效的安全访问凭据' }, 401);
      }
      await next();
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
        },
      });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
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
    const list = RemoteServerStore.getInstance().list();
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

  // 8. 磁盘体检与垃圾清理接口
  app.get('/api/disk/scan', async (c) => {
    try {
      const report = await scanLocalDisk();
      return c.json({ ok: true, data: report });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post('/api/disk/clean', async (c) => {
    try {
      const body = await c.req.json<{ itemIds?: string[] }>();
      const report = await scanLocalDisk();
      const result = await cleanLocalDisk(body.itemIds || ['all'], report);
      return c.json({ ok: true, data: result });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
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
        window.authToken = ${JSON.stringify(authToken || '')};
        const authHeader = window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {};

        window.hap = {
          snapshot: async () => {
            const res = await fetch('/api/snapshot', { headers: authHeader }).then(r => r.json());
            return res.data || {};
          },
          getHostSysInfo: async () => {
            const res = await fetch('/api/host/sysinfo', { headers: authHeader }).then(r => r.json());
            return res.data || {};
          },
          scanDiskCleanable: async (server) => {
            const url = server ? '/api/disk/scan?server=' + encodeURIComponent(server) : '/api/disk/scan';
            const res = await fetch(url, { headers: authHeader }).then(r => r.json());
            return res.data;
          },
          executeDiskCleanup: async (payload) => {
            const res = await fetch('/api/disk/clean', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeader },
              body: JSON.stringify(payload)
            }).then(r => r.json());
            return res.data;
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
  const port = options.port || 3000;
  const bind = options.bind || '0.0.0.0';
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
  for (const ip of ips) {
    log(`   - 局域网访问： http://${ip}:${port}`);
  }
  if (options.auth) {
    log(`   - 安全 Token： ${options.auth}`);
  }
  log('════════════════════════════════════════════════════════════\n');

  return server;
}
