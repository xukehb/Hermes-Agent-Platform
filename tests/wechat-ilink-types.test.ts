import { describe, expect, it } from 'vitest';
import { parseQrCreation, parseQrStatus, parseUpdateBatch } from '../src/channels/wechat/ilink/index.js';

describe('iLink protocol contracts', () => {
  it.each([
    'wait',
    'scaned',
    'need_verifycode',
    'verify_code_blocked',
    'confirmed',
    'expired',
    'scaned_but_redirect',
    'binded_redirect',
  ])('parses QR state %s', (status) => {
    const fixture = status === 'confirmed'
      ? {
        status,
        bot_token: 'token',
        ilink_bot_id: 'bot-id',
        ilink_user_id: 'user-id',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }
      : status === 'scaned_but_redirect'
        ? { status, redirect_host: 'ilinkai.weixin.qq.com' }
        : { status };
    expect(parseQrStatus(fixture).status).toBe(status);
  });

  it('rejects a confirmed response without token and baseurl', () => {
    expect(() => parseQrStatus({ status: 'confirmed', bot_token: '' })).toThrow(/ILINK_SCHEMA/);
  });

  it('parses QR creation without leaking the opaque QR identifier into errors', () => {
    expect(parseQrCreation({
      qrcode: 'opaque-id',
      qrcode_img_content: 'https://example.test/qr',
    })).toEqual({
      qrcode: 'opaque-id',
      qrcodeImageContent: 'https://example.test/qr',
    });
  });

  it('parses update batches with text and context token', () => {
    const batch = parseUpdateBatch({
      ret: 0,
      get_updates_buf: 'cursor-2',
      longpolling_timeout_ms: 35000,
      msgs: [{
        message_id: 100,
        from_user_id: 'user-a',
        to_user_id: 'bot-a',
        create_time_ms: 1788020000000,
        context_token: 'ctx-a',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      }],
    });

    expect(batch.cursor).toBe('cursor-2');
    expect(batch.messages[0]?.text).toBe('hello');
    expect(batch.messages[0]?.contextToken).toBe('ctx-a');
  });
});
