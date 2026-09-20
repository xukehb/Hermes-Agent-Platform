import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function runCmd(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export interface ActionDriverResult {
  ok: boolean;
  error?: string | undefined;
}

export interface WeChatWindowBounds {
  wid: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SendReplyOptions {
  targetName?: string | undefined;
  targetCoords?: [number, number] | undefined;
  switchToTarget?: boolean | undefined;
  text: string;
  delayMs?: number | undefined;
  restoreFocus?: boolean | undefined;
}

/** 获取微信主窗口屏幕边界坐标 (支持 macOS / Windows / Ubuntu Linux) */
export async function getWeChatWindowBounds(): Promise<WeChatWindowBounds | undefined> {
  // 1. macOS 实现
  if (process.platform === 'darwin') {
    const binPath = join(process.cwd(), 'bin', 'macos_ocr');
    if (existsSync(binPath)) {
      try {
        const { stdout } = await runCmd(binPath, ['--wechat-bounds']);
        const parsed = JSON.parse(stdout.trim());
        if (parsed && typeof parsed.width === 'number' && parsed.width > 100) {
          return parsed as WeChatWindowBounds;
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  // 2. Windows 实现 (PowerShell Win32 API)
  if (process.platform === 'win32') {
    try {
      const psScript = `
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Window {
          [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
          [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
          [StructLayout(LayoutKind.Sequential)]
          public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        }
'@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        $hWnd = [Win32Window]::FindWindow("WeChatMainWndForPC", $null)
        if ($hWnd -eq [IntPtr]::Zero) {
          $proc = Get-Process WeChat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
          if ($proc) { $hWnd = $proc.MainWindowHandle }
        }
        if ($hWnd -ne [IntPtr]::Zero) {
          $rect = New-Object Win32Window+RECT
          if ([Win32Window]::GetWindowRect($hWnd, [ref]$rect)) {
            $w = $rect.Right - $rect.Left
            $h = $rect.Bottom - $rect.Top
            if ($w -gt 200 -and $h -gt 200) {
              Write-Output "{""wid"":$($hWnd.ToInt64()),""x"":$($rect.Left),""y"":$($rect.Top),""width"":$w,""height"":$h}"
              exit
            }
          }
        }
        Write-Output "{}"
      `.trim();
      const { stdout } = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      const parsed = JSON.parse(stdout.trim() || '{}');
      if (parsed && typeof parsed.width === 'number' && parsed.width > 100) {
        return parsed as WeChatWindowBounds;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  // 3. Ubuntu / Linux 实现 (解析 xwininfo / wmctrl)
  if (process.platform === 'linux') {
    try {
      // 优先从 xwininfo -root -tree 提取
      const { stdout } = await runCmd('xwininfo', ['-root', '-tree']);
      for (const line of stdout.split('\n')) {
        if (/("wechat"|"微信"|"WeChat"|"weixin")/i.test(line)) {
          const m = line.match(/(0x[0-9a-fA-F]+)\s+"([^"]*)".*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
          if (m && m[1] && m[3] && m[4] && m[5] && m[6]) {
            const wid = parseInt(m[1], 16);
            const width = parseInt(m[3], 10);
            const height = parseInt(m[4], 10);
            const x = parseInt(m[5], 10);
            const y = parseInt(m[6], 10);
            if (width > 200 && height > 200) {
              return { wid, x, y, width, height };
            }
          }
        }
      }
    } catch {
      // 降级尝试 wmctrl -l -G
      try {
        const { stdout } = await runCmd('wmctrl', ['-l', '-G']);
        for (const line of stdout.split('\n')) {
          if (/wechat|微信|weixin/i.test(line)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 7 && parts[0] && parts[2] && parts[3] && parts[4] && parts[5]) {
              const wid = parseInt(parts[0], 16);
              const x = parseInt(parts[2], 10);
              const y = parseInt(parts[3], 10);
              const width = parseInt(parts[4], 10);
              const height = parseInt(parts[5], 10);
              if (width > 200 && height > 200) {
                return { wid, x, y, width, height };
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  return undefined;
}

/** 模拟鼠标移动并点击指定屏幕物理像素 (支持 macOS / Windows / Linux 原生驱动) */
export async function clickScreenCoords(x: number, y: number): Promise<boolean> {
  const roundX = Math.round(x);
  const roundY = Math.round(y);

  // 1. macOS 实现
  if (process.platform === 'darwin') {
    const binPath = join(process.cwd(), 'bin', 'macos_ocr');
    if (existsSync(binPath)) {
      try {
        await runCmd(binPath, ['--click', String(roundX), String(roundY)]);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // 2. Windows 实现 (Win32 API SetCursorPos + mouse_event)
  if (process.platform === 'win32') {
    try {
      const psScript = `
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Mouse {
          [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
          [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
        }
'@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        [Win32Mouse]::SetCursorPos(${roundX}, ${roundY})
        Start-Sleep -Milliseconds 25
        [Win32Mouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 45
        [Win32Mouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      `.trim();
      await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      return true;
    } catch {
      return false;
    }
  }

  // 3. Ubuntu / Linux 实现 (优先 libXtst 原生事件，降级 xdotool)
  if (process.platform === 'linux') {
    try {
      const pyScript = `
import ctypes, time, sys
try:
    X11 = ctypes.CDLL('libX11.so.6')
    Xtst = ctypes.CDLL('libXtst.so.6')
    disp = X11.XOpenDisplay(None)
    if not disp: sys.exit(1)
    Xtst.XTestFakeMotionEvent(disp, -1, ${roundX}, ${roundY}, 0)
    X11.XFlush(disp)
    time.sleep(0.025)
    Xtst.XTestFakeButtonEvent(disp, 1, True, 0)
    X11.XFlush(disp)
    time.sleep(0.045)
    Xtst.XTestFakeButtonEvent(disp, 1, False, 0)
    X11.XFlush(disp)
    X11.XCloseDisplay(disp)
except Exception:
    sys.exit(1)
      `.trim();
      await runCmd('python3', ['-c', pyScript]);
      return true;
    } catch {
      try {
        await runCmd('xdotool', ['mousemove', String(roundX), String(roundY), 'click', '1']);
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

/** 获取当前最顶层激活的应用名称或标识 */
async function getFrontmostApp(): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await runCmd('osascript', [
        '-e',
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  if (process.platform === 'win32') {
    try {
      const psScript = `
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Top {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        }
'@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        $h = [Win32Top]::GetForegroundWindow()
        Write-Output $h.ToInt64()
      `.trim();
      const { stdout } = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await runCmd('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
      const m = stdout.match(/_NET_ACTIVE_WINDOW.*?window id # (0x[0-9a-fA-F]+)/);
      if (m && m[1]) return m[1];
    } catch {
      // ignore
    }
  }

  return undefined;
}

/** 激活并置顶指定应用或窗口 */
async function activateApp(target: string | number): Promise<void> {
  if (process.platform === 'darwin' && typeof target === 'string') {
    try {
      await runCmd('osascript', ['-e', `tell application "${target}" to activate`]);
    } catch {}
  } else if (process.platform === 'win32') {
    try {
      const psScript = `
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Act {
          [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
'@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        $hWnd = [Win32Act]::FindWindow("WeChatMainWndForPC", $null)
        if ($hWnd -eq [IntPtr]::Zero) {
          $proc = Get-Process WeChat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
          if ($proc) { $hWnd = $proc.MainWindowHandle }
        }
        if ($hWnd -ne [IntPtr]::Zero) {
          [Win32Act]::ShowWindow($hWnd, 9)
          [Win32Act]::SetForegroundWindow($hWnd)
        } else {
          $wshell = New-Object -ComObject wscript.shell
          $activated = $wshell.AppActivate('微信')
          if (-not $activated) { $wshell.AppActivate('WeChat') }
        }
      `.trim();
      await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
    } catch {}
  } else if (process.platform === 'linux') {
    try {
      // 如果给定了具体 Window ID
      if (typeof target === 'number' || (typeof target === 'string' && /^0x/i.test(target))) {
        const widNum = typeof target === 'number' ? target : parseInt(target, 16);
        try {
          const pyAct = `
import ctypes
try:
    X11 = ctypes.CDLL('libX11.so.6')
    disp = X11.XOpenDisplay(None)
    if disp:
        X11.XMapRaised(disp, ${widNum})
        X11.XSetInputFocus(disp, ${widNum}, 1, 0)
        X11.XFlush(disp)
        X11.XCloseDisplay(disp)
except:
    pass
          `.trim();
          await runCmd('python3', ['-c', pyAct]);
        } catch {}

        try {
          await runCmd('wmctrl', ['-i', '-a', String(target)]);
          return;
        } catch {
          try {
            await runCmd('xdotool', ['windowactivate', String(target)]);
            return;
          } catch {}
        }
      }
      // 按名称激活
      try {
        await runCmd('wmctrl', ['-a', '微信']);
      } catch {
        try {
          await runCmd('wmctrl', ['-a', 'wechat']);
        } catch {
          await runCmd('xdotool', ['search', '--name', '微信', 'windowactivate']);
        }
      }
    } catch {}
  }
}

/** 读取剪贴板内容 (跨平台支持) */
async function getClipboardText(): Promise<string> {
  // 优先尝试 Electron clipboard API (如果运行于 Electron 环境中)
  try {
    if (process.versions?.electron) {
      const electron = await import('electron');
      if (electron.clipboard?.readText) {
        return electron.clipboard.readText();
      }
    }
  } catch {}

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await runCmd('pbpaste', []);
      return stdout;
    } catch {
      return '';
    }
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard']);
      return stdout;
    } catch {
      return '';
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await runCmd('xclip', ['-selection', 'clipboard', '-o']);
      return stdout;
    } catch {
      try {
        const { stdout } = await runCmd('xsel', ['--clipboard', '--output']);
        return stdout;
      } catch {
        return '';
      }
    }
  }

  return '';
}

/** 设置系统剪贴板内容 (跨平台支持) */
async function setClipboardText(text: string): Promise<void> {
  // 优先尝试 Electron clipboard API
  try {
    if (process.versions?.electron) {
      const electron = await import('electron');
      if (electron.clipboard?.writeText) {
        electron.clipboard.writeText(text);
        return;
      }
    }
  } catch {}

  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      const child = spawn('pbcopy');
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pbcopy exited with code ${code}`));
      });
      child.stdin.write(text, 'utf-8');
      child.stdin.end();
    });
  }

  if (process.platform === 'win32') {
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Clipboard]::SetText([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64}")))
    `.trim();
    await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
    return;
  }

  if (process.platform === 'linux') {
    // 依次尝试 xclip、xsel 与 python tkinter
    let ok = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('xclip', ['-selection', 'clipboard']);
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`xclip code ${code}`));
        });
        child.stdin.write(text, 'utf-8');
        child.stdin.end();
      });
      ok = true;
    } catch {}

    if (!ok) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('xsel', ['--clipboard', '--input']);
          child.on('error', reject);
          child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`xsel code ${code}`));
          });
          child.stdin.write(text, 'utf-8');
          child.stdin.end();
        });
        ok = true;
      } catch {}
    }

    if (!ok) {
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      const pyScript = `
import tkinter as tk, base64
text = base64.b64decode("${b64}").decode("utf-8")
r = tk.Tk()
r.withdraw()
r.clipboard_clear()
r.clipboard_append(text)
r.update()
r.destroy()
      `.trim();
      await runCmd('python3', ['-c', pyScript]);
    }
  }
}

/** 模拟人类键鼠停顿 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 模拟在微信中回复消息（完全参照 SightFlow RPA 纯视觉键鼠联动机制）
 * 适用于 macOS、Windows、Ubuntu/Linux 全平台：
 * 1. 优先通过鼠标点击左侧会话列表切入目标对话（对标 SightFlow clickUnreadContactAction）
 * 2. 鼠标点击定位至右下角文字输入框获取焦点（对标 SightFlow getWeChatInputPosition）
 * 3. 剪贴板 Cmd/Ctrl+V 粘贴 + 回车发送
 */
export async function sendWeChatReply(options: SendReplyOptions): Promise<ActionDriverResult> {
  const { targetCoords, switchToTarget = false, text, delayMs = 300, restoreFocus = true } = options;

  if (!text || text.trim() === '') {
    return { ok: false, error: '回复内容不能为空' };
  }

  // ==========================================
  // 1. macOS 实现 (AppleScript + pbcopy + CoreGraphics)
  // ==========================================
  if (process.platform === 'darwin') {
    let prevApp: string | undefined;
    let prevClipboard = '';

    try {
      if (restoreFocus) {
        prevApp = await getFrontmostApp();
      }
      prevClipboard = await getClipboardText();

      // 先把要发送的文本写入系统剪贴板
      await setClipboardText(text);

      // 1. 激活微信应用置于前台
      await activateApp('WeChat');
      await sleep(150);

      // 2. 获取微信窗口在当前屏幕中的绝对位置坐标与尺寸
      const bounds = await getWeChatWindowBounds();

      // 3. 若需要切换会话：模拟鼠标点击该联系人条目
      if (switchToTarget && bounds) {
        let clickX = bounds.x + 130; // 默认会话列表首项中心 X 轴
        let clickY = bounds.y + 90;  // 默认会话列表首项中心 Y 轴

        if (targetCoords && targetCoords.length === 2) {
          const [normX, normY] = targetCoords;
          clickX = normX <= 1.0 ? bounds.x + bounds.width * normX : normX;
          clickY = normY <= 1.0 ? bounds.y + bounds.height * (1.0 - normY) : normY;
        }

        await clickScreenCoords(clickX, clickY);
        await sleep(220); // 等待微信视图加载新会话
      }

      // 4. 点击输入框区域使其聚焦
      if (bounds) {
        const inputX = bounds.x + bounds.width - 250;
        const inputY = bounds.y + bounds.height - 45;
        await clickScreenCoords(inputX, inputY);
        await sleep(120);
      }

      // 5. 粘贴并回车发送
      const pasteAndSendScript = `
        tell application "System Events"
          tell process "WeChat"
            keystroke "v" using command down
            delay 0.15
            key code 36
          end tell
        end tell
      `;
      await runCmd('osascript', ['-e', pasteAndSendScript]);

      await sleep(delayMs);

      // 恢复剪贴板与焦点
      if (prevClipboard) await setClipboardText(prevClipboard);
      if (restoreFocus && prevApp && prevApp !== 'WeChat') {
        await activateApp(prevApp);
      }

      return { ok: true };
    } catch (err) {
      try { if (prevClipboard) await setClipboardText(prevClipboard); } catch {}
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `macOS 自动化回复失败: ${msg}（请检查系统设置 -> 隐私与安全性 -> 辅助功能权限）`,
      };
    }
  }

  // ==========================================
  // 2. Windows 实现 (PowerShell + Win32 + SendKeys)
  // ==========================================
  if (process.platform === 'win32') {
    let prevClipboard = '';
    let prevApp: string | undefined;

    try {
      if (restoreFocus) prevApp = await getFrontmostApp();
      prevClipboard = await getClipboardText();

      // 1. 设置剪贴板
      await setClipboardText(text);

      // 2. 激活微信
      await activateApp('WeChat');
      await sleep(180);

      // 3. 获取窗口 Bounds
      const bounds = await getWeChatWindowBounds();

      // 4. 若需要切换会话
      if (switchToTarget && bounds) {
        let clickX = bounds.x + 130;
        let clickY = bounds.y + 90;
        if (targetCoords && targetCoords.length === 2) {
          const [normX, normY] = targetCoords;
          clickX = normX <= 1.0 ? bounds.x + bounds.width * normX : normX;
          clickY = normY <= 1.0 ? bounds.y + bounds.height * (1.0 - normY) : normY;
        }
        await clickScreenCoords(clickX, clickY);
        await sleep(220);
      }

      // 5. 聚焦输入框
      if (bounds) {
        const inputX = bounds.x + bounds.width - 200;
        const inputY = bounds.y + bounds.height - 45;
        await clickScreenCoords(inputX, inputY);
        await sleep(120);
      }

      // 6. Ctrl+V 粘贴 + 回车发送
      const psSend = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 150
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      `.trim();
      await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psSend]);

      await sleep(delayMs);

      // 7. 恢复剪贴板与窗口
      if (prevClipboard) await setClipboardText(prevClipboard);
      if (restoreFocus && prevApp) {
        try {
          const psRestore = `
            $code = @'
            using System;
            using System.Runtime.InteropServices;
            public class Win32Rest {
              [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
            }
'@
            Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
            [Win32Rest]::SetForegroundWindow([IntPtr]${prevApp})
          `.trim();
          await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psRestore]);
        } catch {}
      }

      return { ok: true };
    } catch (err) {
      try { if (prevClipboard) await setClipboardText(prevClipboard); } catch {}
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Windows 微信自动化回复失败: ${msg}` };
    }
  }

  // ==========================================
  // 3. Ubuntu / Linux 实现 (libXtst + libX11 + Clipboard)
  // ==========================================
  if (process.platform === 'linux') {
    let prevClipboard = '';
    let prevWindow: string | undefined;

    try {
      if (restoreFocus) prevWindow = await getFrontmostApp();
      prevClipboard = await getClipboardText();

      // 1. 设置剪贴板内容
      await setClipboardText(text);

      // 2. 获取微信窗口边界与坐标
      const bounds = await getWeChatWindowBounds();

      // 3. 激活微信视窗
      if (bounds?.wid) {
        await activateApp(bounds.wid);
      } else {
        await activateApp('微信');
      }
      await sleep(200);

      // 4. 若需要切换会话：点击左侧列表联系人条目
      if (switchToTarget && bounds) {
        let clickX = bounds.x + 130;
        let clickY = bounds.y + 90;
        if (targetCoords && targetCoords.length === 2) {
          const [normX, normY] = targetCoords;
          clickX = normX <= 1.0 ? bounds.x + bounds.width * normX : normX;
          clickY = normY <= 1.0 ? bounds.y + bounds.height * (1.0 - normY) : normY;
        }
        await clickScreenCoords(clickX, clickY);
        await sleep(220);
      }

      // 5. 点击右下角输入框使其聚焦
      if (bounds) {
        const inputX = bounds.x + bounds.width - 220;
        const inputY = bounds.y + bounds.height - 45;
        await clickScreenCoords(inputX, inputY);
        await sleep(120);
      }

      // 6. 发送 Ctrl+V 粘贴与 Return 回车按键
      let keySent = false;
      try {
        // 优先使用原生 libXtst 发送精准按键事件 (37: Ctrl, 55: v, 36: Return)
        const pyKeyScript = `
import ctypes, time, sys
try:
    X11 = ctypes.CDLL('libX11.so.6')
    Xtst = ctypes.CDLL('libXtst.so.6')
    disp = X11.XOpenDisplay(None)
    if not disp: sys.exit(1)
    kc_ctrl = X11.XKeysymToKeycode(disp, 0xffe3) or 37
    kc_v = X11.XKeysymToKeycode(disp, 0x0076) or 55
    kc_ret = X11.XKeysymToKeycode(disp, 0xff0d) or 36

    # 按下 Ctrl+V
    Xtst.XTestFakeKeyEvent(disp, kc_ctrl, True, 0)
    Xtst.XTestFakeKeyEvent(disp, kc_v, True, 0)
    X11.XFlush(disp)
    time.sleep(0.04)
    Xtst.XTestFakeKeyEvent(disp, kc_v, False, 0)
    Xtst.XTestFakeKeyEvent(disp, kc_ctrl, False, 0)
    X11.XFlush(disp)
    time.sleep(0.12)

    # 按下 Return 回车发送
    Xtst.XTestFakeKeyEvent(disp, kc_ret, True, 0)
    X11.XFlush(disp)
    time.sleep(0.04)
    Xtst.XTestFakeKeyEvent(disp, kc_ret, False, 0)
    X11.XFlush(disp)
    X11.XCloseDisplay(disp)
except Exception:
    sys.exit(1)
        `.trim();
        await runCmd('python3', ['-c', pyKeyScript]);
        keySent = true;
      } catch {
        // 降级使用 xdotool
        try {
          await runCmd('xdotool', ['key', '--clearmodifiers', 'ctrl+v', 'Return']);
          keySent = true;
        } catch {}
      }

      if (!keySent) {
        return { ok: false, error: 'Linux 输入模拟失败：未能向微信发送按键事件' };
      }

      await sleep(delayMs);

      // 7. 恢复剪贴板与焦点
      if (prevClipboard) await setClipboardText(prevClipboard);
      if (restoreFocus && prevWindow) {
        await activateApp(prevWindow);
      }

      return { ok: true };
    } catch (err) {
      try { if (prevClipboard) await setClipboardText(prevClipboard); } catch {}
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Linux 微信自动化回复失败: ${msg}` };
    }
  }

  return { ok: false, error: `当前操作系统 (${process.platform}) 暂不支持模拟输入` };
}
