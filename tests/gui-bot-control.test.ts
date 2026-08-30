import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BotControlFacade } from '../src/gui/bot-control.js';

function tempFacade(): { facade: BotControlFacade; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hap-gui-bot-control-'));
  const facade = new BotControlFacade({
    dbPath: join(dir, 'control.db'),
    credentialsDir: join(dir, 'credentials'),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
  });
  return {
    facade,
    cleanup: () => {
      facade.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('GUI bot control facade', () => {
  it('stores bot credentials separately and never returns secrets to the renderer', () => {
    const { facade, cleanup } = tempFacade();
    try {
      facade.upsertBot({
        id: 'bot-telegram',
        name: 'Ops Telegram',
        platform: 'telegram',
        enabled: true,
        boundServerId: 'srv-a',
        defaultAgent: 'ops',
        config: {
          token: '123456:telegram-secret',
          adminUsers: ['1001'],
        },
      });

      const listed = facade.listBots();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.status).toBe('stopped');
      expect(listed[0]?.config.token).toBeUndefined();
      expect(listed[0]?.config.adminUsers).toEqual(['1001']);
      expect(listed[0]?.config).toEqual(expect.objectContaining({ credentialsConfigured: true }));
      expect(facade.readCredentialsForTest('bot-telegram')).toEqual({ token: '123456:telegram-secret' });
    } finally {
      cleanup();
    }
  });

  it('enforces one server bound to one bot and one bot bound to one server', () => {
    const { facade, cleanup } = tempFacade();
    try {
      facade.upsertBot({
        id: 'bot-one',
        name: 'One',
        platform: 'telegram',
        enabled: false,
        boundServerId: 'srv-a',
        defaultAgent: 'ops',
        config: { token: 'secret-one' },
      });

      expect(() => facade.upsertBot({
        id: 'bot-two',
        name: 'Two',
        platform: 'feishu',
        enabled: false,
        boundServerId: 'srv-a',
        defaultAgent: 'ops',
        config: { appId: 'cli_x', appSecret: 'secret-two' },
      })).toThrow(/BINDING_CONFLICT/);

      expect(() => facade.upsertBot({
        id: 'bot-one',
        name: 'One moved',
        platform: 'telegram',
        enabled: false,
        boundServerId: 'srv-b',
        defaultAgent: 'ops',
        config: { token: 'secret-one' },
      })).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('maps WeChat GUI bots to native iLink control accounts', () => {
    const { facade, cleanup } = tempFacade();
    try {
      facade.upsertBot({
        id: 'bot-wechat',
        name: '个人微信',
        platform: 'wechat',
        enabled: true,
        boundServerId: 'local',
        defaultAgent: 'ops',
        config: { puppetToken: 'ilink-local-token' },
      });

      const bot = facade.listBots()[0];
      expect(bot?.platform).toBe('wechat');
      expect(bot?.config.puppetToken).toBeUndefined();
      expect(facade.accountForTest('bot-wechat')?.platform).toBe('wechat_ilink');
      expect(facade.accountForTest('bot-wechat')?.transport).toBe('ilink');
    } finally {
      cleanup();
    }
  });

  it('exposes startable runtime accounts with credentials and bindings for enabled bots only', () => {
    const { facade, cleanup } = tempFacade();
    try {
      facade.upsertBot({
        id: 'bot-enabled',
        name: 'Enabled',
        platform: 'telegram',
        enabled: true,
        boundServerId: 'srv-a',
        defaultAgent: 'ops',
        config: { token: 'secret-enabled' },
      });
      facade.upsertBot({
        id: 'bot-disabled',
        name: 'Disabled',
        platform: 'telegram',
        enabled: false,
        boundServerId: 'srv-b',
        defaultAgent: 'ops',
        config: { token: 'secret-disabled' },
      });

      const runtimes = facade.runtimeBots('telegram');
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.account.id).toBe('bot-enabled');
      expect(runtimes[0]?.binding.serverId).toBe('srv-a');
      expect(runtimes[0]?.credentials.token).toBe('secret-enabled');
    } finally {
      cleanup();
    }
  });
});
