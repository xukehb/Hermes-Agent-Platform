import { describe, expect, it, vi } from 'vitest';
import { TelemetryService, type UsageTelemetryEvent } from '../src/telemetry/index.js';

function event(patch: Partial<UsageTelemetryEvent> = {}): UsageTelemetryEvent {
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

describe('TelemetryService', () => {
  it('persists before publishing and updates active totals once', () => {
    const order: string[] = [];
    const service = new TelemetryService({
      recordUsageEvent: () => {
        order.push('persist');
        return true;
      },
    });
    service.subscribe(() => order.push('publish'));

    service.record(event({ totalTokens: 7, promptTokens: 3, completionTokens: 4 }));
    service.record(event({ totalTokens: 7, promptTokens: 3, completionTokens: 4 }));

    expect(order).toEqual(['persist', 'publish', 'persist']);
    expect(service.snapshot().activeTasks[0]?.totalTokens).toBe(7);
  });

  it('reports degraded telemetry instead of a false zero', () => {
    const service = new TelemetryService({
      recordUsageEvent: vi.fn(() => {
        throw new Error('disk full');
      }),
    });

    expect(() => service.record(event())).not.toThrow();
    expect(service.snapshot().status.kind).toBe('degraded');
  });
});
