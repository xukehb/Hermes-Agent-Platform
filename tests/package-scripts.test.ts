import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    version?: string;
    author?: string;
    desktopName?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    build?: {
      productName?: string;
      copyright?: string;
      publish?: Array<{ provider?: string; owner?: string; repo?: string }>;
      win?: { target?: string[] };
      linux?: {
        target?: string[];
        category?: string;
        maintainer?: string;
        syncDesktopName?: boolean;
      };
      mac?: { target?: string[] };
    };
  };

  it.each(['gui', 'gui:dev'])('%s rebuilds native modules before Electron starts', (scriptName) => {
    const script = packageJson.scripts?.[scriptName] ?? '';

    expect(script).toMatch(/npm run rebuild:electron.*electron dist\/src\/gui\/main\.js/);
  });

  it('forces a source rebuild when switching native modules back to Node.js', () => {
    expect(packageJson.scripts?.['rebuild:node']).toContain('--build-from-source');
    const nativeHelper = readFileSync(
      join(process.cwd(), 'scripts', 'ensure-native-addons.ts'),
      'utf8',
    );
    expect(nativeHelper).toContain('process.versions.modules');
    expect(nativeHelper).toContain("require('electron')");
    expect(nativeHelper).not.toContain("'dist', 'electron'");
    expect(nativeHelper).not.toContain("'node-v137-linux-x64'");
  });

  it('uses the v0.1.10 Hermes product identity and GitHub updater', () => {
    expect(packageJson.version).toBe('0.1.10');
    expect(packageJson.author).toBe('Hermes Agent Platform Team');
    expect(packageJson.desktopName).toBe('hermes-agent-platform.desktop');
    expect(packageJson.build?.productName).toBe('Hermes Agent Platform');
    expect(packageJson.build?.copyright).toContain('Hermes Agent Platform');
    expect(packageJson.dependencies?.['electron-updater']).toBe('6.8.9');
    expect(packageJson.build?.publish).toContainEqual({
      provider: 'github',
      owner: 'xukehb',
      repo: 'Hermes-Agent-Platform',
    });
  });

  it('provides native packaging commands for every release platform', () => {
    expect(packageJson.scripts?.['dist:win']).toContain('electron-builder --win');
    expect(packageJson.scripts?.['dist:linux']).toContain('electron-builder --linux deb');
    expect(packageJson.scripts?.['dist:mac']).toContain('electron-builder --mac --publish never');
    expect(packageJson.scripts?.['dist:mac']).not.toContain('--mac dmg');
    expect(packageJson.scripts?.['dist:win']).toContain('--publish never');
    expect(packageJson.scripts?.['dist:linux']).toContain('--publish never');
    expect(packageJson.scripts?.['dist:mac']).toContain('--publish never');
  });

  it('configures the required installer targets', () => {
    expect(packageJson.build?.win?.target).toEqual(['nsis', 'portable']);
    expect(packageJson.build?.linux).toMatchObject({
      target: ['deb'],
      category: 'Development',
      maintainer: 'Hermes Agent Platform Team',
      syncDesktopName: true,
    });
    expect(packageJson.build?.mac?.target).toEqual(['dmg', 'zip']);
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
    expect(workflow).toContain('macos-15-intel');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('actions/download-artifact@v4');
    expect(workflow).toContain('softprops/action-gh-release@v2');
    expect(workflow).toContain('release/Hermes-Agent-Platform-*.exe');
    expect(workflow).not.toContain('files: release/*.exe');
    expect(workflow).toContain('release/latest*.yml');
    expect(workflow).toContain('release/*.blockmap');
    expect(workflow).toContain('release/*.zip');
    expect(workflow).toContain('Reject legacy artifact names');
    expect(workflow).not.toContain('Hermes Agent Platform v0.1.3');
    expect(workflow.indexOf('Check out release tooling')).toBeLessThan(
      workflow.indexOf('Download installers'),
    );
    expect(workflow).toContain('Clean release directory');
  });

  it('does not expose legacy desktop product names at runtime', () => {
    const runtimeFiles = [
      'src/cli/ip-commands.ts',
      'src/cli/clean-commands.ts',
      'src/cli/host-commands.ts',
      'src/system/ip-lookup.ts',
      'src/web/server.ts',
      'src/gui/main.ts',
      'src/gui/renderer/index.html',
      'src/gui/service.ts',
      'src/tools/builtin/host-tools.ts',
    ];
    const runtimeText = runtimeFiles
      .map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
      .join('\n');

    expect(runtimeText).not.toContain('CodexConnect');
    expect(runtimeText).not.toContain('ChatGPT · HAP Studio');
    expect(runtimeText).toContain('Hermes Agent Platform');
  });
});
