import { describe, expect, it } from 'vitest';
import { IlinkApiClient, validateIlinkBaseUrl } from '../src/channels/wechat/ilink/index.js';

class FetchMock {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  response: unknown = { qrcode: 'opaque', qrcode_img_content: 'https://example.test/qr' };

  fetch = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(this.response), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  lastHeaders(): Record<string, string> {
    return Object.fromEntries(new Headers(this.calls.at(-1)?.init.headers).entries());
  }

  lastBody(): unknown {
    const body = this.calls.at(-1)?.init.body;
    return typeof body === 'string' ? JSON.parse(body) : undefined;
  }
}

describe('IlinkApiClient', () => {
  it('accepts omitted success codes in lifecycle and message responses', async () => {
    const mock = new FetchMock();
    mock.response = {};
    const client = new IlinkApiClient({ fetch: mock.fetch, token: 'token' });
    await expect(client.notifyStart()).resolves.toBeUndefined();
    await expect(client.notifyStop()).resolves.toBeUndefined();
    await expect(client.sendText({ toUserId: 'user', contextToken: 'ctx', text: 'hello' })).resolves.toBeUndefined();
  });

  it('reports session expiry even when the server omits ret', async () => {
    const mock = new FetchMock();
    mock.response = { errcode: -14, errmsg: 'session timeout' };
    const client = new IlinkApiClient({ fetch: mock.fetch, token: 'token' });
    await expect(client.notifyStart()).rejects.toThrow(/ILINK_SESSION_EXPIRED/);
    await expect(client.getUpdates('cursor')).rejects.toThrow(/ILINK_SESSION_EXPIRED/);
  });

  it('sends required client headers without bearer before login', async () => {
    const mock = new FetchMock();
    const client = new IlinkApiClient({ fetch: mock.fetch, localTokens: ['a', 'b'] });

    await client.createQr();

    expect(mock.calls.at(-1)?.url).toContain('/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(mock.lastHeaders()).toMatchObject({
      'authorizationtype': 'ilink_bot_token',
      'ilink-app-id': 'bot',
    });
    expect(mock.lastHeaders().authorization).toBeUndefined();
    expect(Buffer.from(mock.lastHeaders()['x-wechat-uin']!, 'base64').toString()).toMatch(/^\d+$/);
    expect(mock.lastBody()).toEqual({ local_token_list: ['a', 'b'] });
  });

  it('adds bearer only after login', async () => {
    const mock = new FetchMock();
    mock.response = { ret: 0, msgs: [], get_updates_buf: 'next' };
    const client = new IlinkApiClient({ fetch: mock.fetch, token: 'secret-token' });

    await client.getUpdates('');

    expect(mock.lastHeaders().authorization).toBe('Bearer secret-token');
  });

  it('rejects non-HTTPS and non-Weixin redirect hosts', () => {
    expect(() => validateIlinkBaseUrl('http://127.0.0.1:3000')).toThrow(/ILINK_BASEURL/);
    expect(() => validateIlinkBaseUrl('https://evil.example')).toThrow(/ILINK_BASEURL/);
    expect(validateIlinkBaseUrl('https://ilinkai.weixin.qq.com').hostname).toBe('ilinkai.weixin.qq.com');
    expect(validateIlinkBaseUrl('ilinkai.weixin.qq.com').hostname).toBe('ilinkai.weixin.qq.com');
  });

  it('uses context token when sending text messages', async () => {
    const mock = new FetchMock();
    mock.response = { ret: 0, errmsg: '' };
    const client = new IlinkApiClient({ fetch: mock.fetch, token: 'secret-token' });

    await client.sendText({ toUserId: 'user-a', contextToken: 'ctx-a', text: 'hello' });

    expect(mock.calls.at(-1)?.url).toContain('/ilink/bot/sendmessage');
    expect(mock.lastBody()).toEqual({
      msg: {
        from_user_id: '',
        to_user_id: 'user-a',
        client_id: expect.any(String),
        message_type: 2,
        message_state: 2,
        context_token: 'ctx-a',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      },
    });
  });
});
