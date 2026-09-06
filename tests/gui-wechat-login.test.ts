import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));

import { GuiService } from '../src/gui/service.js';
import { IlinkApiClient, type IlinkQrStatus } from '../src/channels/wechat/ilink/index.js';

describe('GUI WeChat QR lifecycle', () => {
  let root: string;
  let service: GuiService;
  let status: (value: IlinkQrStatus) => void;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hap-wx-gui-'));
    const config = join(root, 'config.toml');
    writeFileSync(config, `
default_agent = "helper"
[paths]
data_dir = "${root}/data"
[agents.defaults]
workspace_root = "${root}/workspaces"
agent_dir_root = "${root}/agents"
[agents.entries.helper]
model = "deepseek/deepseek-chat"
[channels.telegram]
enabled = true
token_env = "HAP_TEST_UNCONFIGURED_TELEGRAM_TOKEN"
[channels.wechat]
enabled = true
mode = "ilink_bot"
auth_dir = "${root}/auth"
qr_log = false
[channels.wechat.personal]
puppet = "ilink"
ilink_account_id = "bot-local"
`);
    service = new GuiService(config);
    vi.spyOn(IlinkApiClient.prototype, 'createQr').mockResolvedValue({ qrcode: 'qr', qrcodeImageContent: 'https://example.test/qr' });
    vi.spyOn(IlinkApiClient.prototype, 'qrStatus').mockImplementation(() => new Promise((resolve) => { status = resolve; }));
    vi.spyOn(IlinkApiClient.prototype, 'notifyStart').mockResolvedValue();
    vi.spyOn(IlinkApiClient.prototype, 'notifyStop').mockResolvedValue();
    vi.spyOn(IlinkApiClient.prototype, 'getUpdates').mockResolvedValue({ ret: 0, cursor: '', messages: [] });
  });

  afterEach(async () => {
    await service?.stopWeChatService();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('shows QR without starting unrelated channels and persists a confirmed login', async () => {
    await service.startWeChatService();
    expect(await service.getWeChatConfig()).toMatchObject({ running: true, status: 'waiting_qr', qrCodeText: 'https://example.test/qr' });
    status({ status: 'confirmed', bot_token: 'test-token', ilink_bot_id: 'remote-bot-id', baseurl: 'https://ilinkai.weixin.qq.com' });
    await vi.waitFor(async () => expect(await service.confirmWeChatLogin()).toMatchObject({ ok: true, status: 'connected' }));
  });

  it('reports an expired QR and can request another QR', async () => {
    await service.startWeChatService();
    status({ status: 'expired' });
    await vi.waitFor(async () => expect(await service.getWeChatConfig()).toMatchObject({ running: false, status: 'error' }));
    expect(await service.refreshWeChatQr()).toMatchObject({ ok: true, qrCodeText: 'https://example.test/qr' });
    expect(await service.getWeChatConfig()).toMatchObject({ running: true, status: 'waiting_qr' });
  });
});
