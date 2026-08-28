/**
 * 微信联系人与群聊管理、专属智能体自动回复规则单元测试
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WeChatContactStore } from '../src/channels/wechat-contacts.js';

const tempDirs: string[] = [];

function createTempStore(): { store: WeChatContactStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hap-wx-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'wechat_contacts.json');
  const store = new WeChatContactStore(filePath);
  return { store, dir };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WeChatContactStore', () => {
  it('应当正确初始化并支持联系人列表获取', () => {
    const { store } = createTempStore();
    const contacts = store.listContacts();
    expect(Array.isArray(contacts)).toBe(true);
    expect(contacts.length).toBe(0);
  });

  it('应当支持添加与更新联系人以及绑定专属智能体', () => {
    const { store } = createTempStore();
    const added = store.upsertContact({
      id: 'wx_user_custom_001',
      name: '王小二 (运维工程师)',
      type: 'user',
      isRoom: false,
      agentId: 'ops',
      autoReply: true,
      replyMode: 'all',
    });

    expect(added.id).toBe('wx_user_custom_001');
    expect(added.agentId).toBe('ops');
    expect(added.autoReply).toBe(true);

    const retrieved = store.getContact('wx_user_custom_001');
    expect(retrieved?.name).toBe('王小二 (运维工程师)');

    // 更新专属智能体为 reviewer
    const updated = store.upsertContact({
      id: 'wx_user_custom_001',
      name: '王小二 (运维工程师)',
      agentId: 'reviewer',
      replyMode: 'manual',
      autoReply: false,
    });
    expect(updated.agentId).toBe('reviewer');
    expect(updated.autoReply).toBe(false);
    expect(updated.replyMode).toBe('manual');
  });

  it('入站消息应当自动收录并更新联系人状态与消息流', () => {
    const { store } = createTempStore();

    const { contact, messageRecord } = store.recordIncomingMessage({
      fromId: 'wx_user_new_visitor',
      fromName: '新访客用户',
      isRoom: false,
      text: '请帮我写一个二叉树前序遍历',
    });

    expect(contact.id).toBe('wx_user_new_visitor');
    expect(contact.name).toBe('新访客用户');
    expect(contact.lastMessage).toBe('请帮我写一个二叉树前序遍历');
    expect(messageRecord.sender).toBe('user');
    expect(messageRecord.text).toBe('请帮我写一个二叉树前序遍历');

    const messages = store.getMessages('wx_user_new_visitor');
    expect(messages.length).toBe(1);
    expect(messages[0]?.text).toBe('请帮我写一个二叉树前序遍历');
  });

  it('出站消息应当正确记录并关联专属智能体', () => {
    const { store } = createTempStore();

    store.recordIncomingMessage({
      fromId: 'wx_user_test',
      fromName: '测试用户',
      isRoom: false,
      text: '你好',
    });

    const outgoing = store.recordOutgoingMessage({
      contactId: 'wx_user_test',
      agentId: 'coder',
      text: '你好！我是 Coder 智能体，请问有什么可以协助您？',
    });

    expect(outgoing.sender).toBe('agent');
    expect(outgoing.agentId).toBe('coder');

    const messages = store.getMessages('wx_user_test');
    expect(messages.length).toBe(2);
    expect(messages[1]?.sender).toBe('agent');
    expect(messages[1]?.agentId).toBe('coder');
  });

  it('应当支持移除联系人并清理其消息流', () => {
    const { store } = createTempStore();
    store.upsertContact({
      id: 'wx_user_to_delete',
      name: '待删除联系人',
    });
    store.recordIncomingMessage({
      fromId: 'wx_user_to_delete',
      fromName: '待删除',
      isRoom: false,
      text: '临时消息',
    });

    expect(store.getContact('wx_user_to_delete')).toBeDefined();
    const removed = store.removeContact('wx_user_to_delete');
    expect(removed).toBe(true);
    expect(store.getContact('wx_user_to_delete')).toBeUndefined();
    expect(store.getMessages('wx_user_to_delete').length).toBe(0);
  });
});
