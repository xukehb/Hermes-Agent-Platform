import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WeChatChannel, type WeChatPersonalDriver } from '../src/channels/wechat.js';
import type { ChannelHost, InboundMessage } from '../src/channels/types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../src/config/index.js';
import { BUILTIN_CHANNELS, BUILTIN_LIMITS } from '../src/config/index.js';
import type { RunTaskRequest, TaskOutcome, SessionStatus, TraceSummary, UsageAggregate } from '../src/agent/index.js';
import { ChannelContactStore } from '../src/channels/contacts-store.js';
import { WeChatContactStore } from '../src/channels/wechat-contacts.js';

const root = mkdtempSync(join(tmpdir(), 'hap-wx-'));
const testContactsPath = join(root, 'universal_contacts.json');

beforeEach(() => {
  ChannelContactStore.resetInstance();
  WeChatContactStore.resetInstance();
  ChannelContactStore.getInstance(testContactsPath);
  WeChatContactStore.getInstance(testContactsPath);
});

afterEach(() => {
  ChannelContactStore.resetInstance();
  WeChatContactStore.resetInstance();
});

function channelsOf(
  patch: Partial<Omit<ResolvedChannels['wechat'], 'personal'>> & {
    personal?: Partial<ResolvedChannels['wechat']['personal']>;
  } = {}
): ResolvedChannels {
  return {
    editIntervalMs: 0,
    asyncThresholdMs: BUILTIN_CHANNELS.asyncThresholdMs,
    telegram: {
      enabled: false,
      tokenEnv: BUILTIN_CHANNELS.telegram.tokenEnv,
      mode: 'polling',
      defaultAgent: undefined,
      mentionPatterns: [...BUILTIN_CHANNELS.telegram.mentionPatterns],
      messageCharLimit: BUILTIN_CHANNELS.telegram.messageCharLimit,
      webhook: undefined,
    },
    whatsapp: {
      enabled: false,
      authDir: join(root, 'wa-auth'),
      defaultAgent: undefined,
      mentionPatterns: [],
      messageCharLimit: 4096,
      reconnectInitialMs: 1000,
      reconnectMaxMs: 30000,
      qrLog: false,
    },
    wechat: {
      enabled: true,
      mode: 'personal',
      authDir: join(root, 'wx-auth'),
      defaultAgent: undefined,
      mentionPatterns: ['@hap'],
      messageCharLimit: 2048,
      qrLog: false,
      wecom: undefined,
      officialAccount: undefined,
      ...patch,
      personal: { ...BUILTIN_CHANNELS.wechat.personal, ...(patch?.personal ?? {}) },
    },
    http: { enabled: false, bind: '127.0.0.1:8798', defaultAgent: undefined },
    cli: { enabled: false, defaultAgent: undefined },
  };
}

const limits: ResolvedLimits = {
  ...BUILTIN_LIMITS,
  providerConcurrency: {},
  providerRpm: {},
  agentConcurrency: {},
  agentRpm: {},
};

const paths: ResolvedPaths = {
  dataDir: root,
  traceDir: join(root, 'traces'),
  overflowDir: join(root, 'overflow'),
  spoolDir: join(root, 'spool'),
};

/** 宿主桩：记录收到的任务请求。 */
class StubHost implements ChannelHost {
  readonly requests: RunTaskRequest[] = [];

  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
    this.requests.push(request);
    return {
      taskId: 'task-wx-1',
      agentId: request.agentId ?? 'coder',
      sessionKey: request.sessionKey ?? 'wechat:user:test',
      status: 'done',
      tracePath: '',
      text: '微信任务完成',
      reasoning: '',
      messages: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      iterations: 1,
      model: 'test/model',
      protocol: 'deepseek',
      finishReason: 'stop',
      stopReason: 'stop',
      retranslations: 0,
    };
  }

  abortSession(): string[] {
    return [];
  }

  status(sessionKey: string): SessionStatus {
    return {
      sessionKey,
      agentId: 'coder',
      model: 'test/model',
      chain: ['test/model'],
      running: [],
      recent: [],
      todayTokens: 0,
      dailyTokenBudget: 100,
    };
  }

  trace(): TraceSummary | undefined {
    return undefined;
  }

  agentIds(): string[] {
    return ['coder', 'writer'];
  }

  clearSession(_sessionKey: string): void {
    /* no-op */
  }

  usageSince(): UsageAggregate[] {
    return [];
  }
}

describe('WeChatChannel 基础测试', () => {
  test('构造成功且 name 为 wechat', () => {
    const channel = new WeChatChannel({
      host: new StubHost(),
      channels: channelsOf(),
      limits,
      paths,
    });
    expect(channel.name).toBe('wechat');
  });

  test('个人微信模式缺少 Puppet 凭据时明确失败', async () => {
    const channel = new WeChatChannel({
      host: new StubHost(),
      channels: channelsOf({ personal: { ...BUILTIN_CHANNELS.wechat.personal, puppet: 'service' } }),
      limits,
      paths,
    });
    await expect(channel.start()).rejects.toThrow('WECHATY_PUPPET_SERVICE_TOKEN');
  });

  test('iLink Bot 模式复用个人微信扫码驱动且不需要 Puppet 凭据', async () => {
    const host = new StubHost();
    const channel = new WeChatChannel({
      host,
      channels: channelsOf({ mode: 'ilink_bot' }),
      limits,
      paths,
      env: {},
      personalDriverFactory: (_authDir, _log) => ({
        start: async () => undefined,
        stop: async () => undefined,
        sendMessage: async () => undefined,
      }),
    });

    await expect(channel.start()).resolves.toBeUndefined();
    await channel.stop();
  });

  test('个人微信模式接收私聊消息并下发任务至编排层', async () => {
    const host = new StubHost();
    let injectedDriver: WeChatPersonalDriver | undefined;

    const channel = new WeChatChannel({
      host,
      channels: channelsOf(),
      limits,
      paths,
      personalDriverFactory: (_authDir, _log) => {
        const driver: WeChatPersonalDriver = {
          start: async () => {
            driver.onLogin?.({ id: 'wx_user_123', name: '张三' });
          },
          stop: async () => undefined,
          sendMessage: async (_target, _text) => 'msg_1',
        };
        injectedDriver = driver;
        return driver;
      },
    });

    await channel.start();
    expect(channel.currentUser?.name).toBe('张三');

    // 模拟收到私聊消息
    await channel.handlePersonalMessage({
      id: 'm1',
      fromId: 'wx_user_456',
      fromName: '李四',
      isRoom: false,
      text: '帮我写一个快速排序算法',
    });

    // 等待排空
    await channel.stop();

    expect(host.requests.length).toBe(1);
    expect(host.requests[0]?.input).toBe('帮我写一个快速排序算法');
    expect(host.requests[0]?.sessionKey).toBe('wechat:user:wx_user_456');
  });

  test('个人微信群聊消息支持 @mention 路由与过滤', async () => {
    const host = new StubHost();
    const driver: WeChatPersonalDriver = { start: async () => undefined, stop: async () => undefined, sendMessage: async () => undefined };
    const channel = new WeChatChannel({
      host,
      channels: channelsOf({ mentionPatterns: ['@hap'] }),
      limits,
      paths,
      personalDriverFactory: () => driver,
    });

    await channel.start();

    // 1) 未 @ 智能体的群消息应被忽略
    await channel.handlePersonalMessage({
      id: 'm2',
      fromId: 'wx_user_789',
      fromName: '王五',
      isRoom: true,
      roomId: 'room_001',
      roomName: '研发群',
      text: '大家今天下午开会吗？',
    });

    expect(host.requests.length).toBe(0);

    // 2) @hap 的群消息被提取并执行
    await channel.handlePersonalMessage({
      id: 'm3',
      fromId: 'wx_user_789',
      fromName: '王五',
      isRoom: true,
      roomId: 'room_001',
      roomName: '研发群',
      text: '@hap 帮我写一段 TypeScript 代码',
    });

    await channel.stop();

    expect(host.requests.length).toBe(1);
    expect(host.requests[0]?.input).toBe('帮我写一段 TypeScript 代码');
    expect(host.requests[0]?.sessionKey).toBe('wechat:room:room_001');
  });

  test('企业微信 WeCom 消息归一化与分派', async () => {
    const host = new StubHost();
    const channel = new WeChatChannel({
      host,
      channels: channelsOf({
        mode: 'wecom',
        wecom: {
          corpId: 'ww_test_corp',
          corpSecretEnv: 'WECHAT_WECOM_CORP_SECRET',
          agentId: 1000002,
          token: 'test_token',
          encodingAesKey: 'test_aes_key',
          webhookUrlEnv: 'WECHAT_WECOM_WEBHOOK_URL',
          bind: '127.0.0.1:8795',
          path: '/wecom-test',
        },
      }),
      limits,
      paths,
    });

    await channel.handleWeComWebhookMessage(
      '<xml><ToUserName><![CDATA[to_user]]></ToUserName><FromUserName><![CDATA[from_staff_01]]></FromUserName><CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[请审查代码]]></Content><MsgId>1234567890123456</MsgId></xml>',
    );

    await channel.stop();

    expect(host.requests.length).toBe(1);
    expect(host.requests[0]?.input).toBe('请审查代码');
    expect(host.requests[0]?.sessionKey).toBe('wecom:from_staff_01');
  });

  test('支持热重载通道配置并将新消息路由至新的 default_agent', async () => {
    const host = new StubHost();
    const driver: WeChatPersonalDriver = { start: async () => undefined, stop: async () => undefined, sendMessage: async () => undefined };
    const channel = new WeChatChannel({
      host,
      channels: channelsOf({ defaultAgent: 'coder' }),
      limits,
      paths,
      personalDriverFactory: () => driver,
    });

    await channel.start();

    // 第一次发送：使用初始配置中的 defaultAgent ('coder')
    await channel.handlePersonalMessage({
      id: 'm_reload_1',
      fromId: 'wx_user_reload_1',
      fromName: '测试用户1',
      isRoom: false,
      text: '任务一',
    });

    expect(host.requests.length).toBe(1);
    expect(host.requests[0]?.channelDefaultAgent).toBe('coder');

    // 热重载通道：将 defaultAgent 更新为 'writer'
    channel.reload({
      channels: channelsOf({ defaultAgent: 'writer' }),
    });

    // 第二次发送：应动态生效为 'writer'
    await channel.handlePersonalMessage({
      id: 'm_reload_2',
      fromId: 'wx_user_reload_2',
      fromName: '测试用户2',
      isRoom: false,
      text: '任务二',
    });

    expect(host.requests.length).toBe(2);
    expect(host.requests[1]?.channelDefaultAgent).toBe('writer');

    // 3) 若联系人配置了特定专属智能体，则以其 agentId 优先分派
    const { WeChatContactStore } = await import('../src/channels/wechat-contacts.js');
    const store = WeChatContactStore.getInstance(testContactsPath);
    store.upsertContact({
      id: 'wx_user_custom',
      name: '定制用户',
      agentId: 'writer',
      autoReply: true,
    });
    await channel.handlePersonalMessage({
      id: 'm_contact_1',
      fromId: 'wx_user_custom',
      fromName: '定制用户',
      isRoom: false,
      text: '定制任务',
    });

    await channel.stop();

    expect(host.requests.length).toBe(3);
    expect(host.requests[2]?.agentId).toBe('writer');
  });

  test('应当严格解耦聊天托管与机器人通道的 System Prompt 与角色定位', async () => {
    const host = new StubHost();

    // 1. 聊天托管模式 (personal + desktop_vision): 必须注入数字分身第一人称口吻与聊天规范
    const hostingChannels = channelsOf({
      mode: 'personal',
      personal: {
        puppet: 'desktop_vision',
      },
    });
    const mockDriverFactory = () => ({
      start: async () => undefined,
      stop: async () => undefined,
      sendMessage: async () => undefined,
    });
    const hostingChannel = new WeChatChannel({
      host,
      channels: hostingChannels,
      limits,
      paths,
      personalDriverFactory: mockDriverFactory,
    });
    await hostingChannel.start();

    await hostingChannel.handlePersonalMessage({
      id: 'msg_hosting_1',
      fromId: 'wx_friend_1',
      fromName: '测试好友',
      isRoom: false,
      text: '周末有空聚聚吗？',
    });

    expect(host.requests.length).toBe(1);
    const hostingPrompt = host.requests[0]?.systemPrompt;
    expect(hostingPrompt).toBeDefined();
    expect(hostingPrompt).toContain('【最高优先级指令：微信即时通讯数字分身】');
    expect(hostingPrompt).toContain('你就是本人，必须直接以第一人称回复');
    await hostingChannel.stop();

    // 2. 机器人模式 (ilink_bot): 绝不能注入数字分身第一人称口吻，作为专业 AI 智能体运行
    const botChannels = channelsOf({
      mode: 'ilink_bot',
      defaultAgent: 'coder',
    });
    const botChannel = new WeChatChannel({
      host,
      channels: botChannels,
      limits,
      paths,
      personalDriverFactory: mockDriverFactory,
    });
    await botChannel.start();

    await botChannel.handlePersonalMessage({
      id: 'msg_bot_1',
      fromId: 'wx_user_tech',
      fromName: '开发者用户',
      isRoom: false,
      text: '帮我写一段 TypeScript 防抖函数',
    });

    expect(host.requests.length).toBe(2);
    const botPrompt = host.requests[1]?.systemPrompt;
    // 机器人模式下不注入数字分身提示
    expect(botPrompt).toBeUndefined();
    await botChannel.stop();
  });
});

