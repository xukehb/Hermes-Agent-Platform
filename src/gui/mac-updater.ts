import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export interface MacUpdateOptions {
  zipPath?: string;
  targetAppPath?: string;
  appExit?: () => void;
}

/**
 * 查找本地缓存的已下载更新 ZIP 包
 */
export function findDownloadedMacZip(customCacheDir?: string): string | null {
  const cacheBase =
    customCacheDir ||
    path.join(
      os.homedir(),
      'Library',
      'Caches',
      'hermes-agent-platform-updater'
    );

  const searchLocations = [
    path.join(cacheBase, 'pending'),
    cacheBase,
  ];

  for (const dir of searchLocations) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      // 优先匹配版本号命名的 zip，如 Hermes-Agent-Platform-0.1.16-macOS-arm64.zip
      const versionedZip = files.find(
        (f) => f.startsWith('Hermes-Agent-Platform-') && f.endsWith('.zip')
      );
      if (versionedZip) return path.join(dir, versionedZip);

      // 其次匹配通用 update.zip
      const generalZip = files.find((f) => f === 'update.zip');
      if (generalZip) return path.join(dir, generalZip);
    } catch (_e) {
      // 忽略读取权限异常
    }
  }

  return null;
}

/**
 * 检查目标 .app 应用目录及其父目录是否对当前用户可写
 */
export function isMacAppWritable(appPath: string): boolean {
  try {
    const parentDir = path.dirname(appPath);
    fs.accessSync(parentDir, fs.constants.W_OK);
    if (fs.existsSync(appPath)) {
      fs.accessSync(appPath, fs.constants.W_OK);
    }
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 获取当前运行中的主应用 .app 目录路径
 */
export function getRunningMacAppPath(): string | null {
  const execPath = process.execPath;
  const match = execPath.match(/^(.+\.app)/);
  return match && match[1] ? match[1] : null;
}

/**
 * 执行 macOS 本地平滑更新替换：
 * 解压更新 zip、执行合规 ad-hoc 签名与清理隔离、派生后台替换脚本、安全重启新版
 */
export async function installMacUpdateInPlace(
  options: MacUpdateOptions = {}
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  const targetApp = options.targetAppPath || getRunningMacAppPath();
  if (!targetApp || !fs.existsSync(targetApp)) {
    return false;
  }

  const zipPath = options.zipPath || findDownloadedMacZip();
  if (!zipPath || !fs.existsSync(zipPath)) {
    return false;
  }

  if (!isMacAppWritable(targetApp)) {
    return false;
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hermes-mac-update-')
  );

  try {
    // 1. 解压更新包至临时目录
    execSync(`unzip -q -o "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });

    // 2. 定位解压出的 .app 目录
    const entries = fs.readdirSync(tempDir);
    const extractedApp = entries.find((e) => e.endsWith('.app'));
    if (!extractedApp) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return false;
    }

    const sourceAppPath = path.join(tempDir, extractedApp);

    // 3. 重新对提取的 app 执行合规深度签名并清除 quarantine 标志
    try {
      execSync(`codesign --force --deep -s - "${sourceAppPath}"`, {
        stdio: 'pipe',
      });
      execSync(`xattr -cr "${sourceAppPath}"`, { stdio: 'pipe' });
    } catch (_e) {
      // 签名失败时不阻断更新，继续尝试替换
    }

    // 4. 生成平滑替换并拉起的独立的 bash 脚本
    const currentPid = process.pid;
    const scriptContent = `#!/bin/bash
CURRENT_PID=${currentPid}
TARGET_APP="${targetApp}"
SOURCE_APP="${sourceAppPath}"
TEMP_DIR="${tempDir}"

# 等待宿主主进程正常退出（最多等待 15 秒）
COUNT=0
while kill -0 $CURRENT_PID 2>/dev/null; do
  sleep 0.2
  COUNT=$((COUNT + 1))
  if [ $COUNT -gt 75 ]; then
    kill -9 $CURRENT_PID 2>/dev/null
    break
  fi
done

# 替换旧版应用
rm -rf "$TARGET_APP"
cp -R "$SOURCE_APP" "$TARGET_APP"

# 清除隔离属性并赋予权限
xattr -cr "$TARGET_APP" 2>/dev/null
chmod -R 755 "$TARGET_APP" 2>/dev/null

# 拉起新版应用
open "$TARGET_APP"

# 清理临时文件
rm -rf "$TEMP_DIR"
`;

    const scriptPath = path.join(tempDir, 'install-update.sh');
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    // 5. 脱离当前进程派生执行脚本
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // 6. 退出当前旧版本应用
    if (options.appExit) {
      options.appExit();
    } else if (typeof app !== 'undefined' && app.exit) {
      app.exit(0);
    }

    return true;
  } catch (error) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {
      // 忽略清理异常
    }
    throw error;
  }
}
