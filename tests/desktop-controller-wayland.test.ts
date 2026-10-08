import { describe, expect, it } from 'vitest';
import { DesktopController } from '../src/tools/desktop/desktop-controller.js';

describe('DesktopController 跨平台与 Wayland 适配', () => {
  it('正确识别 Wayland 会话与环境变量', () => {
    const controller = DesktopController.getInstance();

    const origPlatform = process.platform;
    const origWayland = process.env.WAYLAND_DISPLAY;
    const origSession = process.env.XDG_SESSION_TYPE;

    try {
      if (process.platform === 'linux') {
        process.env.WAYLAND_DISPLAY = 'wayland-0';
        expect(controller.isWayland()).toBe(true);

        delete process.env.WAYLAND_DISPLAY;
        process.env.XDG_SESSION_TYPE = 'wayland';
        expect(controller.isWayland()).toBe(true);

        process.env.XDG_SESSION_TYPE = 'x11';
        expect(controller.isWayland()).toBe(false);
      } else {
        expect(controller.isWayland()).toBe(false);
      }
    } finally {
      if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
      else delete process.env.WAYLAND_DISPLAY;

      if (origSession !== undefined) process.env.XDG_SESSION_TYPE = origSession;
      else delete process.env.XDG_SESSION_TYPE;
    }
  });
});
