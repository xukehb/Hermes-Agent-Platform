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

export interface SendReplyOptions {
  targetName?: string | undefined;
  text: string;
  delayMs?: number | undefined;
  restoreFocus?: boolean | undefined;
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
 * 模拟在微信中回复消息（macOS 与 Windows 跨平台自动化）
 */
export async function sendWeChatReply(options: SendReplyOptions): Promise<ActionDriverResult> {
  const { targetName, text, delayMs = 300, restoreFocus = true } = options;

  if (!text || text.trim() === '') {
    return { ok: false, error: '回复内容不能为空' };
  }

  // --- macOS 实现 (AppleScript + pbcopy + System Events) ---
  if (process.platform === 'darwin') {
    let prevApp: string | undefined;
    let prevClipboard = '';

    try {
      if (restoreFocus) {
        prevApp = await getFrontmostMacApp();
      }
      prevClipboard = await getMacClipboard();

      // 先把要发送的文本放入剪贴板
      await setMacClipboard(text);

      if (targetName && targetName.trim() !== '') {
        // 如果指定了联系人目标，利用微信原生全局搜索快捷键 Cmd + F 定位好友会话
        const switchAndSendScript = `
          tell application "WeChat" to activate
          delay 0.15
          tell application "System Events"
            tell process "WeChat"
              keystroke "f" using command down
              delay 0.2
              keystroke "${targetName.replace(/"/g, '\\"')}"
              delay 0.35
              key code 36
              delay 0.25
              keystroke "v" using command down
              delay 0.15
              key code 36
            end tell
          end tell
        `;
        await runAppleScript(switchAndSendScript);
      } else {
        // 已经在当前会话窗口，直接激活、粘贴并回车发送
        const sendDirectScript = `
          tell application "WeChat" to activate
          delay 0.15
          tell application "System Events"
            tell process "WeChat"
              keystroke "v" using command down
              delay 0.15
              key code 36
            end tell
          end tell
        `;
        await runAppleScript(sendDirectScript);
      }

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
      // 尽可能恢复剪贴板
      try {
        if (prevClipboard) await setMacClipboard(prevClipboard);
      } catch {}
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `macOS 自动化回复失败: ${msg}（请检查系统设置 -> 隐私与安全性 -> 辅助功能与自动化权限）`,
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
