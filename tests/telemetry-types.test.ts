import { describe, expect, it } from 'vitest';
import { usageTelemetryEventSchema } from '../src/telemetry/index.js';

function event(patch: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('telemetry contracts', () => {
  it('requires non-negative safe integer token counts', () => {
    expect(usageTelemetryEventSchema.safeParse(event({ totalTokens: -1 })).success).toBe(false);
    expect(usageTelemetryEventSchema.safeParse(event({ totalTokens: Number.MAX_VALUE })).success).toBe(false);
  });

  it('requires explicit server attribution', () => {
    const input = event();
    delete input.serverId;
    expect(usageTelemetryEventSchema.safeParse(input).success).toBe(false);
  });
});
