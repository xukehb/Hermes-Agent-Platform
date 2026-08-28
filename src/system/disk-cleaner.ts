import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { formatBytes, getHostSystemInfo } from './host-info.js';

export type CleanSafetyLevel = 'safe' | 'review' | 'dangerous';

export interface CleanableItem {
  id: string;
  category: 'package_cache' | 'build_artifact' | 'temp_logs' | 'docker_prune' | 'ide_cache' | 'custom';
  name: string;
  path: string;
  description: string;
  sizeBytes: number;
  safety: CleanSafetyLevel;
  type: 'dir' | 'file' | 'docker';
}

export interface DiskScanReport {
  target: 'local' | string;
  totalCleanableBytes: number;
  safeCleanableBytes: number;
  reviewCleanableBytes: number;
  healthScore: number;
  aiDiagnosis: string;
  items: CleanableItem[];
  scannedAt: number;
}

export interface DiskCleanResult {
  target: 'local' | string;
  cleanedBytes: number;
  deletedItems: string[];
  errors: Array<{ id: string; error: string }>;
  cleanedAt: number;
}

/** 快速采样计算目录或文件大小（限制遍历节点数，毫秒级返回） */
export function getPathSizeBytes(targetPath: string, maxEntries = 120): number {
  if (!existsSync(targetPath)) return 0;
  try {
    const stats = statSync(targetPath);
    if (stats.isFile()) return stats.size;
    if (stats.isDirectory()) {
      let total = 0;
      let count = 0;
      const stack = [targetPath];
      while (stack.length > 0 && count < maxEntries) {
        const current = stack.pop()!;
        try {
          const files = readdirSync(current);
          for (const file of files) {
            count++;
            if (count >= maxEntries) break;
            const full = join(current, file);
            try {
              const s = statSync(full);
              if (s.isFile()) {
                total += s.size;
              } else if (s.isDirectory()) {
                stack.push(full);
              }
            } catch {}
          }
        } catch {}
      }
      if (count >= maxEntries) {
        return Math.max(total, 1024 * 1024 * 50);
      }
      return total;
    }
  } catch {}
  return 0;
}

/** 扫描本地磁盘中的可清理垃圾与缓存 */
export async function scanLocalDisk(options: { workspace?: string; extraProjects?: string[] } = {}): Promise<DiskScanReport> {
  const items: CleanableItem[] = [];
  const home = homedir();
  const tmp = tmpdir();

  // 1. 包管理器缓存 (Safe)
  // npm
  const npmCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'npm-cache')
    : join(home, '.npm');
  if (existsSync(npmCache)) {
    const size = getPathSizeBytes(npmCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'npm_cache',
        category: 'package_cache',
        name: 'npm 依赖包缓存',
        path: npmCache,
        description: 'npm install 下载的 tarball 与全局元数据缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // pnpm
  const pnpmCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'pnpm-cache')
    : join(home, '.cache', 'pnpm');
  if (existsSync(pnpmCache)) {
    const size = getPathSizeBytes(pnpmCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'pnpm_cache',
        category: 'package_cache',
        name: 'pnpm 全局包缓存',
        path: pnpmCache,
        description: 'pnpm 下载与硬链接缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // yarn
  const yarnCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'Yarn', 'Cache')
    : join(home, '.cache', 'yarn');
  if (existsSync(yarnCache)) {
    const size = getPathSizeBytes(yarnCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'yarn_cache',
        category: 'package_cache',
        name: 'Yarn 依赖缓存',
        path: yarnCache,
        description: 'Yarn v1/v2 下载的依赖包压缩包',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // pip
  const pipCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'pip', 'cache')
    : join(home, '.cache', 'pip');
  if (existsSync(pipCache)) {
    const size = getPathSizeBytes(pipCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'pip_cache',
        category: 'package_cache',
        name: 'pip Python 依赖缓存',
        path: pipCache,
        description: 'Python wheel 与源码包下载缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // Rust Cargo cache
  const cargoCache = join(home, '.cargo', 'registry', 'cache');
  if (existsSync(cargoCache)) {
    const size = getPathSizeBytes(cargoCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'cargo_cache',
        category: 'package_cache',
        name: 'Cargo Rust Crates 依赖包缓存',
        path: cargoCache,
        description: 'Rust cargo 下载的 crates.io 离线压缩包',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 2. 系统与 HAP 临时运行日志 (Safe)
  const hapLogs = join(home, '.hap', 'logs');
  if (existsSync(hapLogs)) {
    const size = getPathSizeBytes(hapLogs);
    if (size > 1024 * 100) {
      items.push({
        id: 'hap_logs',
        category: 'temp_logs',
        name: 'HAP 历史任务 Trace 运行留痕',
        path: hapLogs,
        description: '智能体历史任务执行轨迹与留痕 JSONL 日志',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // Windows CrashDumps
  if (process.platform === 'win32') {
    const crashDumps = join(home, 'AppData', 'Local', 'CrashDumps');
    if (existsSync(crashDumps)) {
      const size = getPathSizeBytes(crashDumps);
      if (size > 1024 * 1024) {
        items.push({
          id: 'win_crash_dumps',
          category: 'temp_logs',
          name: 'Windows 进程崩溃转储 (.dmp)',
          path: crashDumps,
          description: '系统和应用程序历史崩溃内存转储文件',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }
  }

  // 3. 项目构建产物与开发临时目录 (Review)
  const candidateDirs = new Set<string>();
  if (options.workspace) candidateDirs.add(resolve(options.workspace));
  if (options.extraProjects) {
    options.extraProjects.forEach(p => candidateDirs.add(resolve(p)));
  }
  candidateDirs.add(process.cwd());

  const artifactNames = ['dist', '.next', 'build', 'target', '__pycache__', '.turbo', '.cache'];

  for (const projectDir of candidateDirs) {
    if (!existsSync(projectDir)) continue;
    for (const name of artifactNames) {
      const artPath = join(projectDir, name);
      if (existsSync(artPath)) {
        const size = getPathSizeBytes(artPath);
        if (size > 1024 * 512) {
          items.push({
            id: `build_${Buffer.from(artPath).toString('base64').slice(0, 8)}`,
            category: 'build_artifact',
            name: `构建产物 (${name}/)`,
            path: artPath,
            description: `工程目录 [${projectDir}] 的编译缓存与构建输出`,
            sizeBytes: size,
            safety: 'review',
            type: 'dir',
          });
        }
      }
    }
  }

  // 4. Docker 悬空镜像与构建缓存 (Review)
  try {
    const dockerCheck = await execa('docker', ['system', 'df'], { timeout: 600 }).catch(() => null);
    if (dockerCheck && dockerCheck.stdout) {
      items.push({
        id: 'docker_system_prune',
        category: 'docker_prune',
        name: 'Docker 冗余镜像与构建缓存',
        path: 'docker://system',
        description: '已停止的容器、悬空虚悬镜像 (Dangling) 及 BuildKit 构建缓存',
        sizeBytes: 1024 * 1024 * 150, // 估算 150MB+
        safety: 'review',
        type: 'docker',
      });
    }
  } catch {}

  let totalSafe = 0;
  let totalReview = 0;
  let totalAll = 0;

  for (const item of items) {
    totalAll += item.sizeBytes;
    if (item.safety === 'safe') totalSafe += item.sizeBytes;
    if (item.safety === 'review') totalReview += item.sizeBytes;
  }

  // 计算健康评分与 AI 智能诊断
  let healthScore = 95;
  try {
    const host = getHostSystemInfo();
    const mainDisk = host.disk;
    if (mainDisk && mainDisk.totalBytes > 0) {
      const usedPct = mainDisk.usedPercent;
      if (usedPct > 90) healthScore -= 35;
      else if (usedPct > 80) healthScore -= 20;
      else if (usedPct > 70) healthScore -= 10;
    }
  } catch {}

  if (totalAll > 1024 * 1024 * 1024 * 5) healthScore -= 20;
  else if (totalAll > 1024 * 1024 * 1024 * 1) healthScore -= 10;
  healthScore = Math.max(20, Math.min(100, healthScore));

  let aiDiagnosis = '';
  if (healthScore >= 90) {
    aiDiagnosis = `✨ 宿主系统磁盘整体状态非常健康（评分 ${healthScore} 分），仅发现 ${formatBytes(totalAll)} 冗余包缓存与临时日志，可随时执行一键安全瘦身。`;
  } else if (healthScore >= 70) {
    aiDiagnosis = `⚡ 系统磁盘状态良好（评分 ${healthScore} 分）。建议清理 ${formatBytes(totalSafe)} 安全依赖包缓存及历史编译产物，释放宝贵可用空间。`;
  } else {
    aiDiagnosis = `🚨 警告：系统驱动盘空间偏紧（评分 ${healthScore} 分）！AI 诊断建议优先清理 ${formatBytes(totalSafe)} 包管理器与临时缓存，并回收工程构建产物 (dist/target)，预防磁盘写满引发构建失败。`;
  }

  return {
    target: 'local',
    totalCleanableBytes: totalAll,
    safeCleanableBytes: totalSafe,
    reviewCleanableBytes: totalReview,
    healthScore,
    aiDiagnosis,
    items,
    scannedAt: Date.now(),
  };
}

/** 执行本地磁盘清理 */
export async function cleanLocalDisk(itemIds: string[], scanReport: DiskScanReport): Promise<DiskCleanResult> {
  let cleanedBytes = 0;
  const deletedItems: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  const targetItems = scanReport.items.filter(item => itemIds.includes(item.id) || itemIds.includes('all'));

  for (const item of targetItems) {
    try {
      if (item.type === 'docker') {
        await execa('docker', ['system', 'prune', '-f']);
        cleanedBytes += item.sizeBytes;
        deletedItems.push(`${item.name} (${formatBytes(item.sizeBytes)})`);
      } else if (existsSync(item.path)) {
        const size = getPathSizeBytes(item.path);
        rmSync(item.path, { recursive: true, force: true });
        cleanedBytes += size;
        deletedItems.push(`${item.name} (${formatBytes(size)})`);
      }
    } catch (err: any) {
      errors.push({ id: item.id, error: err.message || String(err) });
    }
  }

  return {
    target: 'local',
    cleanedBytes,
    deletedItems,
    errors,
    cleanedAt: Date.now(),
  };
}
