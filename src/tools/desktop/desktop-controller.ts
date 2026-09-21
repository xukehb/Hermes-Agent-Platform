/**
 * 桌面操控控制器 (DesktopController)
 *
 * 提供原生跨平台（macOS、Windows、Linux）的桌面计算机操控能力（Computer Use）：
 * - 屏幕截图：macOS 原生 screencapture / Windows PowerShell / Linux 截图
 * - 屏幕感知：物理分辨率感知与鼠标实时坐标检测
 * - 鼠标交互：精准移动、单击、右键、双击、拖拽、滚轮滚动
 * - 键盘交互：文字输入、系统功能键与组合快捷键
 * - 窗口管理：正在运行的可见窗口应用枚举与窗口置顶激活
 */

import { existsSync, writeFileSync } from 'node:fs';
import { execa } from 'execa';

export interface ScreenInfo {
  width: number;
  height: number;
  mouseX: number;
  mouseY: number;
}

export interface WindowInfo {
  name: string;
  title?: string | undefined;
}

export class DesktopController {
  private static instance: DesktopController | null = null;

  static getInstance(): DesktopController {
    if (!DesktopController.instance) {
      DesktopController.instance = new DesktopController();
    }
    return DesktopController.instance;
  }

  /** 获取主显示屏尺寸与当前鼠标物理坐标 */
  async getScreenInfo(): Promise<ScreenInfo> {
    if (process.platform === 'darwin') {
      const pyScript = `
import ctypes, ctypes.util, json
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
class CGRect(ctypes.Structure):
    _fields_ = [('origin', CGPoint), ('size', CGPoint)]
cg.CGMainDisplayID.restype = ctypes.c_uint32
cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
cg.CGDisplayBounds.restype = CGRect
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
cg.CGEventGetLocation.restype = CGPoint
disp = cg.CGMainDisplayID()
rect = cg.CGDisplayBounds(disp)
evt = cg.CGEventCreate(None)
mouse = cg.CGEventGetLocation(evt)
print(json.dumps({'width': int(rect.size.x), 'height': int(rect.size.y), 'mouseX': int(mouse.x), 'mouseY': int(mouse.y)}))
`;
      const res = await execa('python3', ['-c', pyScript]);
      return JSON.parse(res.stdout.trim()) as ScreenInfo;
    } else if (process.platform === 'win32') {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$pos = [System.Windows.Forms.Cursor]::Position;
@{ width = $screen.Width; height = $screen.Height; mouseX = $pos.X; mouseY = $pos.Y } | ConvertTo-Json -Compress
`;
      const res = await execa('powershell', ['-NoProfile', '-Command', psScript]);
      return JSON.parse(res.stdout.trim()) as ScreenInfo;
    } else {
      // Linux 兼容
      try {
        const geomRes = await execa('xdotool', ['getdisplaygeometry']);
        const parts = geomRes.stdout.trim().split(/\s+/).map(Number);
        const locRes = await execa('xdotool', ['getmouselocation']);
        const xMatch = locRes.stdout.match(/x:(\d+)/);
        const yMatch = locRes.stdout.match(/y:(\d+)/);
        return {
          width: parts[0] || 1920,
          height: parts[1] || 1080,
          mouseX: xMatch ? Number(xMatch[1]) : 0,
          mouseY: yMatch ? Number(yMatch[1]) : 0,
        };
      } catch {
        return { width: 1920, height: 1080, mouseX: 0, mouseY: 0 };
      }
    }
  }

  /** 截取当前主桌面屏幕截图并保存为 PNG */
  async screenshot(outputPath: string): Promise<{ path: string; width: number; height: number }> {
    if (process.platform === 'darwin') {
      // -x: 静音无拍照快门声
      await execa('/usr/sbin/screencapture', ['-x', outputPath]);
    } else if (process.platform === 'win32') {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
$bitmap.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose();
$bitmap.Dispose();
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
    } else {
      try {
        await execa('scrot', [outputPath]);
      } catch {
        await execa('import', ['-window', 'root', outputPath]);
      }
    }

    if (!existsSync(outputPath)) {
      throw new Error(`桌面截图保存失败，未在路径检测到生成的文件：${outputPath}`);
    }

    const info = await this.getScreenInfo();
    return {
      path: outputPath,
      width: info.width,
      height: info.height,
    };
  }

  /** 精准移动鼠标光标到 (x, y) */
  async mouseMove(x: number, y: number): Promise<void> {
    if (process.platform === 'darwin') {
      const pyScript = `
import ctypes, ctypes.util
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
evt = cg.CGEventCreateMouseEvent(None, 5, CGPoint(${x}, ${y}), 0)
cg.CGEventPost(0, evt)
`;
      await execa('python3', ['-c', pyScript]);
    } else if (process.platform === 'win32') {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
    } else {
      await execa('xdotool', ['mousemove', String(x), String(y)]);
    }
  }

  /** 鼠标点击（左键/右键/中键，单击/双击/三击） */
  async mouseClick(options: {
    x?: number | undefined;
    y?: number | undefined;
    button?: 'left' | 'right' | 'middle' | undefined;
    clickType?: 'single' | 'double' | 'triple' | undefined;
  } = {}): Promise<void> {
    const info = await this.getScreenInfo();
    const x = options.x !== undefined ? options.x : info.mouseX;
    const y = options.y !== undefined ? options.y : info.mouseY;
    const button = options.button || 'left';
    const clickType = options.clickType || 'single';
    const clickCount = clickType === 'double' ? 2 : clickType === 'triple' ? 3 : 1;

    if (process.platform === 'darwin') {
      const downType = button === 'right' ? 3 : button === 'middle' ? 25 : 1;
      const upType = button === 'right' ? 4 : button === 'middle' ? 26 : 2;
      const cgButton = button === 'right' ? 1 : button === 'middle' ? 2 : 0;

      const pyScript = `
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventSetIntegerValueField.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int64]

pt = CGPoint(${x}, ${y})
for c in range(1, ${clickCount} + 1):
    down = cg.CGEventCreateMouseEvent(None, ${downType}, pt, ${cgButton})
    cg.CGEventSetIntegerValueField(down, 1, c)
    cg.CGEventPost(0, down)
    time.sleep(0.04)
    up = cg.CGEventCreateMouseEvent(None, ${upType}, pt, ${cgButton})
    cg.CGEventSetIntegerValueField(up, 1, c)
    cg.CGEventPost(0, up)
    if c < ${clickCount}:
        time.sleep(0.08)
`;
      await execa('python3', ['-c', pyScript]);
    } else if (process.platform === 'win32') {
      const btnCode = button === 'right' ? '0x08, 0x10' : '0x02, 0x04';
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
$sig = @'
[DllImport("user32.dll")]
public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
'@
$user32 = Add-Type -MemberDefinition $sig -Name "Win32Mouse" -Namespace "Win32" -PassThru;
for ($i=0; $i -lt ${clickCount}; $i++) {
  $user32::mouse_event(${button === 'right' ? 0x08 : 0x02}, 0, 0, 0, 0);
  Start-Sleep -Milliseconds 40;
  $user32::mouse_event(${button === 'right' ? 0x10 : 0x04}, 0, 0, 0, 0);
  Start-Sleep -Milliseconds 60;
}
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
    } else {
      const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      for (let i = 0; i < clickCount; i++) {
        await execa('xdotool', ['mousemove', String(x), String(y), 'click', btn]);
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }

  /** 鼠标拖拽 */
  async mouseDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    if (process.platform === 'darwin') {
      const pyScript = `
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

p1 = CGPoint(${fromX}, ${fromY})
p2 = CGPoint(${toX}, ${toY})

down = cg.CGEventCreateMouseEvent(None, 1, p1, 0)
cg.CGEventPost(0, down)
time.sleep(0.1)

steps = 15
for i in range(1, steps + 1):
    cx = ${fromX} + (${toX} - ${fromX}) * i / steps
    cy = ${fromY} + (${toY} - ${fromY}) * i / steps
    drag = cg.CGEventCreateMouseEvent(None, 6, CGPoint(cx, cy), 0)
    cg.CGEventPost(0, drag)
    time.sleep(0.02)

up = cg.CGEventCreateMouseEvent(None, 2, p2, 0)
cg.CGEventPost(0, up)
`;
      await execa('python3', ['-c', pyScript]);
    } else {
      await this.mouseMove(fromX, fromY);
      await this.mouseClick({ x: fromX, y: fromY });
      await this.mouseMove(toX, toY);
    }
  }

  /** 鼠标滚轮滚动 (deltaY: 正数向下滚动，负数向上滚动) */
  async mouseScroll(deltaY: number, deltaX = 0): Promise<void> {
    if (process.platform === 'darwin') {
      const pyScript = `
import ctypes, ctypes.util
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
cg.CGEventCreateScrollWheelEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32, ctypes.c_int32]
cg.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

# 0 为像素单位滚动
evt = cg.CGEventCreateScrollWheelEvent(None, 0, 2, ${-deltaY}, ${-deltaX})
cg.CGEventPost(0, evt)
`;
      await execa('python3', ['-c', pyScript]);
    } else if (process.platform === 'win32') {
      const psScript = `
$sig = @'
[DllImport("user32.dll")]
public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
'@
$user32 = Add-Type -MemberDefinition $sig -Name "Win32Scroll" -Namespace "Win32" -PassThru;
$user32::mouse_event(0x0800, 0, 0, ${-deltaY}, 0);
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
    } else {
      const btn = deltaY > 0 ? '5' : '4';
      await execa('xdotool', ['click', btn]);
    }
  }

  /** 键盘输入文本内容 */
  async keyboardType(text: string): Promise<void> {
    if (process.platform === 'darwin') {
      // 通过 osascript System Events 发送按键输入
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "System Events" to keystroke "${escaped}"`;
      await execa('osascript', ['-e', script]);
    } else if (process.platform === 'win32') {
      const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}').replace(/"/g, '`"');
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait("${escaped}");
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
    } else {
      await execa('xdotool', ['type', '--', text]);
    }
  }

  /**
   * 按下特殊按键或组合快捷键
   * 支持如：Return, Enter, Escape, Tab, Space, Backspace, Delete, Up, Down, Left, Right
   * 以及组合键：cmd+c, cmd+v, cmd+a, cmd+s, ctrl+c, alt+tab 等
   */
  async keyboardPress(key: string): Promise<void> {
    const rawKey = key.trim().toLowerCase();

    if (process.platform === 'darwin') {
      const isCmd = rawKey.includes('cmd') || rawKey.includes('command');
      const isCtrl = rawKey.includes('ctrl') || rawKey.includes('control');
      const isAlt = rawKey.includes('alt') || rawKey.includes('option');
      const isShift = rawKey.includes('shift');

      const modifiers: string[] = [];
      if (isCmd) modifiers.push('command down');
      if (isCtrl) modifiers.push('control down');
      if (isAlt) modifiers.push('option down');
      if (isShift) modifiers.push('shift down');
      const usingClause = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';

      const keyCodes: Record<string, number> = {
        return: 36,
        enter: 36,
        tab: 48,
        space: 49,
        backspace: 51,
        delete: 51,
        escape: 53,
        esc: 53,
        left: 123,
        right: 124,
        down: 125,
        up: 126,
      };

      const cleanKey = rawKey.split(/[-+]/).pop() || '';
      if (keyCodes[cleanKey] !== undefined) {
        const script = `tell application "System Events" to key code ${keyCodes[cleanKey]}${usingClause}`;
        await execa('osascript', ['-e', script]);
      } else {
        const script = `tell application "System Events" to keystroke "${cleanKey}"${usingClause}`;
        await execa('osascript', ['-e', script]);
      }
    } else if (process.platform === 'win32') {
      const sendKeysMap: Record<string, string> = {
        return: '{ENTER}',
        enter: '{ENTER}',
        tab: '{TAB}',
        space: ' ',
        backspace: '{BACKSPACE}',
        delete: '{DELETE}',
        escape: '{ESC}',
        esc: '{ESC}',
        up: '{UP}',
        down: '{DOWN}',
        left: '{LEFT}',
        right: '{RIGHT}',
      };
      let sendKeyStr = sendKeysMap[rawKey] || rawKey;
      if (rawKey.includes('ctrl+')) sendKeyStr = '^' + (sendKeysMap[rawKey.replace('ctrl+', '')] || rawKey.replace('ctrl+', ''));
      if (rawKey.includes('alt+')) sendKeyStr = '%' + (sendKeysMap[rawKey.replace('alt+', '')] || rawKey.replace('alt+', ''));
      if (rawKey.includes('shift+')) sendKeyStr = '+' + (sendKeysMap[rawKey.replace('shift+', '')] || rawKey.replace('shift+', ''));

      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait("${sendKeyStr}");
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
    } else {
      await execa('xdotool', ['key', key]);
    }
  }

  /** 获取当前可见的运行应用与窗口列表 */
  async listWindows(): Promise<WindowInfo[]> {
    if (process.platform === 'darwin') {
      const script = `tell application "System Events" to get name of every process whose background only is false`;
      const res = await execa('osascript', ['-e', script]);
      const names = res.stdout.split(',').map((n) => n.trim()).filter(Boolean);
      return names.map((name) => ({ name }));
    } else if (process.platform === 'win32') {
      const psScript = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -Property ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
      const res = await execa('powershell', ['-NoProfile', '-Command', psScript]);
      try {
        const raw = JSON.parse(res.stdout) as Array<{ ProcessName: string; MainWindowTitle: string }> | { ProcessName: string; MainWindowTitle: string };
        const list = Array.isArray(raw) ? raw : [raw];
        return list.map((item) => ({ name: item.ProcessName, title: item.MainWindowTitle }));
      } catch {
        return [];
      }
    } else {
      try {
        const res = await execa('wmctrl', ['-l']);
        return res.stdout.split('\n').filter(Boolean).map((line) => {
          const parts = line.split(/\s+/);
          return { name: parts[3] || 'window', title: parts.slice(4).join(' ') };
        });
      } catch {
        return [];
      }
    }
  }

  /** 置顶激活指定窗口或应用 */
  async focusWindow(appName: string): Promise<boolean> {
    if (process.platform === 'darwin') {
      const script = `tell application "${appName.replace(/"/g, '\\"')}" to activate`;
      await execa('osascript', ['-e', script]);
      await new Promise((r) => setTimeout(r, 400));
      return true;
    } else if (process.platform === 'win32') {
      const psScript = `
$app = Get-Process -Name "${appName.replace(/"/g, '`"')}" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle } | Select-Object -First 1;
if ($app) {
  $sig = @'
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
  $user32 = Add-Type -MemberDefinition $sig -Name "Win32Focus" -Namespace "Win32" -PassThru;
  $user32::SetForegroundWindow($app.MainWindowHandle);
}
`;
      await execa('powershell', ['-NoProfile', '-Command', psScript]);
      return true;
    } else {
      try {
        await execa('wmctrl', ['-a', appName]);
        return true;
      } catch {
        return false;
      }
    }
  }
}
