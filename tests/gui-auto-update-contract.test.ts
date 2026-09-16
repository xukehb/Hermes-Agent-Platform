import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const main = readFileSync(resolve(root, 'src/gui/main.ts'), 'utf8');
const preload = readFileSync(resolve(root, 'src/gui/renderer/preload.cjs'), 'utf8');
const html = readFileSync(resolve(root, 'src/gui/renderer/index.html'), 'utf8');
const renderer = readFileSync(resolve(root, 'src/gui/renderer/app.js'), 'utf8');
const styles = readFileSync(resolve(root, 'src/gui/renderer/styles.css'), 'utf8');

describe('desktop update IPC contract', () => {
  it('loads the CommonJS electron-updater package through its default export', () => {
    expect(main).toContain("import electronUpdater from 'electron-updater'");
    expect(main).toContain('const { autoUpdater } = electronUpdater');
    expect(main).not.toContain("import { autoUpdater } from 'electron-updater'");
  });

  it('exposes state, download, install, and event subscription through preload', () => {
    expect(preload).toContain("getUpdateState: () => call('gui:update:getState')");
    expect(preload).toContain("downloadUpdate: () => call('gui:update:download')");
    expect(preload).toContain("installUpdate: () => call('gui:update:install')");
    expect(preload).toContain("ipcRenderer.on('gui:update:state', listener)");
    expect(preload).toContain("ipcRenderer.removeListener('gui:update:state', listener)");
  });

  it('registers updater IPC and checks once after renderer load', () => {
    expect(main).toContain("ipcMain.handle('gui:update:getState'");
    expect(main).toContain("ipcMain.handle('gui:update:download'");
    expect(main).toContain("ipcMain.handle('gui:update:install'");
    expect(main).toContain("webContents.send('gui:update:state'");
    expect(main).toContain("webContents.once('did-finish-load'");
    expect(main).toContain('checkOnStartup()');
  });
});

describe('desktop update dialog contract', () => {
  it('provides stable regions for versions, notes, progress, errors, and actions', () => {
    expect(html).toContain('id="desktopUpdateDialog"');
    expect(html).toContain('id="desktopUpdateCurrentVersion"');
    expect(html).toContain('id="desktopUpdateNewVersion"');
    expect(html).toContain('id="desktopUpdateNotes"');
    expect(html).toContain('id="desktopUpdateProgress"');
    expect(html).toContain('id="desktopUpdateError"');
    expect(html).toContain('id="desktopUpdateDownloadBtn"');
    expect(html).toContain('id="desktopUpdateInstallBtn"');
    expect(styles).toContain('.desktop-update-dialog');
  });

  it('subscribes before fetching state and wires update actions', () => {
    const subscribeAt = renderer.indexOf('window.hap.onUpdateState');
    const fetchAt = renderer.indexOf('window.hap.getUpdateState');
    expect(subscribeAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(subscribeAt);
    expect(renderer).toContain('window.hap.downloadUpdate()');
    expect(renderer).toContain('window.hap.installUpdate()');
    expect(renderer).toContain("state.status === 'available'");
    expect(renderer).toContain("state.status === 'downloading'");
    expect(renderer).toContain("state.status === 'downloaded'");
    expect(renderer).toContain("state.status === 'error'");
  });
});
