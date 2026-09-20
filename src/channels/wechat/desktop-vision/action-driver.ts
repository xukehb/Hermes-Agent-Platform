import { execFile, spawn } from 'node:child_process';

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

import { join } from 'node:path';
import { existsSync } from 'node:fs';

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

import { ensureMacOcrBinary } from './ocr-parser.js';

/** 获取微信主窗口屏幕边界坐标 (macOS) */
export async function getWeChatWindowBounds(): Promise<WeChatWindowBounds | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const binPath = ensureMacOcrBinary();
  if (binPath && existsSync(binPath)) {
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

/** 模拟鼠标移动并点击指定屏幕物理像素 (macOS CoreGraphics 原生驱动) */
export async function clickScreenCoords(x: number, y: number): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const binPath = ensureMacOcrBinary();
  if (binPath && existsSync(binPath)) {
    try {
      await runCmd(binPath, ['--click', String(Math.round(x)), String(Math.round(y))]);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 获取 macOS 当前最顶层的应用名称 */
async function getFrontmostMacApp(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
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

/** 激活指定应用 (macOS) */
async function activateMacApp(appName: string): Promise<void> {
  if (process.platform !== 'darwin' || !appName) return;
  try {
    await runCmd('osascript', ['-e', `tell application "${appName}" to activate`]);
  } catch {
    // 忽略切回失败
  }
}

/** 读取剪贴板内容 (macOS) */
async function getMacClipboard(): Promise<string> {
  if (process.platform !== 'darwin') return '';
  try {
    const { stdout } = await runCmd('pbpaste', []);
    return stdout;
  } catch {
    return '';
  }
}

/** 设置剪贴板内容 (macOS) */
async function setMacClipboard(text: string): Promise<void> {
  if (process.platform !== 'darwin') return;
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

/** 运行 AppleScript 脚本 */
async function runAppleScript(script: string): Promise<void> {
  await runCmd('osascript', ['-e', script]);
}

/** 模拟人类打字停顿 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 模拟在微信中回复消息（完全参照 SightFlow RPA 纯视觉键鼠联动机制）
 * 1. 优先通过鼠标点击左侧会话列表切入目标对话（对标 SightFlow clickUnreadContactAction）
 * 2. 鼠标点击定位至右下角文字输入框获取焦点（对标 SightFlow getWeChatInputPosition）
 * 3. 剪贴板 Cmd/Ctrl+V 粘贴 + 回车发送
 */
export async function sendWeChatReply(options: SendReplyOptions): Promise<ActionDriverResult> {
  const { targetName, targetCoords, switchToTarget = false, text, delayMs = 300, restoreFocus = true } = options;

  if (!text || text.trim() === '') {
    return { ok: false, error: '回复内容不能为空' };
  }

  // --- macOS 实现 (CoreGraphics 视觉点击 + AppleScript + pbcopy) ---
  if (process.platform === 'darwin') {
    let prevApp: string | undefined;
    let prevClipboard = '';

    try {
      if (restoreFocus) {
        prevApp = await getFrontmostMacApp();
      }
      prevClipboard = await getMacClipboard();

      // 先把要发送的文本写入系统剪贴板
      await setMacClipboard(text);

      // 1. 激活微信应用置于前台
      await activateMacApp('WeChat');
      await sleep(150);

      // 2. 获取微信窗口在当前屏幕中的绝对位置坐标与尺寸
      const bounds = await getWeChatWindowBounds();

      // 3. 若需要切换会话：参照 SightFlow clickUnreadContactAction 模拟鼠标点击该联系人条目
      if (switchToTarget && bounds) {
        let clickX = bounds.x + 130; // 默认会话列表首项中心 X 轴
        let clickY = bounds.y + 90;  // 默认会话列表首项中心 Y 轴

        if (targetCoords && targetCoords.length === 2) {
          const [normX, normY] = targetCoords;
          // 若为 0~1 归一化坐标，转换为屏幕绝对坐标
          clickX = normX <= 1.0 ? bounds.x + bounds.width * normX : normX;
          // Vision OCR y 轴从底部向上递增，转换为屏幕 top-down 坐标
          clickY = normY <= 1.0 ? bounds.y + bounds.height * (1.0 - normY) : normY;
        }

        // 模拟鼠标点击该未读会话项
        await clickScreenCoords(clickX, clickY);
        await sleep(220); // 等待微信视图加载新会话
      }

      // 4. 参照 SightFlow getWeChatInputPosition：点击输入框区域使其聚焦
      if (bounds) {
        const inputX = bounds.x + bounds.width - 250;
        const inputY = bounds.y + bounds.height - 45;
        await clickScreenCoords(inputX, inputY);
        await sleep(120);
      }

      // 5. 粘贴并回车发送（绝不调用任何搜索快捷键 Cmd+F）
      const pasteAndSendScript = `
        tell application "System Events"
          tell process "WeChat"
            keystroke "v" using command down
            delay 0.15
            key code 36
          end tell
        end tell
      `;
      await runAppleScript(pasteAndSendScript);

      await sleep(delayMs);

      // 恢复用户的原始剪贴板，避免破坏用户的剪切板体验
      if (prevClipboard) {
        await setMacClipboard(prevClipboard);
      }

      // 如果需要，恢复切回用户之前聚焦的应用程序
      if (restoreFocus && prevApp && prevApp !== 'WeChat') {
        await activateMacApp(prevApp);
      }

      return { ok: true };
    } catch (err) {
      try {
        if (prevClipboard) await setMacClipboard(prevClipboard);
      } catch {}
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `macOS 自动化回复失败: ${msg}（请检查系统设置 -> 隐私与安全性 -> 辅助功能权限）`,
      };
    }
  }

  // --- Windows 实现 (PowerShell) ---
  if (process.platform === 'win32') {
    try {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${Buffer.from(text).toString('base64')}")))
        $wshell = New-Object -ComObject wscript.shell
        $activated = $wshell.AppActivate('微信')
        if (-not $activated) { $wshell.AppActivate('WeChat') }
        Start-Sleep -Milliseconds 250
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 150
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      `;
      await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Windows 微信自动化回复失败: ${msg}` };
    }
  }

  return { ok: false, error: `当前操作系统 (${process.platform}) 暂不支持模拟输入` };
}
