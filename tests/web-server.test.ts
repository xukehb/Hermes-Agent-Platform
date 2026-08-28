import { describe, it, expect } from 'vitest';
import { createWebApp, getLocalIpAddresses } from '../src/web/server.js';

describe('Headless Web Workbench Server', () => {
  it('detects local IP addresses', () => {
    const ips = getLocalIpAddresses();
    expect(Array.isArray(ips)).toBe(true);
  });

  it('serves snapshot REST endpoint successfully', async () => {
    const app = createWebApp();
    const res = await app.request('/api/snapshot');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data?.providers)).toBe(true);
    expect(Array.isArray(body.data?.agents)).toBe(true);
  });

  it('enforces token authentication when auth option is provided', async () => {
    const app = createWebApp({ auth: 'secret123' });

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
  });

  it('serves static root HTML page', async () => {
    const app = createWebApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('isWebMode');
  });
});
