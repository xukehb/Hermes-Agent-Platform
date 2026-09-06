import { describe, expect, it } from 'vitest';
import { parseQrCreation, parseQrStatus, parseUpdateBatch } from '../src/channels/wechat/ilink/index.js';

describe('iLink protocol contracts', () => {
  it('parses real getupdates responses without ret', () => {
    expect(parseUpdateBatch({ msgs: [], sync_buf: '', get_updates_buf: 'cursor' }))
      .toMatchObject({ ret: 0, messages: [], cursor: 'cursor' });
  });

  it('preserves text when a batch also contains media or extra text metadata', () => {
    const batch = parseUpdateBatch({ msgs: [
      { message_id: 1, from_user_id: 'user', item_list: [{ type: 2, image_item: {} }] },
      { message_id: 2, from_user_id: 'user', context_token: 'ctx', item_list: [{ type: 1, create_time_ms: 1, text_item: { text: 'hello' } }] },
    ], get_updates_buf: 'next' });
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({ id: '2', text: 'hello', contextToken: 'ctx' });
  });

  it('treats an empty group id from WeChat as a direct message', () => {
    const batch = parseUpdateBatch({
      msgs: [{
        message_id: 3,
        from_user_id: 'user-a',
        group_id: '',
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: '请回复 1' } }],
      }],
      get_updates_buf: 'next',
    });

    expect(batch.messages[0]).toMatchObject({ fromUserId: 'user-a', text: '请回复 1' });
    expect(batch.messages[0]?.groupId).toBeUndefined();
  });

  it('accepts successful QR responses with server metadata', () => {
    expect(parseQrCreation({ ret: 0, qrcode: 'opaque-id', qrcode_img_content: 'https://example.test/qr' }))
      .toEqual({ qrcode: 'opaque-id', qrcodeImageContent: 'https://example.test/qr' });
    expect(parseQrStatus({ ret: 0, status: 'wait', server_metadata: 'ignored' })).toEqual({ status: 'wait' });
  });

  it('rejects failed QR responses even when payload fields are present', () => {
    expect(() => parseQrCreation({ ret: -1, qrcode: 'opaque-id', qrcode_img_content: 'qr' })).toThrow(/ILINK_RET/);
    expect(() => parseQrStatus({ ret: -1, status: 'wait' })).toThrow(/ILINK_RET/);
  });

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
