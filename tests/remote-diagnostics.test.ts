import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import {
  parseRemoteProcessOutput,
  parseRemoteDiskOutput,
  REMOTE_CLEANUP_COMMANDS,
} from '../src/remote/diagnostics.js';
import { generateRemoteDaemonScript } from '../src/remote/daemon-script.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('remote diagnostics parsers', () => {
  it('parses ps output with process fields and bounded limit', () => {
    const output = [
      '123 1 root 12.5 3.2 99 node server.js',
      '456 123 app 0.1 0.4 42 /usr/bin/worker --once',
    ].join('\n');
    const result = parseRemoteProcessOutput(output, 1);
    expect(result.processes).toHaveLength(1);
    expect(result.processes[0]).toMatchObject({
      pid: 123, ppid: 1, user: 'root', cpuPercent: 12.5, memPercent: 3.2,
      elapsedSeconds: 99, command: 'node server.js',
    });
    expect(result.limit).toBe(1);
  });

  it('does not mistake a long legacy etimes command for an lstart timestamp', () => {
    const result = parseRemoteProcessOutput('42 1 root 1.5 2.0 10 /usr/bin/long command with spaces here', 10);
    expect(result.processes[0]).toMatchObject({
      pid: 42,
      elapsedSeconds: 10,
      command: '/usr/bin/long command with spaces here',
    });
    expect(result.processes[0]?.startTime).toBeUndefined();
  });

  it('keeps the canonical lstart token stable for process identity checks', () => {
    const line = '42 1 root 1.5 2.0 Wed Sep  2 20:38:53 2026 node worker.js';
    const first = parseRemoteProcessOutput(line).processes[0];
    const second = parseRemoteProcessOutput(line).processes[0];
    expect(first?.startTime).toBe('Wed Sep 2 20:38:53 2026');
    expect(second?.startTime).toBe(first?.startTime);
  });

  it('parses df and du output into byte values', () => {
    const df = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 52428800 52428800 50% /';
    const du = '1048576\t/var/cache\n2048\t/tmp';
    expect(parseRemoteDiskOutput(df, du)).toMatchObject({
      totalBytes: 107374182400, usedBytes: 53687091200, freeBytes: 53687091200,
      usedPercent: 50, entries: [
        { path: '/var/cache', sizeBytes: 1073741824 },
        { path: '/tmp', sizeBytes: 2097152 },
      ],
    });
  });

  it('exposes only static cleanup command mappings', () => {
    expect(REMOTE_CLEANUP_COMMANDS.safe).toContain('rm');
    expect(REMOTE_CLEANUP_COMMANDS.safe).not.toContain('${');
    expect(Object.keys(REMOTE_CLEANUP_COMMANDS)).toEqual(expect.arrayContaining(['safe', 'all']));
  });

  it('keeps remote disk scans alive when one optional directory is unreadable', () => {
    const sourcePath = fileURLToPath(new URL('../src/remote/diagnostics.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toContain('du -sk "$p" 2>/dev/null || true');
  });
});

describe('generated daemon diagnostics contract', () => {
  it('contains authenticated process listing and guarded kill handlers', () => {
    const script = generateRemoteDaemonScript({ port: 9527, token: 'secret' });
    expect(script).toContain("'/api/processes'");
    expect(script).toContain('processes');
    expect(script).toContain("signal !== 'TERM' && signal !== 'KILL'");
    expect(script).toContain('Invalid PID');
    expect(script).toContain('PROTECTED_PIDS');
    expect(script).toContain('Unauthorized');
  });

  it('enforces auth, PID protections, signal validation, and successful TERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-daemon-'));
    const scriptPath = join(dir, 'daemon.mjs');
    const port = 39871 + Math.floor(Math.random() * 500);
    writeFileSync(scriptPath, generateRemoteDaemonScript({ port, token: 'secret' }));
    const child = spawn(process.execPath, [scriptPath]);
    try {
      await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('daemon start timeout')), 3000); child.stdout.on('data', d => { if (String(d).includes('Server running')) { clearTimeout(t); resolve(); } }); child.on('error', reject); });
    const request = (method: string, path: string, body?: unknown, token?: string) => new Promise<{ status: number; data: any }>((resolve, reject) => { const payload = body === undefined ? undefined : JSON.stringify(body); const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(token ? { 'X-HAP-Token': token } : {}) } }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode || 0, data: JSON.parse(text || '{}') })); }); req.on('error', reject); if (payload) req.write(payload); req.end(); });
    expect((await request('GET', '/api/processes')).status).toBe(401);
    expect((await request('GET', '/api/processes?limit=2', undefined, 'secret')).status).toBe(200);
    expect((await request('POST', '/api/processes/nope/kill', { signal: 'TERM' }, 'secret')).status).toBe(400);
    expect((await request('POST', '/api/processes/1/kill', { signal: 'TERM' }, 'secret')).status).toBe(403);
    expect((await request('POST', `/api/processes/${child.pid}/kill`, { signal: 'TERM' }, 'secret')).status).toBe(403);
    expect((await request('POST', '/api/processes/1/kill', { signal: 'BOGUS' }, 'secret')).status).toBe(400);
      expect((await request('POST', '/api/processes/1/kill', { signal: 'TERM', expectedStartTime: 'wrong' }, 'secret')).status).toBe(403);
      const target = spawn('sleep', ['30']);
      const processSnapshot = await request('GET', '/api/processes?limit=500', undefined, 'secret');
      let targetRecord = processSnapshot.data?.data?.processes?.find((item: any) => item.pid === target.pid);
      if (!targetRecord) {
        const pidSnapshot = await request('GET', `/api/processes?pid=${target.pid}`, undefined, 'secret');
        targetRecord = pidSnapshot.data?.data?.processes?.find((item: any) => item.pid === target.pid);
      }
      expect(targetRecord?.startTime).toBeTruthy();
      expect((await request('POST', `/api/processes/${target.pid}/kill`, { signal: 'TERM', expectedStartTime: targetRecord.startTime }, 'secret')).status).toBe(200);
      target.kill('SIGKILL');
      const targetKill = spawn('sleep', ['30']);
      expect((await request('POST', `/api/processes/${targetKill.pid}/kill`, { signal: 'KILL' }, 'secret')).status).toBe(200);
    } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns elapsed seconds and rejects invalid process limits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-daemon-limit-'));
    const scriptPath = join(dir, 'daemon.mjs');
    const port = 40371 + Math.floor(Math.random() * 400);
    writeFileSync(scriptPath, generateRemoteDaemonScript({ port, token: 'secret' }));
    const child = spawn(process.execPath, [scriptPath]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('daemon start timeout')), 3000);
        child.stdout.on('data', (data) => {
          if (String(data).includes('Server running')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
      });

      const request = (path: string) => new Promise<{ status: number; data: any }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: { 'X-HAP-Token': 'secret' },
        }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, data: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end();
      });

      expect((await request('/api/processes?limit=0')).status).toBe(400);
      const response = await request('/api/processes?limit=2');
      expect(response.status).toBe(200);
      const first = response.data?.data?.processes?.[0];
      expect(first?.startTime).toBeTruthy();
      expect(typeof first?.elapsedSeconds).toBe('number');
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to etimes when the remote ps lacks lstart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-daemon-ps-fallback-'));
    const fakePs = join(dir, 'ps');
    writeFileSync(fakePs, `#!/bin/sh
case "$*" in
  *lstart*) exit 1 ;;
  *) printf '4242 1 root 1.0 2.0 123 worker --fallback\\n' ;;
esac
`);
    chmodSync(fakePs, 0o755);
    const scriptPath = join(dir, 'daemon.mjs');
    const port = 40771 + Math.floor(Math.random() * 400);
    writeFileSync(scriptPath, generateRemoteDaemonScript({ port, token: 'secret' }));
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH || ''}` },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('daemon start timeout')), 3000);
        child.stdout.on('data', (data) => {
          if (String(data).includes('Server running')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
      });

      const response = await new Promise<{ status: number; data: any }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/processes?limit=10',
          method: 'GET',
          headers: { 'X-HAP-Token': 'secret' },
        }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, data: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end();
      });

      expect(response.status).toBe(200);
      expect(response.data?.data?.processes).toEqual([
        expect.objectContaining({ pid: 4242, elapsedSeconds: 123, command: 'worker --fallback' }),
      ]);
      expect(response.data?.data?.processes?.[0]?.startTime).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not make the generated daemon credential script world-readable', () => {
    const sourcePath = fileURLToPath(new URL('../src/remote/ssh-installer.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toContain('chmod 700 "$HAP_DIR"');
    expect(source).toContain('chmod 600 "$HAP_DIR/daemon.mjs"');
    expect(source).toContain('chmod 700 /opt/hap-daemon');
    expect(source).toContain('chmod 600 /opt/hap-daemon/daemon.mjs');
  });

  it('returns a validation error instead of hanging on a null kill payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-daemon-null-kill-'));
    const scriptPath = join(dir, 'daemon.mjs');
    const port = 41171 + Math.floor(Math.random() * 300);
    writeFileSync(scriptPath, generateRemoteDaemonScript({ port, token: 'secret' }));
    const child = spawn(process.execPath, [scriptPath]);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('daemon start timeout')), 3000);
        child.stdout.on('data', (data) => {
          if (String(data).includes('Server running')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', reject);
      });

      const response = await new Promise<{ status: number; data: any }>((resolve, reject) => {
        const payload = 'null';
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/processes/1/kill',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-HAP-Token': 'secret',
          },
        }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, data: JSON.parse(text || '{}') }));
        });
        req.setTimeout(1000, () => {
          req.destroy(new Error('request timeout'));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      expect(response.status).toBe(400);
      expect(response.data.error).toMatch(/payload|signal/i);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
