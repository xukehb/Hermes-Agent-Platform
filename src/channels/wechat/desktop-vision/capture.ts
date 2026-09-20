import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function runCmd(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export interface CapturedWindow {
  ok: boolean;
  buffer?: Buffer | undefined;
  base64?: string | undefined;
  dataUrl?: string | undefined;
  windowName?: string | undefined;
  sourceType: 'electron_capturer' | 'screencapture' | 'none';
  error?: string | undefined;
}

/** 检测微信客户端是否正在运行 (macOS & Windows & Ubuntu/Linux) */
export async function isWeChatRunning(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await runCmd('osascript', ['-e', 'application "WeChat" is running']);
      return stdout.trim() === 'true';
    } catch {
      try {
        const { stdout } = await runCmd('pgrep', ['-x', 'WeChat']);
        return stdout.trim().length > 0;
      } catch {
        return false;
      }
    }
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await runCmd('tasklist', ['/FO', 'CSV', '/NH']);
      const lower = stdout.toLowerCase();
      return lower.includes('wechat.exe') || lower.includes('weixin.exe') || lower.includes('wechatappex.exe');
    } catch {
      return false;
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await runCmd('pgrep', ['-i', 'wechat|weixin']);
      if (stdout.trim().length > 0) return true;
    } catch {
      // 降级使用 ps 输出匹配
    }
    try {
      const { stdout } = await runCmd('ps', ['-A', '-o', 'comm=']);
      const lower = stdout.toLowerCase();
      return /wechat|weixin|com\.tencent\.wechat/.test(lower);
    } catch {
      return false;
    }
  }

  return false;
}

/** 尝试使用 Electron 的 desktopCapturer 抓取微信窗口 (全平台通用) */
async function captureViaElectron(): Promise<CapturedWindow | undefined> {
  try {
    // 动态判断是否在 Electron 主进程运行
    if (!process.versions?.electron) return undefined;
    const electron = await import('electron');
    const desktopCapturer = electron.desktopCapturer;
    if (!desktopCapturer) return undefined;

    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1440, height: 900 },
      fetchWindowIcons: false,
    });

    const isWeChatTitle = (name: string) => {
      const lower = name.toLowerCase();
      if (!lower.includes('wechat') && !lower.includes('微信') && !lower.includes('weixin')) return false;
      if (/chrome|firefox|edge|safari|brave|visual studio|code|pycharm|idea|terminal/i.test(lower)) return false;
      return true;
    };

    const wechatSource = sources.find((s) => isWeChatTitle(s.name || '')) ||
      sources.find((s) => {
        const name = (s.name || '').toLowerCase();
        return name.includes('wechat') || name.includes('微信') || name.includes('weixin');
      });

    if (wechatSource && wechatSource.thumbnail && !wechatSource.thumbnail.isEmpty()) {
      const buffer = wechatSource.thumbnail.toJPEG(85);
      const base64 = buffer.toString('base64');
      return {
        ok: true,
        buffer,
        base64,
        dataUrl: `data:image/jpeg;base64,${base64}`,
        windowName: wechatSource.name,
        sourceType: 'electron_capturer',
      };
    }
  } catch {
    // Electron desktopCapturer 失败或不在主进程时降级
  }
  return undefined;
}

/** 获取 macOS 上微信窗口的 Window ID */
export async function getMacWeChatWindowId(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const binPath = join(process.cwd(), 'bin', 'macos_ocr');
  if (existsSync(binPath)) {
    try {
      const { stdout } = await runCmd(binPath, ['--wechat-wid']);
      const wid = parseInt(stdout.trim(), 10);
      if (Number.isFinite(wid) && wid > 0) {
        return wid;
      }
    } catch {
      // 忽略检测失败
    }
  }
  return undefined;
}

/** 尝试使用 macOS screencapture 命令抓取微信窗口 */
async function captureViaMacScreencapture(): Promise<CapturedWindow> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      sourceType: 'none',
      error: 'screencapture 仅在 macOS 系统可用',
    };
  }

  const tempPath = join(tmpdir(), `hap_wechat_cap_${Date.now()}_${randomUUID().slice(0, 6)}.png`);

  try {
    // 优先通过 CoreGraphics 锁定的 WeChat 窗口 ID 精准截取，避免背景干扰
    const wid = await getMacWeChatWindowId();
    if (wid) {
      await runCmd('/usr/sbin/screencapture', ['-l', String(wid), '-x', tempPath]);
    } else {
      // 静默截取当前屏幕，快速获得整个工作桌面
      await runCmd('/usr/sbin/screencapture', ['-x', '-C', tempPath]);
    }

    if (!existsSync(tempPath)) {
      return { ok: false, sourceType: 'none', error: '截图生成失败，文件未找到' };
    }

    const buffer = readFileSync(tempPath);
    try { unlinkSync(tempPath); } catch {}
    const base64 = buffer.toString('base64');

    return {
      ok: true,
      buffer,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      windowName: wid ? 'WeChat Desktop Window' : 'WeChat Desktop Screen',
      sourceType: 'screencapture',
    };
  } catch (err) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      sourceType: 'screencapture',
      error: `macOS 截屏失败: ${msg}（请检查系统设置 -> 隐私与安全性 -> 屏幕录制权限）`,
    };
  }
}

/** 尝试在 Windows 系统通过 PowerShell 脚本捕获主屏幕/微信视窗 (支持多显示器虚拟桌面) */
async function captureViaWindows(): Promise<CapturedWindow> {
  if (process.platform !== 'win32') {
    return { ok: false, sourceType: 'none', error: '仅在 Windows 系统可用' };
  }

  const tempPath = join(tmpdir(), `hap_wechat_cap_${Date.now()}_${randomUUID().slice(0, 6)}.png`);

  try {
    const escapedPath = tempPath.replace(/\\/g, '\\\\');
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms,System.Drawing
      $vScreen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      if ($vScreen.Width -gt 0 -and $vScreen.Height -gt 0) {
        $bounds = $vScreen
      } else {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      }
      $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bmp)
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose()
      $bmp.Dispose()
    `.trim();

    await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);

    if (!existsSync(tempPath)) {
      return { ok: false, sourceType: 'none', error: 'Windows 截图生成失败，文件未找到' };
    }

    const buffer = readFileSync(tempPath);
    try { unlinkSync(tempPath); } catch {}
    const base64 = buffer.toString('base64');

    return {
      ok: true,
      buffer,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      windowName: 'Windows WeChat Screen',
      sourceType: 'screencapture',
    };
  } catch (err) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      sourceType: 'screencapture',
      error: `Windows 截屏失败: ${msg}`,
    };
  }
}

/** 尝试在 Ubuntu / Linux 系统通过 Python PIL 或 CLI 截屏工具捕获画面 */
async function captureViaLinux(): Promise<CapturedWindow> {
  if (process.platform !== 'linux') {
    return { ok: false, sourceType: 'none', error: '仅在 Linux 系统可用' };
  }

  const tempPath = join(tmpdir(), `hap_wechat_cap_${Date.now()}_${randomUUID().slice(0, 6)}.png`);

  try {
    // 优先采用 Python3 PIL.ImageGrab（Ubuntu 常见标配，零额外环境依赖）
    const pyScript = `
from PIL import ImageGrab
import sys
try:
    img = ImageGrab.grab()
    img.save('${tempPath}')
except Exception as e:
    sys.exit(1)
`.trim();

    let captured = false;
    try {
      await runCmd('python3', ['-c', pyScript]);
      if (existsSync(tempPath)) captured = true;
    } catch {
      // 忽略
    }

    if (!captured) {
      // 依次降级尝试 grim (Wayland)、import (ImageMagick X11)、scrot、gnome-screenshot
      const tryTools = [
        ['grim', [tempPath]],
        ['import', ['-window', 'root', tempPath]],
        ['scrot', [tempPath]],
        ['gnome-screenshot', ['-f', tempPath]],
      ] as const;

      for (const [cmd, args] of tryTools) {
        try {
          await runCmd(cmd, [...args]);
          if (existsSync(tempPath)) {
            captured = true;
            break;
          }
        } catch {
          // 继续尝试下一个
        }
      }
    }

    if (!captured || !existsSync(tempPath)) {
      return { ok: false, sourceType: 'none', error: 'Linux 截屏失败：未找到可用的截图工具 (Python PIL / grim / import / scrot)' };
    }

    const buffer = readFileSync(tempPath);
    try { unlinkSync(tempPath); } catch {}
    const base64 = buffer.toString('base64');

    return {
      ok: true,
      buffer,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      windowName: 'Linux WeChat Screen',
      sourceType: 'screencapture',
    };
  } catch (err) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      sourceType: 'screencapture',
      error: `Linux 截屏失败: ${msg}`,
    };
  }
}

/** 抓取微信客户端窗口（优先 Electron desktopCapturer，降级 macOS screencapture / Windows PowerShell / Linux PIL） */
export async function captureWeChatWindow(): Promise<CapturedWindow> {
  const electronRes = await captureViaElectron();
  if (electronRes && electronRes.ok) {
    return electronRes;
  }

  if (process.platform === 'darwin') {
    return await captureViaMacScreencapture();
  }
  if (process.platform === 'win32') {
    return await captureViaWindows();
  }
  if (process.platform === 'linux') {
    return await captureViaLinux();
  }

  return {
    ok: false,
    sourceType: 'none',
    error: `当前操作系统 (${process.platform}) 暂不支持屏幕截图`,
  };
}
