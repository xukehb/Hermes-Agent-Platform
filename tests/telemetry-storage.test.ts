import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../src/storage/index.js';
import type { UsageTelemetryEvent } from '../src/telemetry/index.js';

const dirs: string[] = [];

function sqliteStore(): SqliteSessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'hap-telemetry-store-'));
  dirs.push(dir);
  return new SqliteSessionStore(join(dir, 'sessions.db'));
}

function usageEvent(patch: Partial<UsageTelemetryEvent> = {}): UsageTelemetryEvent {
  return {
    eventId: '00000000-0000-4000-8000-000000000001',
    sequence: 1,
    at: '2026-08-30T00:00:00.000Z',
    taskId: 'task-a',
    sessionKey: 'wechat:user:u1',
    agentId: 'ops',
    serverId: 'local',
    providerId: 'openai',
    model: 'openai/gpt-test',
    source: 'model_turn',
    promptTokens: 4,
    completionTokens: 6,
    totalTokens: 10,
    ...patch,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('usage telemetry storage', () => {
  it('does not double count the same usage event', () => {
    const store = sqliteStore();

    expect(store.recordUsageEvent?.(usageEvent())).toBe(true);
    expect(store.recordUsageEvent?.(usageEvent())).toBe(false);

    expect(store.queryUsage?.({ since: '2026-08-30T00:00:00.000Z' }).totals.totalTokens).toBe(10);
    store.close();
  });

  it('keeps legacy rows global but not local-server attributed', () => {
    const store = sqliteStore();
    store.recordUsage({
      at: '2026-08-30T00:00:00.000Z',
      agentId: 'ops',
      providerId: 'openai',
      model: 'openai/gpt-test',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });

    expect(store.queryUsage?.({ since: '2026-08-30T00:00:00.000Z' }).totals.totalTokens).toBe(10);
    expect(store.queryUsage?.({ since: '2026-08-30T00:00:00.000Z', serverId: 'local' }).totals.totalTokens).toBe(0);
    store.close();
  });
});
