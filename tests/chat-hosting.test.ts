import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelContactStore } from '../src/channels/contacts-store.js';

describe('Chat Hosting (聊天托管与数字分身代管)', () => {
  const testStoreDir = join(tmpdir(), `hap_test_hosting_${Date.now()}`);
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

  it('支持为微信和 QQ 好友配置专属托管模式、Prompt人设与拟人化延迟', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    // 配置微信好友为全自动托管，带有专属人设
    const wxContact = store.upsertContact({
      id: 'wx_user_vip',
      channel: 'wechat',
      name: '王总 (商业伙伴)',
      agentId: 'researcher',
      hostingMode: 'auto',
      systemPrompt: '以徐克助理的身份回复，热情严谨，商务合作先咨询项目排期',
      delayMs: 3000,
    });

    expect(wxContact.hostingMode).toBe('auto');
    expect(wxContact.systemPrompt).toContain('徐克助理');
    expect(wxContact.delayMs).toBe(3000);

    // 配置 QQ 群聊为仅@托管模式
    const qqRoom = store.upsertContact({
      id: 'qq_group_dev',
      channel: 'qq',
      name: '核心算法研发群',
      isRoom: true,
      agentId: 'coder',
      hostingMode: 'mention',
      delayMs: 1500,
    });

    expect(qqRoom.hostingMode).toBe('mention');
    expect(qqRoom.isRoom).toBe(true);

    const stats = store.getHostingStats();
    expect(stats.totalContacts).toBe(2);
  });

  it('支持人工回复时触发防撞车冷却保护 (Human Takeover & Cooldown)', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    store.upsertContact({
      id: 'wx_user_alex',
      channel: 'wechat',
      name: 'Alex',
      hostingMode: 'auto',
    });

    // 触发人工接管 15 分钟
    const updated = store.triggerHumanTakeover('wx_user_alex', 'wechat', 15);
    expect(updated?.humanTakenOver).toBe(true);
    expect(updated?.cooldownUntil).toBeGreaterThan(Date.now());

    // 记录一条人工真实发送的消息
    const humanMsg = store.recordOutgoingMessage({
      channel: 'wechat',
      contactId: 'wx_user_alex',
      sender: 'human',
      text: '我刚开完会，咱们稍后直接电话聊',
    });

    expect(humanMsg.sender).toBe('human');
    expect(humanMsg.fromName).toBe('我 (人工回复)');

    const stats = store.getHostingStats();
    expect(stats.activeCooldowned).toBe(1);

    // 释放人工接管
    const released = store.releaseHumanTakeover('wx_user_alex', 'wechat');
    expect(released?.humanTakenOver).toBe(false);
    expect(released?.cooldownUntil).toBeUndefined();
    expect(store.getHostingStats().activeCooldowned).toBe(0);
  });

  it('支持半托管模式下回复草稿的生成、审批发送与舍弃', () => {
    const store = ChannelContactStore.getInstance(testStorePath);

    store.upsertContact({
      id: 'qq_user_client',
      channel: 'qq',
      name: '李客户',
      hostingMode: 'draft',
    });

    // 模拟半托管模式生成了一条草稿
    const draftMsg = store.recordOutgoingMessage({
      channel: 'qq',
      contactId: 'qq_user_client',
      agentId: 'coder',
      sender: 'agent',
      text: '您好，我们下周二可以交付首版，请问方便腾讯会议吗？',
      isDraft: true,
      draftStatus: 'pending',
      elapsedMs: 1200,
    });

    expect(draftMsg.isDraft).toBe(true);
    expect(draftMsg.draftStatus).toBe('pending');
    expect(store.getHostingStats().pendingDrafts).toBe(1);

    // 审批通过草稿
    const approved = store.approveDraft(draftMsg.id);
    expect(approved?.isDraft).toBe(false);
    expect(approved?.draftStatus).toBe('sent');
    expect(store.getHostingStats().pendingDrafts).toBe(0);

    // 再次生成一条待丢弃草稿
    const draftMsg2 = store.recordOutgoingMessage({
      channel: 'qq',
      contactId: 'qq_user_client',
      agentId: 'coder',
      sender: 'agent',
      text: '不妥当的草稿内容',
      isDraft: true,
      draftStatus: 'pending',
    });

    expect(store.getHostingStats().pendingDrafts).toBe(1);
    const discarded = store.discardDraft(draftMsg2.id);
    expect(discarded).toBe(true);
    expect(store.getHostingStats().pendingDrafts).toBe(0);
  });
});
