import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  build: {
    files: string[];
    win: { icon?: string };
    mac?: { icon?: string };
    linux?: { icon?: string };
  };
};

describe('desktop app icon', () => {
  it('has image assets usable by Windows, macOS and Linux packagers', () => {
    const png = readFileSync(resolve(root, 'build/icon.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));

    const ico = readFileSync(resolve(root, 'build/icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThan(1);

    const icns = readFileSync(resolve(root, 'build/icon.icns'));
    expect(icns.toString('ascii', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  it('uses platform icons and includes the runtime PNG in packaged files', () => {
    expect(pkg.build.win.icon).toBe('build/icon.ico');
    expect(pkg.build.mac?.icon).toBe('build/icon.icns');
    expect(pkg.build.linux?.icon).toBe('build/icons');

    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const icon = readFileSync(resolve(root, `build/icons/${size}x${size}.png`));
      expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(icon.readUInt32BE(16)).toBe(size);
      expect(icon.readUInt32BE(20)).toBe(size);
    }

    expect(pkg.build.files).toContain('dist/**/*');

    const main = readFileSync(resolve(root, 'src/gui/main.ts'), 'utf8');
    const assets = readFileSync(resolve(root, 'src/gui/copy-assets.ts'), 'utf8');
    expect(main).toContain("icon: rendererPath('app-icon.png')");
    expect(assets).toContain("join(process.cwd(), 'build', 'icon.png')");
    expect(assets).toContain("join(target, 'app-icon.png')");
  });
});
