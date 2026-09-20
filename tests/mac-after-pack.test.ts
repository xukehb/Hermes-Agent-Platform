import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error CommonJS script without type definitions
import afterPack from '../scripts/after-pack.cjs';

describe('macOS afterPack script', () => {
  it('skips processing when platform is not darwin', async () => {
    const context = {
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'Hermes Agent Platform' } },
      appOutDir: '/tmp/test-win',
    };
    await expect(afterPack(context as never)).resolves.toBeUndefined();
  });

  it('handles missing target app directory gracefully', async () => {
    const context = {
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'NonExistentApp' } },
      appOutDir: '/tmp/non-existent-dir',
    };
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(afterPack(context as never)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[afterPack] 找不到目标应用目录')
    );
    consoleSpy.mockRestore();
  });
});
