import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QQChannel } from '../src/channels/qq.js';
import { ChannelContactStore } from '../src/channels/contacts-store.js';
import type { ChannelHost } from '../src/channels/types.js';

import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('QQChannel (QQ 机器人 / OneBot 协议驱动通道)', () => {
  const testStoreDir = join(tmpdir(), `hap_test_qq_${Date.now()}`);
  const testStorePath = join(testStoreDir, 'qq_contacts.json');

  beforeEach(() => {
    ChannelContactStore.resetInstance();
    if (existsSync(testStoreDir)) {
      rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  const mockHost: ChannelHost = {
    runTask: vi.fn().mockResolvedValue({ text: 'QQ 智能体自动回复：编译检查已通过' }),
    abortSession: vi.fn(),
    status: vi.fn(),
    trace: vi.fn(),
    agentIds: () => ['coder', 'reviewer', 'ops'],
    agentsList: () => [],
    models: () => [],
    projects: () => [],
    clearSession: vi.fn(),
    usageSince: () => [],
  };

  it('处理 OneBot v11 群消息并剥离 CQ:at 码', async () => {
    const store = new ChannelContactStore(testStorePath);
    const channel = new QQChannel({
      host: mockHost,
      contactStore: store,
      config: {
        mode: 'onebot',
        defaultAgent: 'coder',
      },
    });

    const onebotGroupMsg = JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      group_id: 123456789,
      user_id: 987654321,
      sender: {
        nickname: 'QQ开发高手',
        card: '架构组-小明',
      },
      raw_message: '[CQ:at,qq=11223344] @coder 请实现一个高并发限流器',
    });

    const res = await channel.handleOneBotPayload(onebotGroupMsg);
    expect(res).toEqual({ status: 'ok', retcode: 0 });

    const contacts = store.listContacts('qq');
    expect(contacts.length).toBe(1);
    expect(contacts[0]?.id).toBe('qq_group_123456789');
    expect(contacts[0]?.isRoom).toBe(true);
    expect(contacts[0]?.channel).toBe('qq');
  });

  it('处理 OneBot v11 私聊消息并正确记录对话', async () => {
    const store = new ChannelContactStore(testStorePath);
    const channel = new QQChannel({
      host: mockHost,
      contactStore: store,
      config: {
        mode: 'onebot',
        defaultAgent: 'ops',
      },
    });

    const onebotPrivateMsg = JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      user_id: 55667788,
      sender: {
        nickname: 'QQ技术同学',
      },
      raw_message: '请查看服务器负载状态',
    });

    const res = await channel.handleOneBotPayload(onebotPrivateMsg);
    expect(res).toEqual({ status: 'ok', retcode: 0 });

    const contacts = store.listContacts('qq');
    expect(contacts.length).toBe(1);
    expect(contacts[0]?.id).toBe('qq_user_55667788');
    expect(contacts[0]?.isRoom).toBe(false);
    expect(contacts[0]?.name).toBe('QQ技术同学');
  });
});
