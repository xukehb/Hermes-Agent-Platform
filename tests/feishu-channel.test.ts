import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from '../src/channels/feishu.js';
import { ChannelContactStore } from '../src/channels/contacts-store.js';
import type { ChannelHost, InboundMessage } from '../src/channels/types.js';
import { BotAuthorizationService, ControlPlaneStore } from '../src/control-plane/index.js';

import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('FeishuChannel (飞书自建机器人驱动通道)', () => {
  const testStoreDir = join(tmpdir(), `hap_test_feishu_${Date.now()}`);
  const testStorePath = join(testStoreDir, 'feishu_contacts.json');

  beforeEach(() => {
    ChannelContactStore.resetInstance();
    if (existsSync(testStoreDir)) {
      rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  const mockHost: ChannelHost = {
    runTask: vi.fn().mockResolvedValue({ text: '任务执行完成：飞书智能体已响应' }),
    abortSession: vi.fn(),
    status: vi.fn(),
    trace: vi.fn(),
    clearSession: vi.fn(),
    usageSince: vi.fn().mockReturnValue([]),
    agentIds: () => ['coder', 'reviewer', 'ops'],
    agentsList: () => [],
    models: () => [],
    projects: () => [],
  };

  it('正确响应飞书 URL 校验 Challenge 请求', async () => {
    const store = new ChannelContactStore(testStorePath);
    const channel = new FeishuChannel({
      host: mockHost,
      contactStore: store,
      config: {
        appId: 'cli_test_app',
        verificationToken: 'test_token',
      },
    });

    const challengePayload = JSON.stringify({
      type: 'url_verification',
      token: 'test_token',
      challenge: 'feishu_challenge_token_123456',
    });

    const result = await channel.handleEventPayload(challengePayload);
    expect(result).toEqual({ challenge: 'feishu_challenge_token_123456' });
  });

  it('接收飞书 im.message.receive_v1 消息并调度智能体', async () => {
    const runTaskMock = vi.fn().mockResolvedValue({ text: '已定位代码性能瓶颈' });
    const hostWithTask: ChannelHost = {
      ...mockHost,
      runTask: runTaskMock,
    };

    const store = new ChannelContactStore(testStorePath);
    const channel = new FeishuChannel({
      host: hostWithTask,
      contactStore: store,
      config: {
        appId: 'cli_test_app',
        defaultAgent: 'reviewer',
      },
    });

    const eventPayload = JSON.stringify({
      schema: '2.0',
      header: {
        event_type: 'im.message.receive_v1',
        event_id: 'evt_123',
      },
      event: {
        sender: {
          sender_id: { open_id: 'ou_feishu_dev_001' },
          sender_type: 'user',
        },
        message: {
          message_id: 'om_msg_001',
          chat_id: 'oc_feishu_chat_999',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '请分析该模块性能' }),
        },
      },
    });

    const res = await channel.handleEventPayload(eventPayload);
    expect(res).toEqual({ status: 'ok' });

    // 验证联系人已归档到 ChannelContactStore
    const contacts = store.listContacts('feishu');
    expect(contacts.length).toBe(1);
    expect(contacts[0]?.id).toBe('ou_feishu_dev_001');
    expect(contacts[0]?.channel).toBe('feishu');
  });

  it('启用控制平面后拒绝未配对飞书用户', async () => {
    const runTaskMock = vi.fn().mockResolvedValue({ text: '不应执行' });
    const hostWithTask: ChannelHost = {
      ...mockHost,
      runTask: runTaskMock,
    };
    const db = new ControlPlaneStore(join(testStoreDir, 'control-feishu.sqlite'));
    db.upsertAccount({
      id: 'bot-feishu',
      platform: 'feishu',
      name: 'Ops Feishu',
      enabled: true,
      credentialRef: 'bot-feishu',
      transport: 'webhook',
      defaultAgentId: 'ops',
    });
    db.bind({
      id: 'bind-feishu',
      serverId: 'srv-feishu',
      botAccountId: 'bot-feishu',
      capabilityProfile: 'operate',
      approvalPolicy: 'dangerous_local',
      alertPolicy: {},
    });
    const store = new ChannelContactStore(testStorePath);
    const channel = new FeishuChannel({
      host: hostWithTask,
      contactStore: store,
      config: { appId: 'cli_test_app', defaultAgent: 'ops' },
      control: { botAccountId: 'bot-feishu', authorization: new BotAuthorizationService(db) },
    });

    await channel.handleEventPayload(JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: 'evt_unpaired' },
      event: {
        sender: { sender_id: { open_id: 'ou_unpaired' }, sender_type: 'user' },
        message: {
          message_id: 'om_unpaired',
          chat_id: 'oc_feishu_chat_unpaired',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '查看服务器' }),
        },
      },
    }));

    expect(runTaskMock).not.toHaveBeenCalled();
    db.close();
  });

  it('已配对飞书用户的请求携带绑定服务器上下文', async () => {
    const runTaskMock = vi.fn().mockResolvedValue({ text: '已执行' });
    const hostWithTask: ChannelHost = {
      ...mockHost,
      runTask: runTaskMock,
    };
    const db = new ControlPlaneStore(join(testStoreDir, 'control-feishu-paired.sqlite'));
    db.upsertAccount({
      id: 'bot-feishu2',
      platform: 'feishu',
      name: 'Ops Feishu',
      enabled: true,
      credentialRef: 'bot-feishu2',
      transport: 'webhook',
      defaultAgentId: 'ops',
    });
    db.bind({
      id: 'bind-feishu2',
      serverId: 'srv-feishu-bound',
      botAccountId: 'bot-feishu2',
      capabilityProfile: 'operate',
      approvalPolicy: 'dangerous_local',
      alertPolicy: {},
    });
    db.upsertOperator({ id: 'op-feishu', botAccountId: 'bot-feishu2', platformUserId: 'ou_paired', role: 'operator' });
    const store = new ChannelContactStore(testStorePath);
    const channel = new FeishuChannel({
      host: hostWithTask,
      contactStore: store,
      config: { appId: 'cli_test_app', defaultAgent: 'ops' },
      control: { botAccountId: 'bot-feishu2', authorization: new BotAuthorizationService(db) },
    });

    await channel.handleEventPayload(JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: 'evt_paired' },
      event: {
        sender: { sender_id: { open_id: 'ou_paired' }, sender_type: 'user' },
        message: {
          message_id: 'om_paired',
          chat_id: 'oc_feishu_chat_paired',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '查看服务器' }),
        },
      },
    }));

    expect(runTaskMock).toHaveBeenCalledOnce();
    const request = runTaskMock.mock.calls[0]?.[0] as { executionContext?: { serverId?: string; botAccountId?: string; control?: { operatorId?: string } } };
    expect(request.executionContext?.serverId).toBe('srv-feishu-bound');
    expect(request.executionContext?.botAccountId).toBe('bot-feishu2');
    expect(request.executionContext?.control?.operatorId).toBe('op-feishu');
    db.close();
  });
});
