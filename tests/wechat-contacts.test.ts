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

  it('应当准确识别并过滤 OCR 产生的噪点假联系人与系统占位符', async () => {
    const { isGarbageContactName, isErrorMessage } = await import('../src/channels/contacts-store.js');

    // 路径与 IDE 窗口状态
    expect(isGarbageContactName('/Users/xuke/ldeaProjects/zn/admin-app/manifest.json - HBuilder X 4.87')).toBe(true);
    expect(isGarbageContactName('Worked for 14m')).toBe(true);
    expect(isGarbageContactName('•reasonix VL.38.11•deepseeK-v4-fLash•~/app')).toBe(true);

    // 时间戳与视觉 OCR 错别字
    expect(isGarbageContactName('昨天 00:10')).toBe(true);
    expect(isGarbageContactName('靠天 20.08')).toBe(true);
    expect(isGarbageContactName('昨灭 20:08')).toBe(true);
    expect(isGarbageContactName('01:04|')).toBe(true);
    expect(isGarbageContactName('坐期五')).toBe(true);

    // 系统占位符与单字
    expect(isGarbageContactName('我')).toBe(true);
    expect(isGarbageContactName('公众号')).toBe(true);
    expect(isGarbageContactName('1')).toBe(true);
    expect(isGarbageContactName('w')).toBe(true);

    // 标点断句气泡
    expect(isGarbageContactName('害，没那么夸张啦。你最近在')).toBe(true);
    expect(isGarbageContactName('你在干嘛')).toBe(true);

    // 真实联系人应当保留
    expect(isGarbageContactName('何莹莹')).toBe(false);
    expect(isGarbageContactName('平安喜樂')).toBe(false);
    expect(isGarbageContactName('AI新境交流群B2.0')).toBe(false);

    // 报错信息判定
    expect(isErrorMessage('（本次没有产生正文输出）\n\n✗ 任务失败：模型 xkk/deepseek-v4 请求失败：HTTP 403')).toBe(true);
    expect(isErrorMessage('你好，在吗？')).toBe(false);
  });

  it('pruneGarbageContacts 应当能够一键清理历史遗留假联系人并净化消息流', () => {
    const { store, dir } = createTempStore();
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');

    // 模拟旧版本写入磁盘的脏数据（包含假联系人与 403 异常报错）
    const corruptedData = {
      contacts: [
        { id: '何莹莹', channel: 'wechat', name: '何莹莹', lastMessage: '✗ 任务失败：服务商拒绝了当前凭据 HTTP 403' },
        { id: '昨天 00:10', channel: 'wechat', name: '昨天 00:10', lastMessage: '噪点' },
        { id: '/Users/test/manifest.json', channel: 'wechat', name: '/Users/test/manifest.json', lastMessage: '噪点' },
      ],
      messages: [
        { id: 'm1', channel: 'wechat', contactId: '何莹莹', fromId: '何莹莹', text: '你好呀', time: '10:00' },
        { id: 'm2', channel: 'wechat', contactId: '何莹莹', fromId: '何莹莹', text: '✗ 任务失败：服务商拒绝了当前凭据 HTTP 403', time: '10:01' },
        { id: 'm3', channel: 'wechat', contactId: '昨天 00:10', fromId: '昨天 00:10', text: '噪点', time: '10:02' },
      ],
      defaults: {},
    };
    writeFileSync(join(dir, 'wechat_contacts.json'), JSON.stringify(corruptedData, null, 2), 'utf8');

    // 加载或执行清理
    const result = store.pruneGarbageContacts();
    expect(result.removedContacts).toBe(2);

    const afterList = store.listContacts();
    expect(afterList.length).toBe(1);
    expect(afterList[0]?.name).toBe('何莹莹');
    // 报错消息被清洗，lastMessage 恢复为上一条纯净消息
    expect(afterList[0]?.lastMessage).toBe('你好呀');

    const msgs = store.getMessages('何莹莹');
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.text).toBe('你好呀');
  });
});
