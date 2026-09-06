import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { GuiService } from '../src/gui/service.js';

describe('Telegram node alert delivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a server id used as the Telegram chat id before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GuiService().testServerBotAlert({
      serverId: '47',
      botConfig: {
        enabled: true,
        agentId: 'ops',
        channel: 'telegram',
        webhookUrl: 'bot-token',
        targetId: '47',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('服务器编号');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains how to establish a Telegram chat when the Bot API reports chat not found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    })));

    const result = await new GuiService().testServerBotAlert({
      serverId: 'server-1',
      botConfig: {
        enabled: true,
        agentId: 'ops',
        channel: 'telegram',
        webhookUrl: 'bot-token',
        targetId: '123456789',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('/start');
    expect(result.message).toContain('Chat ID');
  });
});
