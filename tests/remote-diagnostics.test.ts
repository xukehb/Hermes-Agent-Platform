import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
  });
});
