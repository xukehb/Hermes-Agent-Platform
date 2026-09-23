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

  it('rejects personal wechaty mode if puppet token is not configured', async () => {
    delete process.env.WECHATY_PUPPET_SERVICE_TOKEN;
    await service.saveWeChatConfig({ mode: 'personal', puppet: 'service' });
    const cfg = await service.getWeChatConfig();
    expect(cfg.puppet).toBe('service');
    expect(cfg.puppetTokenConfigured).toBe(false);

    await expect(service.startWeChatService()).rejects.toThrow('未配置凭据环境变量【WECHATY_PUPPET_SERVICE_TOKEN】');
    const errCfg = await service.getWeChatConfig();
    expect(errCfg.status).toBe('error');
    expect(errCfg.error).toContain('桌面视觉代管');
  });

  it('allows saving puppetToken and populates puppetTokenConfigured', async () => {
    await service.saveWeChatConfig({ puppetToken: 'puppet_test_123456' });
    expect(process.env.WECHATY_PUPPET_SERVICE_TOKEN).toBe('puppet_test_123456');
    const cfg = await service.getWeChatConfig();
    expect(cfg.puppetTokenConfigured).toBe(true);
    expect(cfg.puppetToken).toBe('******');
    delete process.env.WECHATY_PUPPET_SERVICE_TOKEN;
  });

  it('defaults personal mode to desktop_vision when puppet is not specified', async () => {
    const configPath = join(root, 'config_dv.toml');
    writeFileSync(configPath, `
default_agent = "helper"
[paths]
data_dir = "${root}/data"
[channels.wechat]
enabled = true
mode = "personal"
`);
    const dvService = new GuiService(configPath);
    const cfg = await dvService.getWeChatConfig();
    expect(cfg.puppet).toBe('desktop_vision');
  });

  it('detects saved credentials, allows logout to clear them, and supports relogin to get fresh QR', async () => {
    // 启动并完成确认
    await service.startWeChatService();
    status({ status: 'confirmed', bot_token: 'test-token', ilink_bot_id: 'remote-bot-id', baseurl: 'https://ilinkai.weixin.qq.com' });
    await vi.waitFor(async () => expect(await service.confirmWeChatLogin()).toMatchObject({ ok: true, status: 'connected' }));

    // 确认已保存凭据
    const loggedInCfg = await service.getWeChatConfig();
    expect(loggedInCfg.hasSavedCredentials).toBe(true);

    // 登出并清除凭据
    const logoutRes = await service.logoutWeChat();
    expect(logoutRes.ok).toBe(true);
    const loggedOutCfg = await service.getWeChatConfig();
    expect(loggedOutCfg.hasSavedCredentials).toBe(false);
    expect(loggedOutCfg.status).toBe('idle');

    // 重新登录 (reloginWeChat) 自动获取新二维码
    const reloginRes = await service.reloginWeChat();
    expect(reloginRes.ok).toBe(true);
    expect(reloginRes.qrCodeText).toBe('https://example.test/qr');
    const freshCfg = await service.getWeChatConfig();
    expect(freshCfg.status).toBe('waiting_qr');
    expect(freshCfg.running).toBe(true);
  });
});

