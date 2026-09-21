import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_NAMES, TOOL_PROFILES } from '../src/config/defaults.js';
import { builtinTools } from '../src/tools/builtin/index.js';
import {
  desktopScreenshotTool,
  desktopScreenSizeTool,
  desktopMouseMoveTool,
  desktopMouseClickTool,
  desktopMouseDragTool,
  desktopMouseScrollTool,
  desktopKeyboardTypeTool,
  desktopKeyboardPressTool,
  desktopWindowListTool,
  desktopWindowFocusTool,
} from '../src/tools/builtin/desktop-tools.js';
import { DesktopController } from '../src/tools/desktop/desktop-controller.js';

describe('桌面操控工具集 (Desktop Control Tools)', () => {
  const desktopToolNames = [
    'desktop_screenshot',
    'desktop_screen_size',
    'desktop_mouse_move',
    'desktop_mouse_click',
    'desktop_mouse_drag',
    'desktop_mouse_scroll',
    'desktop_keyboard_type',
    'desktop_keyboard_press',
    'desktop_window_list',
    'desktop_window_focus',
  ];

  it('10 个桌面工具全部注册在 BUILTIN_TOOL_NAMES 与 builtinTools() 中', () => {
    const builtins = builtinTools();
    for (const name of desktopToolNames) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
      expect(builtins.some((t) => t.definition.name === name)).toBe(true);
    }
  });

  it('已全部纳入 full 工具档位', () => {
    for (const name of desktopToolNames) {
      expect(TOOL_PROFILES.full).toContain(name);
    }
  });

  it('各工具具备完备的 schema 校验与参数定义', () => {
    // desktop_mouse_move
    expect(desktopMouseMoveTool.definition.name).toBe('desktop_mouse_move');
    expect(desktopMouseMoveTool.validate?.({ x: 100, y: 200 }).ok).toBe(true);
    expect(desktopMouseMoveTool.validate?.({ x: 'invalid' as any, y: 200 }).ok).toBe(false);

    // desktop_mouse_click
    expect(desktopMouseClickTool.definition.name).toBe('desktop_mouse_click');
    expect(desktopMouseClickTool.validate?.({ x: 50, y: 50, button: 'left', clickType: 'single' }).ok).toBe(true);
    expect(desktopMouseClickTool.validate?.({ button: 'invalid_btn' as any }).ok).toBe(false);

    // desktop_mouse_drag
    expect(desktopMouseDragTool.definition.name).toBe('desktop_mouse_drag');
    expect(desktopMouseDragTool.validate?.({ fromX: 0, fromY: 0, toX: 100, toY: 100 }).ok).toBe(true);
    expect(desktopMouseDragTool.validate?.({ fromX: 0 }).ok).toBe(false);

    // desktop_mouse_scroll
    expect(desktopMouseScrollTool.definition.name).toBe('desktop_mouse_scroll');
    expect(desktopMouseScrollTool.validate?.({ deltaY: 100 }).ok).toBe(true);

    // desktop_keyboard_type
    expect(desktopKeyboardTypeTool.definition.name).toBe('desktop_keyboard_type');
    expect(desktopKeyboardTypeTool.validate?.({ text: 'Hello World' }).ok).toBe(true);

    // desktop_keyboard_press
    expect(desktopKeyboardPressTool.definition.name).toBe('desktop_keyboard_press');
    expect(desktopKeyboardPressTool.validate?.({ key: 'cmd+c' }).ok).toBe(true);
    expect(desktopKeyboardPressTool.validate?.({ key: '' }).ok).toBe(false);

    // desktop_window_focus
    expect(desktopWindowFocusTool.definition.name).toBe('desktop_window_focus');
    expect(desktopWindowFocusTool.validate?.({ appName: 'Finder' }).ok).toBe(true);
    expect(desktopWindowFocusTool.validate?.({ appName: '' }).ok).toBe(false);

    // desktop_screenshot & desktop_screen_size & desktop_window_list
    expect(desktopScreenshotTool.definition.name).toBe('desktop_screenshot');
    expect(desktopScreenSizeTool.definition.name).toBe('desktop_screen_size');
    expect(desktopWindowListTool.definition.name).toBe('desktop_window_list');
  });

  it('DesktopController 单例与获取屏幕信息与窗口列表正常', async () => {
    const controller = DesktopController.getInstance();
    expect(controller).toBeDefined();
    expect(DesktopController.getInstance()).toBe(controller);

    const info = await controller.getScreenInfo();
    expect(info.width).toBeGreaterThan(0);
    expect(info.height).toBeGreaterThan(0);
    expect(typeof info.mouseX).toBe('number');
    expect(typeof info.mouseY).toBe('number');

    const windows = await controller.listWindows();
    expect(Array.isArray(windows)).toBe(true);
  });

  const dummyCtx: any = {
    taskId: 'desktop-test-task',
    agent: { id: 'automator' },
    stepIndex: 1,
    workingDirectory: process.cwd(),
    environment: {},
    abortSignal: new AbortController().signal,
  };

  it('desktop_screen_size 工具调用成功返回屏幕参数', async () => {
    const res = await desktopScreenSizeTool.run({}, dummyCtx);
    expect(res.isError).toBe(false);
    expect(res.content).toContain('当前桌面主显示器规格');
    expect(res.content).toContain('宽度 (Width)');
  });

  it('desktop_window_list 工具调用成功返回窗口信息', async () => {
    const res = await desktopWindowListTool.run({}, dummyCtx);
    expect(res.isError).toBe(false);
    expect(res.content).toContain('当前可见运行应用与窗口清单');
  });
});
