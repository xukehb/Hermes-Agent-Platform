import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execa } from 'execa';
import { formatBytes, getHostSystemInfo } from './host-info.js';

export type CleanSafetyLevel = 'safe' | 'review' | 'dangerous';

export type CleanCategory =
  | 'system_root'
  | 'temp_logs'
  | 'package_cache'
  | 'build_artifact'
  | 'browser_app'
  | 'docker_prune'
  | 'custom';

export interface CleanableItem {
  id: string;
  category: CleanCategory;
  name: string;
  path: string;
  rootPrefix?: string;
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
  scannedRoots: string[];
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

/** 探测本机所有可用盘符或根目录 */
export function getAvailableRootDrives(): string[] {
  if (process.platform !== 'win32') {
    return ['/', '/tmp', '/var/tmp'];
  }
  const drives: string[] = [];
  const letters = ['C', 'D', 'E', 'F', 'G', 'H', 'Z'];
  for (const l of letters) {
    const rootPath = `${l}:\\`;
    try {
      if (existsSync(rootPath)) {
        drives.push(rootPath);
      }
    } catch {}
  }
  return drives.length > 0 ? drives : ['C:\\'];
}

/** 快速采样计算目录或文件大小（限制遍历节点数，毫秒级快速返回） */
export function getPathSizeBytes(targetPath: string, maxEntries = 180): number {
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
        return Math.max(total, 1024 * 1024 * 60);
      }
      return total;
    }
  } catch {}
  return 0;
}

/** 扫描本地磁盘从根目录及各存储分区的可清理垃圾与缓存 */
export async function scanLocalDisk(options: {
  workspace?: string;
  extraProjects?: string[];
  deepScan?: boolean;
} = {}): Promise<DiskScanReport> {
  const items: CleanableItem[] = [];
  const home = homedir();
  const tmp = tmpdir();
  const rootDrives = getAvailableRootDrives();

  // =========================================================================
  // 1. 系统根目录与全局临时缓存 (System & Root Temp Directories)
  // =========================================================================

  // 1.1 探测各驱动盘根目录下的临时文件夹与回收站
  for (const drive of rootDrives) {
    const driveLetter = drive.replace(/\\|\//g, '');

    // 根目录 Temp (如 C:\Temp, D:\Temp)
    const rootTempDir = join(drive, 'Temp');
    if (existsSync(rootTempDir)) {
      const size = getPathSizeBytes(rootTempDir);
      if (size > 1024 * 100) {
        items.push({
          id: `root_temp_${driveLetter.toLowerCase()}`,
          category: 'system_root',
          name: `[${driveLetter}] 根目录临时文件 (${drive}Temp)`,
          path: rootTempDir,
          rootPrefix: drive,
          description: `驱动器 ${drive} 根目录历史遗留的临时生成与解压文件`,
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }

    // Windows 专用系统临时路径 (C:\Windows\Temp)
    if (process.platform === 'win32') {
      const winTemp = join(drive, 'Windows', 'Temp');
      if (existsSync(winTemp)) {
        const size = getPathSizeBytes(winTemp);
        if (size > 1024 * 100) {
          items.push({
            id: `win_temp_${driveLetter.toLowerCase()}`,
            category: 'system_root',
            name: `[${driveLetter}] Windows 系统运行临时缓存 (${winTemp})`,
            path: winTemp,
            rootPrefix: drive,
            description: 'Windows 系统组件与服务运行时生成的无用临时文件',
            sizeBytes: size,
            safety: 'safe',
            type: 'dir',
          });
        }
      }

      // Windows 软件分发与更新下载缓存 (C:\Windows\SoftwareDistribution\Download)
      const winUpdateDownload = join(drive, 'Windows', 'SoftwareDistribution', 'Download');
      if (existsSync(winUpdateDownload)) {
        const size = getPathSizeBytes(winUpdateDownload);
        if (size > 1024 * 1024 * 5) {
          items.push({
            id: `win_update_download_${driveLetter.toLowerCase()}`,
            category: 'system_root',
            name: `[${driveLetter}] Windows 历史更新安装包缓存`,
            path: winUpdateDownload,
            rootPrefix: drive,
            description: 'Windows Update 已安装补丁的历史残留下载包',
            sizeBytes: size,
            safety: 'safe',
            type: 'dir',
          });
        }
      }
    }
  }

  // 1.2 用户级全局临时目录 (%TEMP%, /tmp)
  if (existsSync(tmp)) {
    const size = getPathSizeBytes(tmp);
    if (size > 1024 * 100) {
      items.push({
        id: 'user_temp_dir',
        category: 'system_root',
        name: '用户主环境变量临时目录 (TEMP/TMP)',
        path: tmp,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: '各类应用程序与命令行工具运行过程中的临时中间文件',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 1.3 Windows 崩溃转储 (.dmp) 与 Windows 错误汇报
  if (process.platform === 'win32') {
    const crashDumps = join(home, 'AppData', 'Local', 'CrashDumps');
    if (existsSync(crashDumps)) {
      const size = getPathSizeBytes(crashDumps);
      if (size > 1024 * 50) {
        items.push({
          id: 'win_crash_dumps',
          category: 'temp_logs',
          name: 'Windows 进程历史崩溃转储 (.dmp)',
          path: crashDumps,
          rootPrefix: 'C:\\',
          description: '系统和应用程序历史异常崩溃时产生的内存转储 Dump 文件',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }

    const werReport = join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'WER', 'ReportQueue');
    if (existsSync(werReport)) {
      const size = getPathSizeBytes(werReport);
      if (size > 1024 * 50) {
        items.push({
          id: 'win_wer_queue',
          category: 'temp_logs',
          name: 'Windows 错误报告排队日志 (WER Queue)',
          path: werReport,
          rootPrefix: 'C:\\',
          description: 'Windows 错误报告机制滞留的历史诊断日志与排队项',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }
  }

  // 1.4 HAP 运行与轨迹 Trace 日志
  const hapLogs = join(home, '.hap', 'logs');
  if (existsSync(hapLogs)) {
    const size = getPathSizeBytes(hapLogs);
    if (size > 1024 * 50) {
      items.push({
        id: 'hap_logs',
        category: 'temp_logs',
        name: 'HAP 智能体历史执行轨迹日志 (Trace Logs)',
        path: hapLogs,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'Hermes 智能体历史任务会话记录与多步执行轨迹 JSONL 日志',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // =========================================================================
  // 2. 开发者包管理器与工具链全局缓存 (Package Manager Global Caches)
  // =========================================================================

  // 2.1 Node.js 生态 (npm, pnpm, yarn, bun)
  const npmCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'npm-cache')
    : join(home, '.npm');
  if (existsSync(npmCache)) {
    const size = getPathSizeBytes(npmCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'npm_cache',
        category: 'package_cache',
        name: 'Node.js - npm 全局依赖包缓存',
        path: npmCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'npm install 下载的 tarball 压缩包与模块元数据缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  const pnpmCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'pnpm-cache')
    : join(home, '.cache', 'pnpm');
  if (existsSync(pnpmCache)) {
    const size = getPathSizeBytes(pnpmCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'pnpm_cache',
        category: 'package_cache',
        name: 'Node.js - pnpm 全局包缓存与硬链接元数据',
        path: pnpmCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'pnpm 下载与跨工程共享的硬链接依赖包缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  const yarnCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'Yarn', 'Cache')
    : join(home, '.cache', 'yarn');
  if (existsSync(yarnCache)) {
    const size = getPathSizeBytes(yarnCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'yarn_cache',
        category: 'package_cache',
        name: 'Node.js - Yarn 依赖压缩包缓存',
        path: yarnCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'Yarn v1/v2/v3 下载的历史依赖包 tarball 归档',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 2.2 Python 生态 (pip, uv, conda)
  const pipCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'pip', 'cache')
    : join(home, '.cache', 'pip');
  if (existsSync(pipCache)) {
    const size = getPathSizeBytes(pipCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'pip_cache',
        category: 'package_cache',
        name: 'Python - pip Wheel 安装包缓存',
        path: pipCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'Python pip 下载的 .whl 与 tar.gz 源码依赖包',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  const uvCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'uv', 'cache')
    : join(home, '.cache', 'uv');
  if (existsSync(uvCache)) {
    const size = getPathSizeBytes(uvCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'uv_cache',
        category: 'package_cache',
        name: 'Python - uv 极速包管理器全局缓存',
        path: uvCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'Astral uv 下载并解压的 Python 包元数据与轮子缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 2.3 Rust 生态 (Cargo)
  const cargoCache = join(home, '.cargo', 'registry', 'cache');
  if (existsSync(cargoCache)) {
    const size = getPathSizeBytes(cargoCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'cargo_cache',
        category: 'package_cache',
        name: 'Rust - Cargo Crates.io 离线依赖包缓存',
        path: cargoCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'Rust cargo 下载的 crates.io 离线依赖包归档',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 2.4 Go 生态 (go-build cache)
  const goBuildCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'go-build')
    : join(home, '.cache', 'go-build');
  if (existsSync(goBuildCache)) {
    const size = getPathSizeBytes(goBuildCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'go_build_cache',
        category: 'package_cache',
        name: 'Golang - Go Build 编译构建中间缓存',
        path: goBuildCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'go build / go test 产生的中间编译目标缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 2.5 Java / Gradle / Maven 生态
  const gradleCache = join(home, '.gradle', 'caches');
  if (existsSync(gradleCache)) {
    const size = getPathSizeBytes(gradleCache);
    if (size > 1024 * 1024 * 10) {
      items.push({
        id: 'gradle_cache',
        category: 'package_cache',
        name: 'Java/Android - Gradle 构建与依赖包缓存',
        path: gradleCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'Gradle 下载的 jars/aars 依赖库与构建转换缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // 2.6 .NET / C# (NuGet)
  const nugetHttpCache = process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'NuGet', 'v3-cache')
    : join(home, '.local', 'share', 'NuGet', 'v3-cache');
  if (existsSync(nugetHttpCache)) {
    const size = getPathSizeBytes(nugetHttpCache);
    if (size > 1024 * 1024) {
      items.push({
        id: 'nuget_cache',
        category: 'package_cache',
        name: '.NET/C# - NuGet HTTP 依赖下载缓存',
        path: nugetHttpCache,
        rootPrefix: process.platform === 'win32' ? 'C:\\' : '/',
        description: 'dotnet / nuget 下载的 nupkg 依赖包 HTTP 缓存',
        sizeBytes: size,
        safety: 'safe',
        type: 'dir',
      });
    }
  }

  // =========================================================================
  // 3. 桌面应用、IDE 与浏览器临时缓存 (Browsers & Desktop Apps Caches)
  // =========================================================================

  if (process.platform === 'win32') {
    // 3.1 Google Chrome 缓存
    const chromeCache = join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'Cache_Data');
    if (existsSync(chromeCache)) {
      const size = getPathSizeBytes(chromeCache);
      if (size > 1024 * 1024 * 5) {
        items.push({
          id: 'chrome_cache',
          category: 'browser_app',
          name: 'Google Chrome 网页与媒体缓存',
          path: chromeCache,
          rootPrefix: 'C:\\',
          description: 'Chrome 浏览器日常浏览网页保留的图片与脚本静态缓存',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }

    // 3.2 Microsoft Edge 缓存
    const edgeCache = join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data');
    if (existsSync(edgeCache)) {
      const size = getPathSizeBytes(edgeCache);
      if (size > 1024 * 1024 * 5) {
        items.push({
          id: 'edge_cache',
          category: 'browser_app',
          name: 'Microsoft Edge 浏览器缓存',
          path: edgeCache,
          rootPrefix: 'C:\\',
          description: 'Edge 浏览器下载与网页渲染缓存',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }

    // 3.3 VS Code / Cursor 缓存
    const vscodeCache = join(home, 'AppData', 'Roaming', 'Code', 'CachedData');
    if (existsSync(vscodeCache)) {
      const size = getPathSizeBytes(vscodeCache);
      if (size > 1024 * 1024 * 5) {
        items.push({
          id: 'vscode_cache',
          category: 'browser_app',
          name: 'Visual Studio Code 扩展与编辑器运行缓存',
          path: vscodeCache,
          rootPrefix: 'C:\\',
          description: 'VS Code 插件运行与 V8 脚本字节码缓存',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }

    const cursorCache = join(home, 'AppData', 'Roaming', 'Cursor', 'CachedData');
    if (existsSync(cursorCache)) {
      const size = getPathSizeBytes(cursorCache);
      if (size > 1024 * 1024 * 5) {
        items.push({
          id: 'cursor_cache',
          category: 'browser_app',
          name: 'Cursor AI 编辑器运行缓存',
          path: cursorCache,
          rootPrefix: 'C:\\',
          description: 'Cursor IDE 的历史模型索引与运行时缓存',
          sizeBytes: size,
          safety: 'safe',
          type: 'dir',
        });
      }
    }
  }

  // =========================================================================
  // 4. 工作区与工程深度构建产物扫描 (Deep Project Build Artifacts)
  // =========================================================================

  const candidateDirs = new Set<string>();
  if (options.workspace) candidateDirs.add(resolve(options.workspace));
  if (options.extraProjects) {
    options.extraProjects.forEach(p => candidateDirs.add(resolve(p)));
  }
  candidateDirs.add(process.cwd());

  // 探测用户常见开发目录（如 Documents, Desktop, Projects）
  const commonDevRoots = [
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Projects'),
    join(home, 'workspace'),
    join(home, 'source'),
    join(home, 'dev'),
  ];
  for (const r of commonDevRoots) {
    if (existsSync(r)) {
      try {
        const subDirs = readdirSync(r);
        for (const sub of subDirs.slice(0, 15)) {
          const full = join(r, sub);
          try {
            if (statSync(full).isDirectory()) candidateDirs.add(full);
          } catch {}
        }
      } catch {}
    }
  }

  const artifactNames = [
    { name: 'dist', desc: '前端/TypeScript 编译打包产物' },
    { name: '.next', desc: 'Next.js 框架构建与预渲染缓存' },
    { name: 'build', desc: '工程通用 Build 输出目录' },
    { name: 'target', desc: 'Rust / Maven 编译输出目标' },
    { name: '__pycache__', desc: 'Python .pyc 字节码缓存' },
    { name: '.turbo', desc: 'Turborepo 构建缓存' },
    { name: '.cache', desc: 'Babel / Webpack / Vite 编译中间缓存' },
    { name: '.parcel-cache', desc: 'Parcel 打包器缓存' },
    { name: '.pytest_cache', desc: 'Pytest 测试运行留痕' },
    { name: 'out', desc: 'Next.js 静态导出 / 打包输出目录' },
  ];

  for (const projectDir of candidateDirs) {
    if (!existsSync(projectDir)) continue;
    const projBase = basename(projectDir);
    const drivePrefix = projectDir.slice(0, 3);

    for (const art of artifactNames) {
      const artPath = join(projectDir, art.name);
      if (existsSync(artPath)) {
        const size = getPathSizeBytes(artPath);
        if (size > 1024 * 256) {
          items.push({
            id: `build_${Buffer.from(artPath).toString('base64').slice(0, 10)}`,
            category: 'build_artifact',
            name: `[${projBase}] 构建产物 (${art.name}/)`,
            path: artPath,
            rootPrefix: drivePrefix,
            description: `${art.desc} (${projectDir})`,
            sizeBytes: size,
            safety: 'review',
            type: 'dir',
          });
        }
      }
    }
  }

  // =========================================================================
  // 5. Docker 悬空镜像与构建缓存 (Docker Dangling Images & System Prune)
  // =========================================================================

  try {
    const dockerCheck = await execa('docker', ['system', 'df'], { timeout: 800 }).catch(() => null);
    if (dockerCheck && dockerCheck.stdout) {
      items.push({
        id: 'docker_system_prune',
        category: 'docker_prune',
        name: 'Docker 悬空镜像、无用卷与构建缓存',
        path: 'docker://system',
        rootPrefix: 'Docker Daemon',
        description: '已停止的容器、未标记虚悬镜像 (Dangling) 及 BuildKit 构建缓存',
        sizeBytes: 1024 * 1024 * 180, // 预估基准 180MB+
        safety: 'review',
        type: 'docker',
      });
    }
  } catch {}

  // =========================================================================
  // 6. 聚合统计、AI 智能诊断与健康评分
  // =========================================================================

  let totalSafe = 0;
  let totalReview = 0;
  let totalAll = 0;

  for (const item of items) {
    totalAll += item.sizeBytes;
    if (item.safety === 'safe') totalSafe += item.sizeBytes;
    if (item.safety === 'review') totalReview += item.sizeBytes;
  }

  let healthScore = 96;
  try {
    const host = getHostSystemInfo();
    const mainDisk = host.disk;
    if (mainDisk && mainDisk.totalBytes > 0) {
      const usedPct = mainDisk.usedPercent;
      if (usedPct > 90) healthScore -= 40;
      else if (usedPct > 80) healthScore -= 22;
      else if (usedPct > 70) healthScore -= 12;
    }
  } catch {}

  if (totalAll > 1024 * 1024 * 1024 * 10) healthScore -= 25;
  else if (totalAll > 1024 * 1024 * 1024 * 3) healthScore -= 15;
  else if (totalAll > 1024 * 1024 * 1024 * 1) healthScore -= 8;
  healthScore = Math.max(20, Math.min(100, healthScore));

  const rootsStr = rootDrives.map(d => d.replace(/\\|\//g, '')).join(', ');

  let aiDiagnosis = '';
  if (healthScore >= 90) {
    aiDiagnosis = `✨ 已从全盘根目录 (${rootsStr}) 深度排查共 ${items.length} 个存储区块。宿主系统整体非常健康（评分 ${healthScore} 分），发现 ${formatBytes(totalSafe)} 安全无副作用缓存，可直接一键安全瘦身。`;
  } else if (healthScore >= 70) {
    aiDiagnosis = `⚡ 全盘根目录体检完成（发现 ${formatBytes(totalAll)} 冗余）。建议优先清理 ${formatBytes(totalSafe)} 依赖包缓存 (npm/pip/cargo) 与系统临时日志，释放驱动盘空间。`;
  } else {
    aiDiagnosis = `🚨 警告：系统驱动盘空间偏紧（评分 ${healthScore} 分）！全盘共扫描出 ${formatBytes(totalAll)} 缓存与构建垃圾。AI 诊断强烈建议立即清理 ${formatBytes(totalSafe)} 安全项，并审视工程构建产物 (dist/target) 与 Docker 镜像，避免磁盘耗尽阻碍开发构建。`;
  }

  return {
    target: 'local',
    totalCleanableBytes: totalAll,
    safeCleanableBytes: totalSafe,
    reviewCleanableBytes: totalReview,
    healthScore,
    aiDiagnosis,
    scannedRoots: rootDrives,
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

