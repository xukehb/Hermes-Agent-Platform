import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IlinkAccountStore,
  IlinkLoginSession,
  type IlinkApiClient,
  type IlinkQrStatus,
  type IlinkQrCreation,
  type LoginState,
} from '../src/channels/wechat/ilink/index.js';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hap-ilink-login-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeApi implements Pick<IlinkApiClient, 'createQr' | 'qrStatus'> {
  statuses: IlinkQrStatus[] = [];
  qr: IlinkQrCreation = { qrcode: 'qr-1', qrcodeImageContent: 'qr-url-1' };

  async createQr(): Promise<IlinkQrCreation> {
    return this.qr;
  }

  async qrStatus(): Promise<IlinkQrStatus> {
    const next = this.statuses.shift();
    if (next === undefined) return { status: 'expired' };
    return next;
  }
}

function confirmed(botId = 'bot-a'): IlinkQrStatus {
  return {
    status: 'confirmed',
    bot_token: 'token-' + botId,
    ilink_bot_id: botId,
    ilink_user_id: 'user-a',
    baseurl: 'https://ilinkai.weixin.qq.com',
  };
}

describe('IlinkLoginSession', () => {
  it('saves the server bot identity under the local account alias', async () => {
    const api = new FakeApi();
    api.statuses.push(confirmed('server-bot-id'));
    const store = new IlinkAccountStore(tempRoot(), 'bot-local');
    const events: LoginState[] = [];
    await new IlinkLoginSession({ api, store, pollIntervalMs: 0, onState: (state) => events.push(state) }).start();
    expect(store.loadAccount()?.ilinkBotId).toBe('server-bot-id');
    expect(events.at(-1)?.phase).toBe('connected');
  });

  it('does not report connected before confirmed credentials are saved', async () => {
    const api = new FakeApi();
    api.statuses.push({ status: 'scaned' }, confirmed('bot-a'));
    const store = new IlinkAccountStore(tempRoot(), 'bot-a');
    const events: LoginState[] = [];
    const login = new IlinkLoginSession({ api, store, pollIntervalMs: 0, onState: (event) => events.push(event) });

    await login.start();

    expect(events.map((event) => event.phase)).toEqual(['qr_ready', 'scanned', 'connected']);
    expect(store.loadAccount()?.botToken).toBe('token-bot-a');
  });

  it('ignores an old poll after refresh', async () => {
    const api = new FakeApi();
    const store = new IlinkAccountStore(tempRoot(), 'bot-a');
    const events: LoginState[] = [];
    const login = new IlinkLoginSession({ api, store, pollIntervalMs: 0, onState: (event) => events.push(event) });
    let finishOld!: (status: IlinkQrStatus) => void;
    let pollingOld!: () => void;
    const oldPollStarted = new Promise<void>((resolve) => { pollingOld = resolve; });
    api.qrStatus = async () => {
      pollingOld();
      return new Promise((resolve) => { finishOld = resolve; });
    };
    const first = login.start();
    await oldPollStarted;

    api.qr = { qrcode: 'qr-2', qrcodeImageContent: 'qr-url-2' };
    api.qrStatus = async () => confirmed('bot-a');
    await login.refresh();
    finishOld(confirmed('old-bot'));
    await first;

    expect(store.loadAccount()?.ilinkBotId).toBe('bot-a');
    expect(events.at(-1)?.phase).toBe('connected');
  });

  it('reports verification-required and accepts numeric codes only', async () => {
    const api = new FakeApi();
    api.statuses.push({ status: 'need_verifycode' });
    const login = new IlinkLoginSession({
      api,
      store: new IlinkAccountStore(tempRoot(), 'bot-a'),
      pollIntervalMs: 0,
      onState: () => undefined,
    });
    await login.start();

    expect(() => login.submitVerification('abcd')).toThrow();
    expect(() => login.submitVerification('123456')).not.toThrow();
  });
});
