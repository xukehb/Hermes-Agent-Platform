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
    expect(feishuContact.agentId).toBeUndefined();
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

  it('支持保存与持久化通道默认分身人设与托管策略，且在消息流转与联系人更新时不丢失', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    // 1. 保存微信通道的默认策略与分身人设 (Persona Prompt)
    const customPersona = '你现在是小莹，性格温柔可爱，说话亲切活泼，每次回复一两句话。';
    const saved = store.saveDefaultPolicy('wechat', {
      agentId: 'xx',
      systemPrompt: customPersona,
      hostingMode: 'auto',
      cooldownMinutes: 15,
      delayMs: 3000,
    });

    expect(saved.agentId).toBe('xx');
    expect(saved.systemPrompt).toBe(customPersona);
    expect(saved.cooldownMinutes).toBe(15);

    // 2. 验证立即读取
    const policy = store.getDefaultPolicy('wechat');
    expect(policy.agentId).toBe('xx');
    expect(policy.systemPrompt).toBe(customPersona);
    expect(policy.cooldownMinutes).toBe(15);
    expect(policy.delayMs).toBe(3000);

    // 3. 产生入站消息与联系人自动创建，验证新联系人自动继承默认配置，且 defaults 不被洗白
    store.recordIncomingMessage({
      channel: 'wechat',
      fromId: 'wx_user_friend_1',
      fromName: '微信好友A',
      isRoom: false,
      text: '你好呀！',
    });

    const contact = store.getContact('wx_user_friend_1', 'wechat');
    expect(contact).toBeDefined();
    expect(contact?.agentId).toBe('xx');
    expect(contact?.systemPrompt).toBe(customPersona);

    // 4. 产生回写出站消息
    store.recordOutgoingMessage({
      channel: 'wechat',
      contactId: 'wx_user_friend_1',
      agentId: 'xx',
      text: '你好呀～收到啦！',
    });

    // 5. 模拟实例销毁并重新从持久化文件加载，验证 defaults 与分身人设完整持久化
    ChannelContactStore.resetInstance();
    const freshStore = ChannelContactStore.getInstance(testStorePath);
    const reloadedPolicy = freshStore.getDefaultPolicy('wechat');

    expect(reloadedPolicy.agentId).toBe('xx');
    expect(reloadedPolicy.systemPrompt).toBe(customPersona);
    expect(reloadedPolicy.hostingMode).toBe('auto');
    expect(reloadedPolicy.cooldownMinutes).toBe(15);
    expect(reloadedPolicy.delayMs).toBe(3000);

    // 6. 清空联系人后，默认策略与分身人设仍然保留
    freshStore.clearAllContacts('wechat');
    expect(freshStore.listContacts('wechat')).toHaveLength(0);
    const retainedPolicy = freshStore.getDefaultPolicy('wechat');
    expect(retainedPolicy.agentId).toBe('xx');
    expect(retainedPolicy.systemPrompt).toBe(customPersona);
  });
});
