import { describe, expect, it, vi } from 'vitest';
import {
  DesktopUpdateController,
  type DesktopUpdaterAdapter,
  type DesktopUpdaterEvents,
} from '../src/gui/desktop-updater.js';

class FakeUpdater implements DesktopUpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  private readonly listeners = new Map<keyof DesktopUpdaterEvents, Array<(value: never) => void>>();
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();

  on<K extends keyof DesktopUpdaterEvents>(event: K, listener: (value: DesktopUpdaterEvents[K]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (value: never) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  emit<K extends keyof DesktopUpdaterEvents>(event: K, value: DesktopUpdaterEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

describe('DesktopUpdateController', () => {
  it('checks exactly once after packaged startup and disables automatic download/install', async () => {
    const updater = new FakeUpdater();
    const controller = new DesktopUpdateController({ updater, isPackaged: true, currentVersion: '0.1.3' });

    await controller.checkOnStartup();
    await controller.checkOnStartup();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({ status: 'checking', currentVersion: '0.1.3' });
  });

  it('does not contact GitHub from an unpackaged development run', async () => {
    const updater = new FakeUpdater();
    const controller = new DesktopUpdateController({ updater, isPackaged: false, currentVersion: '0.1.3' });

    await controller.checkOnStartup();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: 'idle', currentVersion: '0.1.3' });
  });

  it('manually triggers checkForUpdates when requested', async () => {
    const updater = new FakeUpdater();
    const controller = new DesktopUpdateController({ updater, isPackaged: true, currentVersion: '0.1.5' });

    await controller.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('maps update availability and release notes to serializable state', () => {
    const updater = new FakeUpdater();
    const controller = new DesktopUpdateController({ updater, isPackaged: true, currentVersion: '0.1.3' });

    updater.emit('update-available', {
      version: '0.1.4',
      releaseDate: '2026-09-16T08:00:00.000Z',
      releaseNotes: [{ version: '0.1.4', note: '一键更新' }],
    });

    expect(controller.getState()).toEqual({
      status: 'available',
      currentVersion: '0.1.3',
      version: '0.1.4',
      releaseDate: '2026-09-16T08:00:00.000Z',
      releaseNotes: '一键更新',
    });
  });

  it('downloads once, reports bounded progress, and enters downloaded state', async () => {
    const updater = new FakeUpdater();
    const controller = new DesktopUpdateController({ updater, isPackaged: true, currentVersion: '0.1.3' });
    updater.emit('update-available', { version: '0.1.4', releaseNotes: 'Changes' });

    await Promise.all([controller.download(), controller.download()]);
    updater.emit('download-progress', {
      percent: 107.4,
      bytesPerSecond: 2048,
      transferred: 80,
      total: 100,
    });
    updater.emit('update-downloaded', { version: '0.1.4', releaseNotes: 'Changes' });

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      status: 'downloaded',
      currentVersion: '0.1.3',
      version: '0.1.4',
    });
  });

  it('publishes retryable download errors without losing the available version', async () => {
    const updater = new FakeUpdater();
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network unavailable'));
    const controller = new DesktopUpdateController({ updater, isPackaged: true, currentVersion: '0.1.3' });
    updater.emit('update-available', { version: '0.1.4', releaseNotes: null });

    await expect(controller.download()).rejects.toThrow('network unavailable');

    expect(controller.getState()).toEqual({
      status: 'error',
      currentVersion: '0.1.3',
      version: '0.1.4',
      message: 'network unavailable',
      retryable: true,
    });
  });

  it('delegates installation only after the update has downloaded', () => {
    const updater = new FakeUpdater();
    const controller = new DesktopUpdateController({ updater, isPackaged: true, currentVersion: '0.1.3' });

    expect(() => controller.quitAndInstall()).toThrow('更新尚未下载完成');
    updater.emit('update-downloaded', { version: '0.1.4', releaseNotes: null });
    controller.quitAndInstall();

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
