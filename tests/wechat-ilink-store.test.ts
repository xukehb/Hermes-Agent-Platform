import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IlinkAccountStore } from '../src/channels/wechat/ilink/index.js';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hap-ilink-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('IlinkAccountStore', () => {
  it('isolates context tokens by account and peer', () => {
    const root = tempRoot();
    new IlinkAccountStore(root, 'bot-a').putContext('peer', 'ctx-a');
    new IlinkAccountStore(root, 'bot-b').putContext('peer', 'ctx-b');

    expect(new IlinkAccountStore(root, 'bot-a').contextFor('peer')).toBe('ctx-a');
    expect(new IlinkAccountStore(root, 'bot-b').contextFor('peer')).toBe('ctx-b');
  });

  it('quarantines malformed state instead of treating it as logged out', () => {
    const root = tempRoot();
    const accountPath = join(root, 'accounts', 'bot-a', 'account.json');
    mkdirSync(dirname(accountPath), { recursive: true });
    writeFileSync(accountPath, '{bad', 'utf8');

    expect(() => new IlinkAccountStore(root, 'bot-a').loadAccount()).toThrow(/ILINK_STATE_CORRUPT/);
    expect(readdirSync(dirname(accountPath))).toContainEqual(expect.stringMatching(/account\.json\.corrupt/));
  });

  it('persists account and sync cursor with restricted permissions', () => {
    const root = tempRoot();
    const store = new IlinkAccountStore(root, 'bot-a');
    store.saveAccount({
      botToken: 'secret',
      ilinkBotId: 'bot-a',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      loginUserId: 'user-a',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    store.saveCursor('cursor-1');

    expect(new IlinkAccountStore(root, 'bot-a').loadAccount()?.ilinkBotId).toBe('bot-a');
    expect(new IlinkAccountStore(root, 'bot-a').loadCursor()).toBe('cursor-1');
  });

  it('deduplicates inbound messages per account', () => {
    const root = tempRoot();
    const store = new IlinkAccountStore(root, 'bot-a', { now: () => 1_000 });

    expect(store.markInboundSeen('msg-1')).toBe(true);
    expect(store.markInboundSeen('msg-1')).toBe(false);
  });
});
