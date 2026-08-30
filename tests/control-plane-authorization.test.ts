import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BotAuthorizationService,
  ControlPlaneStore,
  type BotAccountInput,
  type ServerBotBindingInput,
} from '../src/control-plane/index.js';

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hap-control-auth-'));
  dirs.push(dir);
  return join(dir, 'control.sqlite');
}

function account(id: string): BotAccountInput {
  return {
    id,
    platform: 'telegram',
    name: id,
    enabled: true,
    credentialRef: id,
    transport: 'polling',
    defaultAgentId: 'ops',
  };
}

function binding(id: string, serverId: string, botAccountId: string, capabilityProfile: 'observe' | 'operate' = 'operate'): ServerBotBindingInput {
  return {
    id,
    serverId,
    botAccountId,
    capabilityProfile,
    approvalPolicy: 'dangerous_local',
    alertPolicy: {},
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('BotAuthorizationService', () => {
  it('rejects unpaired platform users by default', () => {
    const store = new ControlPlaneStore(tempDb());
    store.upsertAccount(account('bot-a'));
    store.bind(binding('bind-a', 'local', 'bot-a'));
    const auth = new BotAuthorizationService(store);

    expect(() => auth.authorizeInbound({
      botAccountId: 'bot-a',
      platformUserId: 'u1',
      requestId: 'req-1',
      commandKind: 'prompt',
    })).toThrow(/CONTROL_FORBIDDEN/);
    store.close();
  });

  it('pairs an operator with a one-time code and then rejects code reuse', () => {
    const store = new ControlPlaneStore(tempDb());
    store.upsertAccount(account('bot-a'));
    store.bind(binding('bind-a', 'local', 'bot-a'));
    const auth = new BotAuthorizationService(store, { now: () => new Date('2026-08-30T00:00:00.000Z') });
    const issued = auth.issuePairingCode({ botAccountId: 'bot-a', role: 'operator', ttlMs: 60_000 });

    const operator = auth.consumePairingCode({
      botAccountId: 'bot-a',
      code: issued.code,
      platformUserId: 'u1',
      displayName: 'User One',
    });

    expect(operator.role).toBe('operator');
    expect(() => auth.consumePairingCode({
      botAccountId: 'bot-a',
      code: issued.code,
      platformUserId: 'u2',
    })).toThrow(/PAIRING_CODE_INVALID/);
    store.close();
  });

  it('allows observe-only commands but blocks operations for viewer bindings', () => {
    const store = new ControlPlaneStore(tempDb());
    store.upsertAccount(account('bot-a'));
    store.bind(binding('bind-a', 'local', 'bot-a', 'observe'));
    store.upsertOperator({ id: 'op-a', botAccountId: 'bot-a', platformUserId: 'u1', role: 'viewer' });
    const auth = new BotAuthorizationService(store);

    const status = auth.authorizeInbound({
      botAccountId: 'bot-a',
      platformUserId: 'u1',
      requestId: 'req-1',
      commandKind: 'status',
    });
    expect(status.serverId).toBe('local');
    expect(() => auth.authorizeInbound({
      botAccountId: 'bot-a',
      platformUserId: 'u1',
      requestId: 'req-2',
      commandKind: 'shell',
    })).toThrow(/CONTROL_FORBIDDEN/);
    store.close();
  });
});
