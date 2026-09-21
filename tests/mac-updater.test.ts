import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findDownloadedMacZip,
  getRunningMacAppPath,
  installMacUpdateInPlace,
  isMacAppWritable,
} from '../src/gui/mac-updater.js';

describe('mac-updater helper', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-updater-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {
      // ignore
    }
  });

  it('locates versioned zip first, then fallback to update.zip', () => {
    const pendingDir = path.join(tempDir, 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    expect(findDownloadedMacZip(tempDir)).toBeNull();

    fs.writeFileSync(path.join(pendingDir, 'update.zip'), 'dummy');
    expect(findDownloadedMacZip(tempDir)).toBe(path.join(pendingDir, 'update.zip'));

    const versionedZip = path.join(
      pendingDir,
      'Hermes-Agent-Platform-0.1.17-macOS-arm64.zip'
    );
    fs.writeFileSync(versionedZip, 'dummy');
    expect(findDownloadedMacZip(tempDir)).toBe(versionedZip);
  });

  it('checks if application path is writable', () => {
    const fakeApp = path.join(tempDir, 'Test.app');
    fs.mkdirSync(fakeApp);
    expect(isMacAppWritable(fakeApp)).toBe(true);

    const nonExistent = path.join('/root/non-existent-dir', 'Test.app');
    expect(isMacAppWritable(nonExistent)).toBe(false);
  });

  it('returns null or matches .app from running path', () => {
    const appPath = getRunningMacAppPath();
    if (appPath) {
      expect(appPath.endsWith('.app')).toBe(true);
    } else {
      expect(appPath).toBeNull();
    }
  });

  it('returns false when target app or zip does not exist', async () => {
    const res = await installMacUpdateInPlace({
      targetAppPath: '/tmp/non-existent/App.app',
      zipPath: '/tmp/non-existent/update.zip',
    });
    expect(res).toBe(false);
  });
});
