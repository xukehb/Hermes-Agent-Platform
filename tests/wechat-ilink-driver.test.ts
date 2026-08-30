import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeIlinkPersonalDriver,
  type IlinkApiClient,
  type IlinkQrCreation,
  type IlinkQrStatus,
  type IlinkUpdateBatch,
} from '../src/channels/wechat/ilink/index.js';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hap-ilink-driver-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeApi implements Pick<IlinkApiClient, 'createQr' | 'qrStatus' | 'notifyStart' | 'notifyStop' | 'getUpdates' | 'sendText'> {
  readonly sent: Array<{ toUserId: string; contextToken: string; text: string }> = [];
  qr: IlinkQrCreation = { qrcode: 'qr-1', qrcodeImageContent: 'qr-url-1' };
  statuses: IlinkQrStatus[] = [{
    status: 'confirmed',
    bot_token: 'token-bot-a',
    ilink_bot_id: 'bot-a',
    ilink_user_id: 'user-a',
    baseurl: 'https://ilinkai.weixin.qq.com',
  }];
  updates: IlinkUpdateBatch[] = [];
  started = false;

  async createQr(): Promise<IlinkQrCreation> {
    return this.qr;
  }

  async qrStatus(): Promise<IlinkQrStatus> {
    return this.statuses.shift() ?? { status: 'expired' };
  }

  async notifyStart(): Promise<void> {
    this.started = true;
  }

  async notifyStop(): Promise<void> {
    this.started = false;
  }

  async getUpdates(): Promise<IlinkUpdateBatch> {
    return this.updates.shift() ?? { ret: 0, cursor: '', messages: [] };
  }

  async sendText(input: { toUserId: string; contextToken: string; text: string }): Promise<void> {
    this.sent.push(input);
  }
}

describe('NativeIlinkPersonalDriver', () => {
  it('emits QR and login, then starts notifications', async () => {
    const api = new FakeApi();
    const driver = new NativeIlinkPersonalDriver({ accountId: 'bot-a', rootDir: tempRoot(), apiFactory: () => api, pollIntervalMs: 0 });
    const qrs: string[] = [];
    const logins: string[] = [];
    driver.onQrCode = (qr) => qrs.push(qr);
    driver.onLogin = (user) => logins.push(user.id);

    await driver.start();

    expect(qrs).toEqual(['qr-url-1']);
    expect(logins).toEqual(['bot-a']);
    expect(api.started).toBe(true);
  });

  it('dispatches inbound text and reuses its context token for replies', async () => {
    const api = new FakeApi();
    api.updates.push({
      ret: 0,
      cursor: 'cursor-2',
      messages: [{
        id: 'msg-1',
        fromUserId: 'user-a',
        createdAt: '2026-08-30T00:00:00.000Z',
        text: 'ping',
        contextToken: 'ctx-a',
      }],
    });
    const driver = new NativeIlinkPersonalDriver({ accountId: 'bot-a', rootDir: tempRoot(), apiFactory: () => api, pollIntervalMs: 0 });
    const messages: string[] = [];
    driver.onMessage = (message) => {
      messages.push(message.text);
    };

    await driver.start();
    await driver.pollOnceForTest();
    await driver.sendMessage('user-a', 'pong');

    expect(messages).toEqual(['ping']);
    expect(api.sent).toEqual([{ toUserId: 'user-a', contextToken: 'ctx-a', text: 'pong' }]);
  });
});
