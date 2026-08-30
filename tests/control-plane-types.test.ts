import { describe, expect, it } from 'vitest';
import {
  botAccountInputSchema,
  canTransitionRuntime,
  serverBotBindingInputSchema,
} from '../src/control-plane/index.js';

describe('control plane contracts', () => {
  it('rejects secrets in account metadata', () => {
    const parsed = botAccountInputSchema.safeParse({
      id: 'bot-a',
      platform: 'telegram',
      name: 'ops',
      enabled: false,
      credentialRef: 'bot-a',
      transport: 'polling',
      defaultAgentId: 'ops',
      token: 'secret',
    });

    expect(parsed.success).toBe(false);
  });

  it('does not allow saved config to jump to online', () => {
    expect(canTransitionRuntime('draft', 'online')).toBe(false);
    expect(canTransitionRuntime('starting', 'online')).toBe(true);
  });

  it('requires one explicit server and bot account per binding', () => {
    expect(serverBotBindingInputSchema.safeParse({
      id: 'bind-local',
      serverId: '',
      botAccountId: 'bot-a',
      capabilityProfile: 'operate',
      approvalPolicy: 'dangerous_local',
      alertPolicy: {},
    }).success).toBe(false);
  });
});
