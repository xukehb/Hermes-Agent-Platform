/**
 * Telegram 通道测试：驱动真实的 grammy Bot，只把 Bot API 的 HTTP 出口换成假实现。
 *
 * 为什么必须单独测这一层：Telegram 是手机端唯一入口，而此前的通道测试都停在
 * ChannelDispatcher，没有覆盖「平台 update → 归一化 → 回写」这段。
 * 唤起词剥离、会话键构造、4096 字符分片、编辑幂等错误吞并、附件识别，
 * 全部只在 TelegramChannel 内部执行。
 *
 * 约束：不产生真实网络连接。grammy 的 client.buildUrl + fetch 被整体接管。
 *
 * 日期：2026-08-24  执行者：Codex
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from 'grammy/types';

import { TelegramChannel, describeAttachments } from '../src/channels/index.js';
import type { ChannelHost } from '../src/channels/index.js';
import { BUILTIN_CHANNELS, BUILTIN_LIMITS } from '../src/config/index.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../src/config/index.js';
import type { RunTaskRequest, SessionStatus, TaskOutcome, TraceSummary, UsageAggregate } from '../src/agent/index.js';

const root = mkdtempSync(join(tmpdir(), 'hap-tg-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const paths: ResolvedPaths = {
  dataDir: root,
  traceDir: join(root, 'traces'),
  overflowDir: join(root, 'overflow'),
  spoolDir: join(root, 'spool'),
};

const limits: ResolvedLimits = {
  ...BUILTIN_LIMITS,
  providerConcurrency: {},
  providerRpm: {},
  agentConcurrency: {},
  agentRpm: {},
};

/** 一次被拦下的 Bot API 调用。 */
interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function channelsOf(patch: Partial<ResolvedChannels['telegram']> = {}): ResolvedChannels {
  return {
    editIntervalMs: 0,
    asyncThresholdMs: BUILTIN_CHANNELS.asyncThresholdMs,
    telegram: {
      enabled: true,
      tokenEnv: 'TG_TEST_TOKEN',
      mode: 'polling',
      defaultAgent: 'coder',
      mentionPatterns: [...BUILTIN_CHANNELS.telegram.mentionPatterns],
      messageCharLimit: BUILTIN_CHANNELS.telegram.messageCharLimit,
      webhook: undefined,
      ...patch,
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
    wechat: BUILTIN_CHANNELS.wechat,
    http: { enabled: false, bind: '127.0.0.1:8798', defaultAgent: undefined },
    cli: { enabled: false, defaultAgent: undefined },
  };
}

/** 宿主桩：记录收到的任务请求，回固定终态。 */
class StubHost implements ChannelHost {
  readonly requests: RunTaskRequest[] = [];
  readonly cleared: string[] = [];
  text = '已完成';

  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
   this.requests.push(request);
    if (request.onEvent !== undefined) {
      request.onEvent({ type: 'text', text: this.text });
    }
   return {
     taskId: 'task-tg-1',
      agentId: request.agentId ?? 'coder',
      sessionKey: request.sessionKey ?? 'chat:777',
      status: 'done',
      tracePath: join(root, 'traces', 'task-tg-1.jsonl'),
      text: this.text,
      reasoning: '',
      messages: [],
     usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      iterations: 1,
      model: 'deepseek/deepseek-chat',
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
      model: 'deepseek/deepseek-chat',
      chain: ['deepseek/deepseek-chat'],
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

  clearSession(sessionKey: string): void {
    this.cleared.push(sessionKey);
  }

  usageSince(): UsageAggregate[] {
    return [];
  }
}

/** 建好通道并接管其 Bot API 出口。返回的 calls 会按序记录每次调用。 */
function harness(patch: Partial<ResolvedChannels['telegram']> = {}): {
  channel: TelegramChannel;
  host: StubHost;
  calls: ApiCall[];
} {
  const host = new StubHost();
  const channel = new TelegramChannel({
    host,
    channels: channelsOf(patch),
    limits,
    paths,
    env: { TG_TEST_TOKEN: '12345:fake-token' },
  });
  const calls: ApiCall[] = [];
  installFakeApi(channel, calls);
  return { channel, host, calls };
}

/**
 * 接管 grammy 的 API 出口。
 *
 * grammy 把 method 编在 URL 末段，因此这里用 buildUrl 保留方法名，
 * 由假 fetch 解析出来并回一个形状正确的 Telegram 响应。
 */
function installFakeApi(channel: TelegramChannel, calls: ApiCall[], failEdit?: string): void {
  let messageId = 100;
  const bot = (channel as unknown as { bot: { api: { config: { use: (fn: unknown) => void } } } }).bot;
  bot.api.config.use(async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === 'editMessageText' && failEdit !== undefined) {
      throw new Error(failEdit);
    }
    if (method === 'sendMessage') {
      messageId += 1;
      return { ok: true, result: { message_id: messageId, chat: { id: payload['chat_id'] }, text: payload['text'] } };
    }
    if (method === 'getMe') {
      return { ok: true, result: { id: 1, is_bot: true, first_name: 'hap', username: 'hap_bot' } };
    }
    return { ok: true, result: true };
  });
}

/** 取出所有 sendMessage 的正文。 */
function sentTexts(calls: readonly ApiCall[]): string[] {
  return calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.payload['text'] ?? ''));
}

/** 构造一条最小可用的平台消息。 */
function updateOf(text: string, chatId = 777): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 5,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: 42, is_bot: false, first_name: '用户' },
      text,
    },
  };
}

/** 把一条 update 灌进 bot 并等待分派完成。 */
async function feed(channel: TelegramChannel, update: Record<string, unknown>): Promise<void> {
  const bot = (channel as unknown as { bot: { init: () => Promise<void>; handleUpdate: (u: unknown) => Promise<void> } }).bot;
  await bot.init();
  await bot.handleUpdate(update);
  const dispatcher = (channel as unknown as { dispatcher: { drain: () => Promise<void> } }).dispatcher;
  await dispatcher.drain();
}

describe('TelegramChannel 构造期校验', () => {
  it('缺少 token 环境变量时明确报错并回显变量名', () => {
    let message = '';
    try {
      new TelegramChannel({
        host: new StubHost(),
        channels: channelsOf(),
        limits,
        paths,
        env: {},
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('TG_TEST_TOKEN');
  });

  it('webhook 模式缺少 webhook 配置时拒绝启动', () => {
    let message = '';
    try {
      new TelegramChannel({
        host: new StubHost(),
        channels: channelsOf({ mode: 'webhook', webhook: undefined }),
        limits,
        paths,
        env: { TG_TEST_TOKEN: '12345:fake-token' },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('webhook');
  });
});

describe('TelegramChannel 收发闭环', () => {
  it('普通文本被路由到默认智能体，会话键按 chat 隔离，终态回写到同一 chat', async () => {
    const { channel, host, calls } = harness();

    await feed(channel, updateOf('帮我看下这段代码'));

    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]?.sessionKey).toBe('chat:777');
    expect(host.requests[0]?.input).toBe('帮我看下这段代码');
   expect(host.requests[0]?.channelDefaultAgent).toBe('coder');
    const sends = calls.filter((call) => call.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    expect(String(sends[0]?.payload['chat_id'])).toBe('777');
  });

  it('唤起词被剥离并解析为显式智能体路由', async () => {
    const { channel, host } = harness();

   await feed(channel, updateOf('@hap @writer 写一段周报'));

    expect(host.requests[0]?.agentId).toBe('writer');
    expect(host.requests[0]?.input).toBe('写一段周报');
  });

  it('不同 chat 得到彼此独立的会话键', async () => {
    const { channel, host } = harness();

    await feed(channel, updateOf('第一条', 111));
    await feed(channel, updateOf('第二条', 222));

    expect(host.requests.map((request) => request.sessionKey)).toEqual(['chat:111', 'chat:222']);
  });

  it('/new 走命令分派并清空该会话历史，不进入任务执行', async () => {
    const { channel, host } = harness();

    await feed(channel, updateOf('/new'));

    expect(host.cleared).toEqual(['chat:777']);
    expect(host.requests).toHaveLength(0);
  });

  it('/agents 直接回智能体列表而不调用模型', async () => {
    const { channel, host, calls } = harness();

    await feed(channel, updateOf('/agents'));

    expect(host.requests).toHaveLength(0);
    expect(sentTexts(calls).join('')).toContain('coder');
  });

  it('超过单条字符上限的回复被切成多条发送', async () => {
    const { channel, host, calls } = harness({ messageCharLimit: 60 });
    host.text = '甲'.repeat(150);

    await feed(channel, updateOf('来一段长文'));

    const texts = sentTexts(calls);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('TelegramChannel 回写容错', () => {
  it('编辑遇到 message is not modified 时视为成功，不抛给上层', async () => {
    const host = new StubHost();
    const channel = new TelegramChannel({
      host,
      channels: channelsOf(),
      limits,
      paths,
      env: { TG_TEST_TOKEN: '12345:fake-token' },
    });
    const calls: ApiCall[] = [];
    installFakeApi(channel, calls, 'Bad Request: message is not modified');

    const target = (channel as unknown as { target: (id: string) => { send: (t: string) => Promise<string>; edit: (id: string, t: string) => Promise<boolean> } }).target('777');
    const messageId = await target.send('第一版');

    await expect(target.edit(messageId, '第二版')).resolves.toBe(true);
  });

  it('编辑遇到真实错误时向上抛出，不静默吞掉', async () => {
    const host = new StubHost();
    const channel = new TelegramChannel({
      host,
      channels: channelsOf(),
      limits,
      paths,
      env: { TG_TEST_TOKEN: '12345:fake-token' },
    });
    const calls: ApiCall[] = [];
    installFakeApi(channel, calls, 'Bad Request: chat not found');

    const target = (channel as unknown as { target: (id: string) => { send: (t: string) => Promise<string>; edit: (id: string, t: string) => Promise<boolean> } }).target('777');
    const messageId = await target.send('第一版');

    await expect(target.edit(messageId, '第二版')).rejects.toThrow('chat not found');
  });
});

describe('describeAttachments 附件识别', () => {
  it('图片取分辨率最高的一档', () => {
    const message = {
      message_id: 1,
      date: 1,
      chat: { id: 1, type: 'private' },
      photo: [
        { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 100 },
        { file_id: 'large', file_unique_id: 'u2', width: 1280, height: 1280, file_size: 9000 },
      ],
    } as unknown as Message;

    const specs = describeAttachments(message);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.fileId).toBe('large');
    expect(specs[0]?.kind).toBe('image');
  });

  it('文档保留原始文件名与 MIME', () => {
    const message = {
      message_id: 1,
      date: 1,
      chat: { id: 1, type: 'private' },
      document: { file_id: 'doc1', file_unique_id: 'u3', file_name: '需求.md', mime_type: 'text/markdown' },
    } as unknown as Message;

    const specs = describeAttachments(message);
    expect(specs[0]?.name).toBe('需求.md');
    expect(specs[0]?.mimeType).toBe('text/markdown');
    expect(specs[0]?.kind).toBe('document');
  });

  it('语音被识别为 audio', () => {
    const message = {
      message_id: 1,
      date: 1,
      chat: { id: 1, type: 'private' },
      voice: { file_id: 'v1', file_unique_id: 'u4', duration: 3, mime_type: 'audio/ogg' },
    } as unknown as Message;

    expect(describeAttachments(message)[0]?.kind).toBe('audio');
  });

  it('纯文本消息不产生附件', () => {
    const message = {
      message_id: 1,
      date: 1,
      chat: { id: 1, type: 'private' },
      text: '没有附件',
    } as unknown as Message;

    expect(describeAttachments(message)).toEqual([]);
  });
});
