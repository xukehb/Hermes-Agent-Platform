import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanLocalDisk, cleanLocalDisk, getPathSizeBytes } from '../src/system/disk-cleaner.js';
import { diskCleanupTool } from '../src/tools/builtin/cleanup-tools.js';

describe('Smart Disk Cleaner Engine', () => {
  it('calculates file and directory size accurately', () => {
    const testDir = join(tmpdir(), 'hap_clean_test_' + Date.now());
    mkdirSync(testDir, { recursive: true });
    const f1 = join(testDir, 'sample1.txt');
    const f2 = join(testDir, 'sample2.txt');
    writeFileSync(f1, 'Hello World!'.repeat(100)); // 1200 bytes
    writeFileSync(f2, 'Test Content'.repeat(100)); // 1200 bytes

    const size = getPathSizeBytes(testDir);
    expect(size).toBeGreaterThanOrEqual(2400);

    rmSync(testDir, { recursive: true, force: true });
  });

  it('scans local disk items and returns structured report', async () => {
    const report = await scanLocalDisk();
    expect(report.target).toBe('local');
    expect(report.scannedAt).toBeGreaterThan(0);
    expect(Array.isArray(report.items)).toBe(true);
    expect(typeof report.totalCleanableBytes).toBe('number');
    expect(typeof report.safeCleanableBytes).toBe('number');
    expect(typeof report.healthScore).toBe('number');
    expect(report.healthScore).toBeGreaterThanOrEqual(0);
    expect(typeof report.aiDiagnosis).toBe('string');
    expect(report.aiDiagnosis.length).toBeGreaterThan(5);
  }, 20000);

  it('diskCleanupTool executes dryRun successfully with markdown report', async () => {
    const res = await diskCleanupTool.handler({ dryRun: true }, { agent: { workspace: process.cwd() } } as any);
    expect(res.isError).toBe(false);
    expect(res.content).toContain('本地宿主机');
    expect(res.content).toContain('可释放空间总计');
    expect(res.content).toContain('安全可清');
  });

  it('cleanLocalDisk executes item removal safely', async () => {
    const testDir = join(tmpdir(), 'hap_dummy_cache_' + Date.now());
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'test.log'), 'dummy data');

    const dummyReport = {
      target: 'local',
      totalCleanableBytes: 100,
      safeCleanableBytes: 100,
      reviewCleanableBytes: 0,
      items: [
        {
          id: 'dummy_item',
          category: 'temp_logs' as const,
          name: 'Dummy Temp File',
          path: testDir,
          description: 'Testing cleanup',
          sizeBytes: 100,
          safety: 'safe' as const,
          type: 'dir' as const,
        },
      ],
      healthScore: 95,
      aiDiagnosis: '系统运行良好',
      scannedRoots: [testDir],
      scannedAt: Date.now(),
    };

    const res = await cleanLocalDisk(['dummy_item'], dummyReport);
    expect(res.cleanedBytes).toBeGreaterThanOrEqual(0);
    expect(existsSync(testDir)).toBe(false);
  });
});
