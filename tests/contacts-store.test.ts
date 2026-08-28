import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelContactStore } from '../src/channels/contacts-store.js';

describe('ChannelContactStore (多通道通用联系人与智能体路由中枢)', () => {
  const testStoreDir = join(tmpdir(), `hap_test_contacts_${Date.now()}`);
  const testStorePath = join(testStoreDir, 'test_contacts.json');

  beforeEach(() => {
    ChannelContactStore.resetInstance();
  });

  afterEach(() => {
    ChannelContactStore.resetInstance();
    if (existsSync(testStoreDir)) {
      rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  it('支持为飞书、QQ、微信等不同通道独立创建与归档联系人', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    // 微信联系人
    store.upsertContact({
      id: 'wx_user_1',
      channel: 'wechat',
      name: '张三 (微信)',
      agentId: 'coder',
      replyMode: 'all',
      autoReply: true,
    });

    // 飞书群聊
    store.upsertContact({
      id: 'feishu_chat_arch',
      channel: 'feishu',
      name: '架构委员会 (飞书群)',
      isRoom: true,
      type: 'room',
      agentId: 'reviewer',
      replyMode: 'mention',
      autoReply: true,
    });

    // QQ 好友
    store.upsertContact({
      id: 'qq_user_10001',
      channel: 'qq',
      name: '李四 (QQ)',
      agentId: 'ops',
      replyMode: 'all',
      autoReply: true,
    });

    const allContacts = store.listContacts();
    expect(allContacts).toHaveLength(3);

    const feishuContacts = store.listContacts('feishu');
    expect(feishuContacts).toHaveLength(1);
    expect(feishuContacts[0]?.id).toBe('feishu_chat_arch');
    expect(feishuContacts[0]?.agentId).toBe('reviewer');

    const qqContacts = store.listContacts('qq');
    expect(qqContacts).toHaveLength(1);
    expect(qqContacts[0]?.id).toBe('qq_user_10001');
    expect(qqContacts[0]?.agentId).toBe('ops');
  });

  it('收到不同通道消息时自动记录并更新最后对话信息', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    // 接收飞书群消息
    const { contact: feishuContact } = store.recordIncomingMessage({
      channel: 'feishu',
      fromId: 'ou_feishu_user_888',
      fromName: '王五',
      isRoom: true,
      roomId: 'oc_feishu_chat_dev',
      roomName: '前端研发组 (飞书)',
      text: '请帮我 review 这个 PR',
    });

    expect(feishuContact.id).toBe('oc_feishu_chat_dev');
    expect(feishuContact.name).toBe('前端研发组 (飞书)');
    expect(feishuContact.isRoom).toBe(true);
    expect(feishuContact.channel).toBe('feishu');
    expect(feishuContact.lastMessage).toBe('请帮我 review 这个 PR');

    // 记录智能体回写消息
    store.recordOutgoingMessage({
      channel: 'feishu',
      contactId: 'oc_feishu_chat_dev',
      agentId: 'reviewer',
      text: 'PR 代码结构良好，测试已通过。',
    });

    const msgs = store.getMessages('oc_feishu_chat_dev', 'feishu');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.sender).toBe('user');
    expect(msgs[0]?.text).toBe('请帮我 review 这个 PR');
    expect(msgs[1]?.sender).toBe('agent');
    expect(msgs[1]?.agentId).toBe('reviewer');
    expect(msgs[1]?.text).toBe('PR 代码结构良好，测试已通过。');
  });

  it('支持移除指定通道的联系人及其消息', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    store.upsertContact({
      id: 'qq_group_666',
      channel: 'qq',
      name: '测试QQ群',
    });
    expect(store.listContacts('qq')).toHaveLength(1);

    const removed = store.removeContact('qq_group_666', 'qq');
    expect(removed).toBe(true);
    expect(store.listContacts('qq')).toHaveLength(0);
  });
});
