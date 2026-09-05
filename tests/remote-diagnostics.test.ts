import { describe, expect, it } from 'vitest';
import {
  parseRemoteProcessOutput,
  parseRemoteDiskOutput,
  REMOTE_CLEANUP_COMMANDS,
} from '../src/remote/diagnostics.js';
import { generateRemoteDaemonScript } from '../src/remote/daemon-script.js';

describe('remote diagnostics parsers', () => {
  it('parses ps output with process fields and bounded limit', () => {
    const output = [
      'PID PPID USER %CPU %MEM START ELAPSED COMMAND',
      '123 1 root 12.5 3.2 2026-09-05T01:02:03Z 99 node server.js',
      '456 123 app 0.1 0.4 2026-09-05T01:03:00Z 42 /usr/bin/worker --once',
    ].join('\n');
    const result = parseRemoteProcessOutput(output, 1);
    expect(result.processes).toHaveLength(1);
    expect(result.processes[0]).toMatchObject({
      pid: 123, ppid: 1, user: 'root', cpuPercent: 12.5, memPercent: 3.2,
      startTime: '2026-09-05T01:02:03Z', elapsedSeconds: 99, command: 'node server.js',
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
});
