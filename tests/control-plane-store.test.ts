import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore, type BotAccountInput, type ServerBotBindingInput } from '../src/control-plane/index.js';

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hap-control-store-'));
  dirs.push(dir);
  return join(dir, 'control.sqlite');
}

function account(id: string): BotAccountInput {
  return {
    id,
    platform: 'telegram',
    name: id,
    enabled: false,
    credentialRef: id,
    transport: 'polling',
    defaultAgentId: 'ops',
  };
}

function binding(id: string, serverId: string, botAccountId: string): ServerBotBindingInput {
  return {
    id,
    serverId,
    botAccountId,
    capabilityProfile: 'operate',
    approvalPolicy: 'dangerous_local',
    alertPolicy: { notify: true },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ControlPlaneStore', () => {
  it('enforces one account per server and one server per account', () => {
    const store = new ControlPlaneStore(tempDb());
    store.upsertAccount(account('bot-a'));
    store.upsertAccount(account('bot-b'));

    store.bind(binding('bind-a', 'local', 'bot-a'));

    expect(() => store.bind(binding('bind-b', 'local', 'bot-b'))).toThrow(/BINDING_CONFLICT/);
    expect(() => store.bind(binding('bind-c', 'remote-1', 'bot-a'))).toThrow(/BINDING_CONFLICT/);
    store.close();
  });

  it('replaces a binding transactionally', () => {
    const store = new ControlPlaneStore(tempDb());
    store.upsertAccount(account('bot-a'));
    store.upsertAccount(account('bot-b'));
    store.bind(binding('bind-a', 'local', 'bot-a'));

    store.replaceBinding('local', binding('bind-b', 'local', 'bot-b'));

    expect(store.bindingForServer('local')?.botAccountId).toBe('bot-b');
    expect(store.bindingForAccount('bot-a')).toBeUndefined();
    store.close();
  });

  it('persists accounts and bindings across reopen', () => {
    const path = tempDb();
    const first = new ControlPlaneStore(path);
    first.upsertAccount(account('bot-a'));
    first.bind(binding('bind-a', 'local', 'bot-a'));
    first.close();

    const second = new ControlPlaneStore(path);
    expect(second.account('bot-a')?.name).toBe('bot-a');
    expect(second.bindingForServer('local')?.botAccountId).toBe('bot-a');
    second.close();
  });
});
