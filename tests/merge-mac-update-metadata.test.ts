import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

describe('macOS updater metadata merge', () => {
  it('publishes one manifest containing both architecture-specific ZIP files', () => {
    const root = mkdtempSync(join(tmpdir(), 'hap-mac-update-'));
    const armDir = join(root, 'macos-arm64');
    const x64Dir = join(root, 'macos-x64');
    mkdirSync(armDir);
    mkdirSync(x64Dir);
    writeFileSync(join(armDir, 'latest-mac-macos-arm64.yml'), yaml.dump({
      version: '0.1.4',
      files: [
        { url: 'Hermes-Agent-Platform-0.1.4-macOS-arm64.dmg', sha512: 'arm-dmg', size: 9 },
        { url: 'Hermes-Agent-Platform-0.1.4-macOS-arm64.zip', sha512: 'arm', size: 10 },
      ],
      path: 'Hermes-Agent-Platform-0.1.4-macOS-arm64.zip',
      sha512: 'arm',
      releaseDate: '2026-09-16T00:00:00.000Z',
    }));
    writeFileSync(join(x64Dir, 'latest-mac-macos-x64.yml'), yaml.dump({
      version: '0.1.4',
      files: [
        { url: 'Hermes-Agent-Platform-0.1.4-macOS-x64.dmg', sha512: 'x64-dmg', size: 19 },
        { url: 'Hermes-Agent-Platform-0.1.4-macOS-x64.zip', sha512: 'x64', size: 20 },
      ],
      path: 'Hermes-Agent-Platform-0.1.4-macOS-x64.zip',
      sha512: 'x64',
      releaseDate: '2026-09-16T00:00:00.000Z',
    }));

    execFileSync(process.execPath, ['scripts/merge-mac-update-metadata.mjs', root], { cwd: process.cwd() });

    const merged = yaml.load(readFileSync(join(root, 'latest-mac.yml'), 'utf8')) as {
      version: string;
      files: Array<{ url: string }>;
    };
    expect(merged.version).toBe('0.1.4');
    expect(merged.files.map((file) => file.url).sort()).toEqual([
      'Hermes-Agent-Platform-0.1.4-macOS-arm64.zip',
      'Hermes-Agent-Platform-0.1.4-macOS-x64.zip',
    ]);
  });
});
