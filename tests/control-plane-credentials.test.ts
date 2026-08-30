import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BotCredentialStore } from '../src/control-plane/index.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hap-control-creds-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('BotCredentialStore', () => {
  it('writes account credentials with restricted permissions', () => {
    const store = new BotCredentialStore(tempDir());
    store.write('bot-a', { token: 'secret' });

    if (process.platform !== 'win32') {
      expect(statSync(store.pathForTest('bot-a')).mode & 0o777).toBe(0o600);
    }
    expect(store.summary('bot-a')).toEqual({ configured: true, fields: ['token'] });
  });

  it('rejects path traversal account ids', () => {
    expect(() => new BotCredentialStore(tempDir()).write('../x', { token: 'x' })).toThrow();
  });

  it('never exposes secret values in summaries', () => {
    const store = new BotCredentialStore(tempDir());
    store.write('bot-a', { appId: 'id', appSecret: 'secret' });

    expect(JSON.stringify(store.summary('bot-a'))).not.toContain('secret');
  });
});
