import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };

  it.each(['gui', 'gui:dev'])('%s rebuilds native modules before Electron starts', (scriptName) => {
    const script = packageJson.scripts?.[scriptName] ?? '';

    expect(script).toMatch(/npm run rebuild:electron.*electron dist\/src\/gui\/main\.js/);
  });

  it('forces a source rebuild when switching native modules back to Node.js', () => {
    expect(packageJson.scripts?.['rebuild:node']).toContain('--build-from-source');
  });
});
