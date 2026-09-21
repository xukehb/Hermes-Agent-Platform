import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelContactStore,
  normalizeContactName,
  normalizeContactId,
} from '../src/channels/contacts-store.js';
import { WeChatContactStore } from '../src/channels/wechat-contacts.js';
import { WeChatChannel } from '../src/channels/wechat.js';
import type { ChannelHost, InboundMessage } from '../src/channels/types.js';
import type { TaskOutcome, SessionStatus } from '../src/agent/index.js';

describe('WeChat Hosting Continuity & Persona Decoupling (微信代管对话连贯性与人设解耦)', () => {
  const testStoreDir = join(tmpdir(), `hap_test_continuity_${Date.now()}`);
  const testStorePath = join(testStoreDir, 'continuity_contacts.json');

  beforeEach(() => {
    ChannelContactStore.resetInstance();
    WeChatContactStore.resetInstance();
  });

  afterEach(() => {
    ChannelContactStore.resetInstance();
    WeChatContactStore.resetInstance();
    if (existsSync(testStoreDir)) {
      rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  it('normalizeContactName 与 normalizeContactId 能准确清洗各类 OCR 噪点与标点', () => {
    expect(normalizeContactName('平安喜樂。')).toBe('平安喜樂');
    expect(normalizeContactName('平安喜樂 。')).toBe('平安喜樂');
    expect(normalizeContactName('平安喜樂”。')).toBe('平安喜樂');
    expect(normalizeContactName('“平安喜樂”')).toBe('平安喜樂');
    expect(normalizeContactName('「平安喜樂」')).toBe('平安喜樂');
    expect(normalizeContactName('平安喜樂 (1)')).toBe('平安喜樂');
    expect(normalizeContactName('平安喜樂（2）')).toBe('平安喜樂');
    expect(normalizeContactName('王总 (商业伙伴)')).toBe('王总 (商业伙伴)');

    expect(normalizeContactId('平安喜樂。')).toBe('平安喜樂');
    expect(normalizeContactId('wx_user_12345')).toBe('wx_user_12345');
    expect(normalizeContactId('telegram:9876')).toBe('telegram:9876');
  });

  it('ChannelContactStore.load 自动合并历史碎片联系人并重定向全部历史消息', () => {
    const store = new ChannelContactStore(testStorePath);
    // 模拟磁盘上已存在的因 OCR 识别浮动产生的碎片联系人及各自的历史消息
    const fragmentedData = {
      contacts: [
        {
          id: '平安喜樂',
          channel: 'wechat',
          name: '平安喜樂',
          type: 'user',
          isRoom: false,
          autoReply: true,
          agentId: 'coder',
          systemPrompt: '我是小莹，温柔亲切',
          lastMessage: '你好呀',
          lastTime: '10:00',
        },
        {
          id: '平安喜樂。',
          channel: 'wechat',
          name: '平安喜樂。',
          type: 'user',
          isRoom: false,
          autoReply: true,
          agentId: 'coder',
          lastMessage: '下午有空吗',
          lastTime: '10:05',
        },
        {
          id: '平安喜樂”。',
          channel: 'wechat',
          name: '平安喜樂”。',
          type: 'user',
          isRoom: false,
          autoReply: true,
          agentId: 'coder',
          lastMessage: '晚上一起吃饭',
          lastTime: '10:10',
        },
      ],
      messages: [
        {
          id: 'm1',
          channel: 'wechat',
          contactId: '平安喜樂',
          fromId: '平安喜樂',
          fromName: '平安喜樂',
          isRoom: false,
          sender: 'user',
          text: '你好呀',
          time: '10:00',
          timestamp: 1000,
        },
        {
          id: 'm2',
          channel: 'wechat',
          contactId: '平安喜樂。',
          fromId: '平安喜樂。',
          fromName: '平安喜樂。',
          isRoom: false,
          sender: 'user',
          text: '下午有空吗',
          time: '10:05',
          timestamp: 2000,
        },
        {
          id: 'm3',
          channel: 'wechat',
          contactId: '平安喜樂”。',
          fromId: '平安喜樂”。',
          fromName: '平安喜樂”。',
          isRoom: false,
          sender: 'user',
          text: '晚上一起吃饭',
          time: '10:10',
          timestamp: 3000,
        },
      ],
      defaults: {},
    };

    store.save(fragmentedData as any);

    // 触发 load()，应自动完成清洗、合并与别名记录
    const loaded = store.load();
    expect(loaded.contacts.length).toBe(1);
    const canonical = loaded.contacts[0]!;
    expect(canonical.id).toBe('平安喜樂');
    expect(canonical.name).toBe('平安喜樂');
    expect(canonical.systemPrompt).toBe('我是小莹，温柔亲切');
    expect(canonical.aliases).toContain('平安喜樂。');
    expect(canonical.aliases).toContain('平安喜樂”。');

    // 验证所有历史消息的 contactId 均已被重定向至规范 ID
    expect(loaded.messages.length).toBe(3);
    for (const msg of loaded.messages) {
      expect(msg.contactId).toBe('平安喜樂');
    }

    // 再次调用 getMessages('平安喜樂') 能取回完整的 3 条消息
    const messages = store.getMessages('平安喜樂', 'wechat');
    expect(messages.length).toBe(3);
  });

  it('recordIncomingMessage 使用归一化匹配，杜绝产生新的碎片联系人', () => {
    const store = new ChannelContactStore(testStorePath);
    // 先入库一位标准联系人
    store.upsertContact({
      id: '平安喜樂',
      channel: 'wechat',
      name: '平安喜樂',
      systemPrompt: '分身人设',
    });

    // 收到带有 OCR 噪点的新消息
    const { contact } = store.recordIncomingMessage({
      channel: 'wechat',
      fromId: '平安喜樂。',
      fromName: '平安喜樂。',
      isRoom: false,
      text: '明天天气怎么样？',
    });

    // 应该直接命中现有联系人，而不是新建
    expect(contact.id).toBe('平安喜樂');
    expect(contact.systemPrompt).toBe('分身人设');
    expect(contact.aliases).toContain('平安喜樂。');
    expect(store.listContacts('wechat').length).toBe(1);
  });

  it('getRecentConversationHistory 提取纯净历史并清洗历史模板污染', () => {
    const store = new ChannelContactStore(testStorePath);
    store.upsertContact({
      id: 'wx_user_bob',
      channel: 'wechat',
      name: 'Bob',
    });

    // 模拟存入历史消息：包含一条被旧版本模板污染的来信和一条助手回复
    store.recordIncomingMessage({
      channel: 'wechat',
      fromId: 'wx_user_bob',
      fromName: 'Bob',
      isRoom: false,
      text: '[微信聊天规范：当前为微信好友即时通讯...] 【专属分身人设...】\n\n对方发来：“周末去爬山吗？”',
    });

    store.recordOutgoingMessage({
      channel: 'wechat',
      contactId: 'wx_user_bob',
      agentId: 'coder',
      text: '好呀，周六上午去怎样？',
    });

    // 模拟一条系统错误提示（应当被过滤）
    store.recordOutgoingMessage({
      channel: 'wechat',
      contactId: 'wx_user_bob',
      sender: 'system',
      text: '✗ 任务失败：网络超时',
    });

    const history = store.getRecentConversationHistory('wx_user_bob', 'wechat', 10);
    expect(history.length).toBe(2);
    expect(history[0]?.role).toBe('user');
    // 验证旧模板被彻底剥离，还原为纯净提问
    expect(history[0]?.content).toBe('周末去爬山吗？');
    expect(history[1]?.role).toBe('assistant');
    expect(history[1]?.content).toBe('好呀，周六上午去怎样？');
  });

  it('好友事实画像提取 (extractContactFacts) 与沉淀', () => {
    const store = new ChannelContactStore(testStorePath);
    store.upsertContact({
      id: 'wx_user_alice',
      channel: 'wechat',
      name: 'Alice',
    });

    const facts1 = store.extractContactFacts('wx_user_alice', 'wechat', '我现在在深圳，经常去南山');
    expect(facts1).toContain('所在地/常驻: 深圳');

    const facts2 = store.extractContactFacts('wx_user_alice', 'wechat', '我是做跨境电商的');
    expect(facts2).toContain('行业/业务: 跨境电商');

    const facts3 = store.extractContactFacts('wx_user_alice', 'wechat', '我平时喜欢打羽毛球');
    expect(facts3).toContain('爱好/偏好: 打羽毛球');

    const contact = store.getContact('wx_user_alice', 'wechat');
    expect(contact?.facts).toContain('所在地/常驻: 深圳');
    expect(contact?.facts).toContain('行业/业务: 跨境电商');
    expect(contact?.facts).toContain('爱好/偏好: 打羽毛球');
  });

  it('WeChatChannel 将人设注入 inbound.systemPrompt，保持 inbound.text 纯净且透传 history', async () => {
    let capturedInbound: InboundMessage | undefined;

    const mockHost = {
      runTask: async () => ({
        status: 'done',
        terminalSummary: '任务完成',
      }),
      abortSession: () => [],
      clearSession: () => undefined,
      usageSince: () => undefined,
      status: (sessionKey: string) => ({
        sessionKey,
        agentId: 'coder',
        model: 'test/model',
        chain: ['test/model'],
        running: [],
        recent: [],
        todayTokens: 0,
        dailyTokenBudget: 100,
      }),
      trace: () => undefined,
      agentIds: () => ['coder'],
      agentsList: () => [{ id: 'coder', name: '全栈工程师', displayName: '小莹' }],
    } as unknown as ChannelHost;

    const contactStore = new ChannelContactStore(testStorePath);
    contactStore.upsertContact({
      id: '平安喜樂',
      channel: 'wechat',
      name: '平安喜樂',
      systemPrompt: '性格温和，称呼对方为李哥',
      facts: ['常驻深圳科技园', '做外贸服饰'],
    });

    // 预置前序历史
    contactStore.recordIncomingMessage({
      channel: 'wechat',
      fromId: '平安喜樂',
      fromName: '平安喜樂',
      isRoom: false,
      text: '老李，好久不见',
    });
    contactStore.recordOutgoingMessage({
      channel: 'wechat',
      contactId: '平安喜樂',
      text: '是啊，最近忙啥呢？',
    });

    const wechatStore = new WeChatContactStore(testStorePath);

    const channel = new WeChatChannel({
      host: mockHost,
      channels: {
        editIntervalMs: 0,
        asyncThresholdMs: 10000,
        wechat: {
          enabled: true,
          mode: 'personal',
          defaultAgent: 'coder',
          authDir: testStoreDir,
          mentionPatterns: [],
          messageCharLimit: 2048,
          qrLog: false,
        },
      } as never,
      limits: {
        ingressQueueSize: 100,
      } as never,
      paths: {
        spoolDir: join(testStoreDir, 'spool'),
      } as never,
      contactStore: wechatStore,
    });

    // 拦截 dispatcher.submit
    (channel as any).dispatcher = {
      submit: (msg: InboundMessage) => {
        capturedInbound = msg;
      },
    };

    // 模拟收到 OCR 带有末尾句号的好友来信
    await channel.handlePersonalMessage({
      id: 'msg_test_1',
      fromId: '平安喜樂。',
      fromName: '平安喜樂。',
      isRoom: false,
      text: '我刚落地深圳，晚上有空聚聚不？',
    });

    expect(capturedInbound).toBeDefined();
    // 1. 正文应当纯净，不拼接任何人设指令
    expect(capturedInbound?.text).toBe('我刚落地深圳，晚上有空聚聚不？');
    // 2. sessionKey 与归一化 ID 绑定
    expect(capturedInbound?.sessionKey).toBe('wechat:user:平安喜樂');
    // 3. 人设和画像事实独立注入 systemPrompt
    expect(capturedInbound?.systemPrompt).toContain('【最高优先级指令：微信即时通讯数字分身】');
    expect(capturedInbound?.systemPrompt).toContain('常驻深圳科技园');
    expect(capturedInbound?.systemPrompt).toContain('称呼对方为李哥');
    // 4. 提取并透传了前序对话历史（包含前序2条往来及本次入站）
    expect(capturedInbound?.history?.length).toBe(3);
    expect(capturedInbound?.history?.[0]?.content).toBe('老李，好久不见');
    expect(capturedInbound?.history?.[1]?.content).toBe('是啊，最近忙啥呢？');
    expect(capturedInbound?.history?.[2]?.content).toBe('我刚落地深圳，晚上有空聚聚不？');
  });
});
