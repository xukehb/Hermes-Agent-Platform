import { describe, expect, it } from 'vitest';
import {
  evaluateModelForHardware,
  getHardwareRecommendationProfile,
} from '../src/system/model-recommender.js';
import { OPEN_SOURCE_MODEL_CATALOG } from '../src/system/model-catalog.js';
import type { HostSystemInfo } from '../src/system/host-info.js';

const GB = 1024 * 1024 * 1024;

function createMockHostSystemInfo(overrides: Partial<HostSystemInfo> = {}): HostSystemInfo {
  return {
    os: {
      platform: 'linux',
      type: 'Linux',
      release: '6.8.0',
      arch: 'x86_64',
      endianness: 'LE',
      uptimeSeconds: 3600,
      processUptimeSeconds: 120,
      nodeVersion: 'v22.0.0',
      pid: 1000,
      ppid: 1,
      user: 'tester',
      homedir: '/home/tester',
      tmpdir: '/tmp',
      execPath: '/usr/bin/node',
      cwd: '/workspace',
      versions: { node: '22', v8: '12', uv: '1', zlib: '1', openssl: '3' },
    },
    cpu: {
      model: 'Intel Core i5-13500',
      cores: 14,
      speedMHz: 2500,
      usagePercent: 15,
      loadAvg: [0.5, 0.4, 0.3],
      perCore: [],
    },
    memory: {
      totalBytes: 16 * GB,
      freeBytes: 10 * GB,
      usedBytes: 6 * GB,
      usedPercent: 37,
      processRssBytes: 100 * 1024 * 1024,
      processHeapTotalBytes: 50 * 1024 * 1024,
      processHeapUsedBytes: 30 * 1024 * 1024,
      processExternalBytes: 0,
      processArrayBuffersBytes: 0,
    },
    disk: {
      totalBytes: 500 * GB,
      freeBytes: 200 * GB,
      usedBytes: 300 * GB,
      usedPercent: 60,
      mount: '/',
      partitions: [],
    },
    network: {
      hostname: 'test-node',
      ips: [],
    },
    topProcesses: [],
    loadAvg: [0.5, 0.4, 0.3],
    timestamp: Date.now(),
    gpus: [],
    ...overrides,
  };
}

describe('Model Recommender & Hardware Profiler', () => {
  it('1. 低配纯 CPU 电脑 (8GB 内存，无独显)：优先推荐 1.5B/3B 极速模型，70B 标记为硬件不足', () => {
    const lowSpecSys = createMockHostSystemInfo({
      memory: {
        totalBytes: 8 * GB,
        freeBytes: 4 * GB,
        usedBytes: 4 * GB,
        usedPercent: 50,
        processRssBytes: 100 * 1024 * 1024,
        processHeapTotalBytes: 50 * 1024 * 1024,
        processHeapUsedBytes: 30 * 1024 * 1024,
        processExternalBytes: 0,
        processArrayBuffersBytes: 0,
      },
      gpus: [],
    });

    const profile = getHardwareRecommendationProfile(lowSpecSys);
    expect(profile.machineType).toBe('cpu-only');

    const qwen15b = profile.evaluations.find((e) => e.model.id === 'qwen2.5-coder:1.5b');
    expect(qwen15b).toBeDefined();
    expect(qwen15b?.tier).toBe('best'); // 纯 CPU 下 1.5B 是最佳极速适配

    const deepseek70b = profile.evaluations.find((e) => e.model.id === 'deepseek-r1:70b');
    expect(deepseek70b).toBeDefined();
    expect(deepseek70b?.tier).toBe('insufficient'); // 70B 在 8G 机器上硬件不足
    expect(deepseek70b?.warning).toContain('不建议在此设备上运行');
  });

  it('2. 中配独显电脑 (16GB 内存 + 6GB NVIDIA 显存)：7B/8B 获得最佳匹配 (显存全载)', () => {
    const midSpecSys = createMockHostSystemInfo({
      memory: {
        totalBytes: 16 * GB,
        freeBytes: 8 * GB,
        usedBytes: 8 * GB,
        usedPercent: 50,
        processRssBytes: 100 * 1024 * 1024,
        processHeapTotalBytes: 50 * 1024 * 1024,
        processHeapUsedBytes: 30 * 1024 * 1024,
        processExternalBytes: 0,
        processArrayBuffersBytes: 0,
      },
      gpus: [
        {
          index: 0,
          name: 'NVIDIA GeForce RTX 3050',
          vendor: 'nvidia',
          memoryTotalBytes: 6 * GB,
          memoryFreeBytes: 5 * GB,
        },
      ],
    });

    const profile = getHardwareRecommendationProfile(midSpecSys);
    expect(profile.machineType).toBe('nvidia-gpu');
    expect(profile.vramTotalGb).toBe(6);

    const qwen7b = profile.evaluations.find((e) => e.model.id === 'qwen2.5-coder:7b');
    expect(qwen7b?.tier).toBe('best'); // 6GB 显存可完全装下 7B
    expect(qwen7b?.canFitVram).toBe(true);

    const qwen14b = profile.evaluations.find((e) => e.model.id === 'qwen2.5-coder:14b');
    expect(qwen14b?.tier).toBe('compatible'); // 14B 可混合卸载运行
    expect(qwen14b?.canFitVram).toBe(false);
  });

  it('3. 高配 Apple Silicon Mac (64GB 统一内存)：14B 与 32B 获得最佳匹配', () => {
    const macSys = createMockHostSystemInfo({
      os: {
        platform: 'darwin',
        type: 'Darwin',
        release: '23.0.0',
        arch: 'arm64',
        endianness: 'LE',
        uptimeSeconds: 7200,
        processUptimeSeconds: 500,
        nodeVersion: 'v22.0.0',
        pid: 2000,
        ppid: 1,
        user: 'macuser',
        homedir: '/Users/macuser',
        tmpdir: '/tmp',
        execPath: '/usr/local/bin/node',
        cwd: '/Users/macuser/proj',
        versions: { node: '22', v8: '12', uv: '1', zlib: '1', openssl: '3' },
      },
      cpu: {
        model: 'Apple M3 Max',
        cores: 16,
        speedMHz: 3500,
        usagePercent: 10,
        loadAvg: [0.2, 0.2, 0.1],
        perCore: [],
      },
      memory: {
        totalBytes: 64 * GB,
        freeBytes: 45 * GB,
        usedBytes: 19 * GB,
        usedPercent: 30,
        processRssBytes: 120 * 1024 * 1024,
        processHeapTotalBytes: 60 * 1024 * 1024,
        processHeapUsedBytes: 40 * 1024 * 1024,
        processExternalBytes: 0,
        processArrayBuffersBytes: 0,
      },
      gpus: [
        {
          index: 0,
          name: 'Apple M3 Max (Apple Unified Memory)',
          vendor: 'apple',
          memoryTotalBytes: 64 * GB,
          memoryFreeBytes: 45 * GB,
        },
      ],
    });

    const profile = getHardwareRecommendationProfile(macSys);
    expect(profile.machineType).toBe('apple-silicon');

    const deepseek32b = profile.evaluations.find((e) => e.model.id === 'deepseek-r1:32b');
    expect(deepseek32b?.tier).toBe('best'); // 64GB 统一内存足以全装载 32B (约22GB显存)
    expect(deepseek32b?.canFitVram).toBe(true);

    const llama70b = profile.evaluations.find((e) => e.model.id === 'llama3.3:70b');
    expect(llama70b?.tier).toBe('best'); // 64G * 0.75 = 48G VRAM，刚好装载 70B (推荐48G)
  });

  it('4. 磁盘空间严重不足时，应发出警告并扣减评分', () => {
    const lowDiskSys = createMockHostSystemInfo({
      disk: {
        totalBytes: 500 * GB,
        freeBytes: 3 * GB, // 仅剩 3GB 磁盘，连 7B 权重 (4.7GB) 都装不下
        usedBytes: 497 * GB,
        usedPercent: 99,
        mount: '/',
        partitions: [],
      },
    });

    const model7b = OPEN_SOURCE_MODEL_CATALOG.find((m) => m.id === 'qwen2.5-coder:7b')!;
    const evalResult = evaluateModelForHardware(model7b, lowDiskSys);
    expect(evalResult.diskSufficient).toBe(false);
    expect(evalResult.warning).toContain('磁盘剩余空间不足');
  });

  it('5. 排序规则：最佳推荐 (best) 必须排在 (compatible / slow / insufficient) 前面', () => {
    const sys = createMockHostSystemInfo({
      memory: {
        totalBytes: 16 * GB,
        freeBytes: 10 * GB,
        usedBytes: 6 * GB,
        usedPercent: 37,
        processRssBytes: 100 * 1024 * 1024,
        processHeapTotalBytes: 50 * 1024 * 1024,
        processHeapUsedBytes: 30 * 1024 * 1024,
        processExternalBytes: 0,
        processArrayBuffersBytes: 0,
      },
      gpus: [
        {
          index: 0,
          name: 'NVIDIA RTX 3050',
          vendor: 'nvidia',
          memoryTotalBytes: 6 * GB,
          memoryFreeBytes: 4 * GB,
        },
      ],
    });

    const profile = getHardwareRecommendationProfile(sys);
    const tiers = profile.evaluations.map((e) => e.tier);
    const firstNonBestIndex = tiers.findIndex((t) => t !== 'best');
    const lastBestIndex = tiers.lastIndexOf('best');
    if (firstNonBestIndex !== -1 && lastBestIndex !== -1) {
      expect(lastBestIndex).toBeLessThan(firstNonBestIndex);
    }
  });
});
