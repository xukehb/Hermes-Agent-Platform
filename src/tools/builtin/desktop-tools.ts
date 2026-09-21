/**
 * 桌面操控工具集 (Desktop Control Tools)
 *
 * 为智能体赋予操作系统原生桌面计算机使用（Computer Use）能力：
 * 屏幕截图、分辨率感知、鼠标精准点击与移动、键盘按键与快捷键、窗口枚举与置顶。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../define.js';
import { DesktopController } from '../desktop/desktop-controller.js';

export const desktopScreenshotTool = defineTool({
  name: 'desktop_screenshot',
  description: '截取当前系统桌面主屏幕的完整高清画面并保存为本地图片，自动返回 Markdown 图片供视觉模型感知桌面状态',
  schema: z.object({
    outputFileName: z.string().optional().describe('自定义输出文件名，如 screenshot.png，缺省按时间戳命名'),
  }),
  run: async (args, ctx) => {
    try {
      const desktop = DesktopController.getInstance();
      const workspace = ctx.agent.workspace || process.cwd();
      const screenshotsDir = join(workspace, 'desktop_screenshots');
      if (!existsSync(screenshotsDir)) {
        mkdirSync(screenshotsDir, { recursive: true });
      }

      const timestamp = Date.now();
      const filename = (args.outputFileName || `desktop_${timestamp}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const targetPath = resolve(screenshotsDir, filename);

      const shot = await desktop.screenshot(targetPath);
      const normPath = shot.path.replace(/\\/g, '/');

      return {
        content: `🖥️ 桌面屏幕截图已成功捕获！\n\n![桌面截图](file:///${normPath})\n\n- 文件路径: \`${shot.path}\`\n- 分辨率: ${shot.width}x${shot.height}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `桌面截图失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopScreenSizeTool = defineTool({
  name: 'desktop_screen_size',
  description: '获取主显示屏的分辨率宽度、高度以及当前鼠标光标所在的 (X, Y) 物理坐标',
  schema: z.object({}),
  run: async () => {
    try {
      const desktop = DesktopController.getInstance();
      const info = await desktop.getScreenInfo();
      return {
        content: `📐 当前桌面主显示器规格:\n- 宽度 (Width): ${info.width}px\n- 高度 (Height): ${info.height}px\n- 鼠标当前位置: X=${info.mouseX}, Y=${info.mouseY}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `获取桌面规格失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopMouseMoveTool = defineTool({
  name: 'desktop_mouse_move',
  description: '将鼠标光标移动到屏幕上的指定物理坐标 (X, Y)',
  schema: z.object({
    x: z.number().describe('目标横坐标 X'),
    y: z.number().describe('目标纵坐标 Y'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.mouseMove(args.x, args.y);
      return {
        content: `🖱️ 鼠标光标已移动至 (${args.x}, ${args.y})。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `鼠标移动失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopMouseClickTool = defineTool({
  name: 'desktop_mouse_click',
  description: '在当前鼠标位置或指定的 (X, Y) 坐标执行鼠标点击（支持左键/右键/中键，单击/双击/三击）',
  schema: z.object({
    x: z.number().optional().describe('可选：点击的横坐标 X，缺省为当前光标位置'),
    y: z.number().optional().describe('可选：点击的纵坐标 Y，缺省为当前光标位置'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left').describe('鼠标按键：left(左键) / right(右键) / middle(中键)'),
    clickType: z.enum(['single', 'double', 'triple']).optional().default('single').describe('点击类型：single(单击) / double(双击) / triple(三击)'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.mouseClick(args);
      const coordStr = args.x !== undefined && args.y !== undefined ? `在坐标 (${args.x}, ${args.y}) ` : '';
      return {
        content: `🖱️ 已${coordStr}执行鼠标${args.button === 'right' ? '右键' : args.button === 'middle' ? '中键' : '左键'}${args.clickType === 'double' ? '双击' : '点击'}。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `鼠标点击失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopMouseDragTool = defineTool({
  name: 'desktop_mouse_drag',
  description: '按住鼠标左键从起点 (fromX, fromY) 拖拽滑动至终点 (toX, toY)',
  schema: z.object({
    fromX: z.number().describe('拖拽起点横坐标 X'),
    fromY: z.number().describe('拖拽起点纵坐标 Y'),
    toX: z.number().describe('拖拽终点横坐标 X'),
    toY: z.number().describe('拖拽终点纵坐标 Y'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.mouseDrag(args.fromX, args.fromY, args.toX, args.toY);
      return {
        content: `🖱️ 鼠标拖拽完成：从 (${args.fromX}, ${args.fromY}) 拖至 (${args.toX}, ${args.toY})。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `鼠标拖拽失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopMouseScrollTool = defineTool({
  name: 'desktop_mouse_scroll',
  description: '滚动鼠标滚轮（deltaY 为正向下滚动，为负向上滚动；deltaX 为正向右，为负向左）',
  schema: z.object({
    deltaY: z.number().describe('纵向滚动像素距离（正数表示向下滚动，负数表示向上滚动）'),
    deltaX: z.number().optional().default(0).describe('横向滚动像素距离（可选，正数向右，负数向左）'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.mouseScroll(args.deltaY, args.deltaX);
      return {
        content: `🖱️ 滚轮滚动完成：纵向偏移 ${args.deltaY}px${args.deltaX ? `，横向偏移 ${args.deltaX}px` : ''}。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `滚轮滚动失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopKeyboardTypeTool = defineTool({
  name: 'desktop_keyboard_type',
  description: '在当前桌面的活动焦点输入框中键入一段文本文字',
  schema: z.object({
    text: z.string().describe('需要键入的文字内容'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.keyboardType(args.text);
      return {
        content: `⌨️ 文本已成功输入到当前焦点窗口。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `键盘输入失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopKeyboardPressTool = defineTool({
  name: 'desktop_keyboard_press',
  description: '按下指定按键或全局系统组合快捷键（支持 Return, Escape, Tab, Space, Backspace, Delete, Up, Down, Left, Right，以及 cmd+c, cmd+v, cmd+a, cmd+s, ctrl+c, alt+tab 等）',
  schema: z.object({
    key: z.string().min(1).describe('按键名或组合键，如 Return, Escape, Tab, cmd+c, cmd+v, alt+tab'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.keyboardPress(args.key);
      return {
        content: `⌨️ 已成功按下快捷键: [${args.key}]。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `按键操作失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopWindowListTool = defineTool({
  name: 'desktop_window_list',
  description: '列出当前桌面操作系统中正在运行的前台可见应用程序与窗口名称列表',
  schema: z.object({}),
  run: async () => {
    try {
      const desktop = DesktopController.getInstance();
      const list = await desktop.listWindows();
      const lines = list.map((w, i) => `${i + 1}. **${w.name}**${w.title ? ` - "${w.title}"` : ''}`);
      return {
        content: `🪟 当前可见运行应用与窗口清单 (${list.length} 个):\n\n${lines.join('\n') || '（未检测到可见窗口）'}`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `获取窗口列表失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

export const desktopWindowFocusTool = defineTool({
  name: 'desktop_window_focus',
  description: '根据应用程序名称将指定的窗口置顶并激活为前台焦点（例如 "Google Chrome"、"Terminal"、"Finder"、"WeChat"）',
  schema: z.object({
    appName: z.string().min(1).describe('要激活的前台应用名称（可参考 desktop_window_list 输出的名字）'),
  }),
  run: async (args) => {
    try {
      const desktop = DesktopController.getInstance();
      await desktop.focusWindow(args.appName);
      return {
        content: `🪟 已将应用 [${args.appName}] 激活置顶为前台焦点窗口。`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `激活应用窗口失败: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
