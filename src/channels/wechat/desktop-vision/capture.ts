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
  sourceType: 'electron_capturer' | 'screencapture' | 'system_capture' | 'none';
  error?: string | undefined;
}

/** 检测微信客户端是否正在运行 (macOS & Windows) */
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
      const { stdout } = await runCmd('tasklist', ['/FI', 'IMAGENAME eq WeChat.exe']);
      return stdout.includes('WeChat.exe');
    } catch {
      return false;
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await runCmd('pgrep', ['-f', '微信|WeChat']);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  return false;
}

/** 尝试使用 Electron 的 desktopCapturer 抓取微信窗口 */
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

    const wechatSource = sources.find((s) => {
      const name = (s.name || '').toLowerCase();
      const isDevTools = name.includes('devtools') || name.includes('开发') || name.includes('tool');
      return !isDevTools && (name.includes('wechat') || name.includes('微信'));
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

import { ensureMacOcrBinary } from './ocr-parser.js';

/** 获取 macOS 上微信窗口的 Window ID */
export async function getMacWeChatWindowId(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const binPath = ensureMacOcrBinary();
  if (binPath && existsSync(binPath)) {
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
    // 优先通过 CoreGraphics 锁定的 WeChat 窗口 ID 精准截取，避免背景干扰与压缩失真
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

/** 使用 Windows/Linux 系统工具截取当前桌面，保证非 Electron 环境也能识屏。 */
async function captureViaSystemScreen(): Promise<CapturedWindow> {
  if (process.platform === 'darwin') return captureViaMacScreencapture();
  const tempPath = join(tmpdir(), `hap_wechat_cap_${Date.now()}_${randomUUID().slice(0, 6)}.png`);
  try {
    if (process.platform === 'win32') {
      const escaped = tempPath.replace(/'/g, "''");
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s=[Windows.Forms.Screen]::PrimaryScreen.Bounds; $b=New-Object Drawing.Bitmap $s.Width,$s.Height; $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Location,[Drawing.Point]::Empty,$s.Size); $b.Save('${escaped}',[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`;
      await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    } else {
      try { await runCmd('scrot', [tempPath]); } catch { await runCmd('import', ['-window', 'root', tempPath]); }
    }
    if (!existsSync(tempPath)) throw new Error('截图文件未生成');
    const buffer = readFileSync(tempPath);
    try { unlinkSync(tempPath); } catch {}
    const base64 = buffer.toString('base64');
    return { ok: true, buffer, base64, dataUrl: `data:image/png;base64,${base64}`, windowName: 'WeChat Desktop Screen', sourceType: 'system_capture' };
  } catch (err) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    return { ok: false, sourceType: 'system_capture', error: `系统截屏失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 抓取微信客户端窗口（macOS 优先系统级原生高精度截屏，其他平台/降级使用 Electron desktopCapturer） */
export async function captureWeChatWindow(): Promise<CapturedWindow> {
  if (process.platform === 'darwin') {
    const macRes = await captureViaMacScreencapture();
    if (macRes && macRes.ok) {
      return macRes;
    }
  }

  const electronRes = await captureViaElectron();
  if (electronRes && electronRes.ok) {
    return electronRes;
  }

  return await captureViaSystemScreen();
}
