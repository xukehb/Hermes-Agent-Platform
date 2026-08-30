import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebApp, getLocalIpAddresses } from '../src/web/server.js';

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

  it('serves static root HTML page', async () => {
    const app = createWebApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('isWebMode');
  });
});
