import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WhatsAppChannel } from '../src/channels/whatsapp.js';
import type { ChannelHost, InboundMessage } from '../src/channels/types.js';
import type { ResolvedChannels, ResolvedLimits, ResolvedPaths } from '../src/config/index.js';
import { BUILTIN_CHANNELS, BUILTIN_LIMITS } from '../src/config/index.js';
import type { RunTaskRequest, TaskOutcome, SessionStatus, TraceSummary, UsageAggregate } from '../src/agent/index.js';

const root = mkdtempSync(join(tmpdir(), 'hap-wa-'));

afterEach(() => {
  // 每个用例独立目录；这里只清 root 下临时子项
});

function channelsOf(patch: Partial<ResolvedChannels['whatsapp']> = {}): ResolvedChannels {
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
      enabled: true,
      authDir: join(root, 'wa-auth'),
      defaultAgent: undefined,
      mentionPatterns: [],
      messageCharLimit: 4096,
      reconnectInitialMs: 1000,
      reconnectMaxMs: 30000,
      qrLog: false,
      ...patch,
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
      taskId: 'task-wa-1',
      agentId: request.agentId ?? 'coder',
      sessionKey: request.sessionKey ?? 'whatsapp:x',
      status: 'done',
      tracePath: '',
      text: '完成',
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

describe('WhatsAppChannel 基础行为', () => {
  test('构造成功且 name 为 whatsapp', () => {
    const channel = new WhatsAppChannel({
      host: new StubHost(),
      channels: channelsOf(),
      limits,
      paths,
    });
    expect(channel.name).toBe('whatsapp');
  });

  test('notify 在未连接时静默失败不抛出', async () => {
    const channel = new WhatsAppChannel({
      host: new StubHost(),
      channels: channelsOf(),
      limits,
      paths,
    });
    await channel.notify('5511999999999@s.whatsapp.net', 'hello');
  });

  test('stop 未启动时为 no-op', async () => {
    const channel = new WhatsAppChannel({
      host: new StubHost(),
      channels: channelsOf(),
      limits,
      paths,
    });
    await channel.stop();
  });
});
