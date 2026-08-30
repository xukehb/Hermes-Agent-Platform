import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WeChatChannel, type WeChatPersonalDriver } from '../src/channels/wechat.js';
import type { ChannelHost, InboundMessage } from '../src/channels/types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../src/config/index.js';
import { BUILTIN_CHANNELS, BUILTIN_LIMITS } from '../src/config/index.js';
import type { RunTaskRequest, TaskOutcome, SessionStatus, TraceSummary, UsageAggregate } from '../src/agent/index.js';

const root = mkdtempSync(join(tmpdir(), 'hap-wx-'));

function channelsOf(patch: Partial<ResolvedChannels['wechat']> = {}): ResolvedChannels {
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
});
