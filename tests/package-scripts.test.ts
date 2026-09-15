import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    version?: string;
    scripts?: Record<string, string>;
    build?: {
      productName?: string;
      copyright?: string;
      win?: { target?: string[] };
      linux?: { target?: string[]; category?: string; maintainer?: string };
      mac?: { target?: string[] };
    };
  };

  it.each(['gui', 'gui:dev'])('%s rebuilds native modules before Electron starts', (scriptName) => {
    const script = packageJson.scripts?.[scriptName] ?? '';

    expect(script).toMatch(/npm run rebuild:electron.*electron dist\/src\/gui\/main\.js/);
  });

  it('forces a source rebuild when switching native modules back to Node.js', () => {
    expect(packageJson.scripts?.['rebuild:node']).toContain('--build-from-source');
  });

  it('uses the v0.1.3 Hermes product identity', () => {
    expect(packageJson.version).toBe('0.1.3');
    expect(packageJson.build?.productName).toBe('Hermes Agent Platform');
    expect(packageJson.build?.copyright).toContain('Hermes Agent Platform');
  });

  it('provides native packaging commands for every release platform', () => {
    expect(packageJson.scripts?.['dist:win']).toContain('electron-builder --win');
    expect(packageJson.scripts?.['dist:linux']).toContain('electron-builder --linux deb');
    expect(packageJson.scripts?.['dist:mac']).toContain('electron-builder --mac dmg');
  });

  it('configures the required installer targets', () => {
    expect(packageJson.build?.win?.target).toEqual(['nsis', 'portable']);
    expect(packageJson.build?.linux).toMatchObject({
      target: ['deb'],
      category: 'Development',
      maintainer: 'Hermes Agent Platform Team',
    });
    expect(packageJson.build?.mac?.target).toEqual(['dmg']);
  });

  it('publishes native artifacts from a version tag workflow', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'release.yml'),
      'utf8',
    );

    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain('windows-latest');
    expect(workflow).toContain('ubuntu-latest');
    expect(workflow).toContain('macos-15');
    expect(workflow).toContain('macos-13');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('actions/download-artifact@v4');
    expect(workflow).toContain('softprops/action-gh-release@v2');
  });
});
