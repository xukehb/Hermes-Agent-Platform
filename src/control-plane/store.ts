import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  botAccountInputSchema,
  botOperatorInputSchema,
  ControlPlaneError,
  serverBotBindingInputSchema,
  type BotAccount,
  type BotAccountInput,
  type BotOperator,
  type BotOperatorInput,
  type ServerBotBinding,
  type ServerBotBindingInput,
} from './types.js';

const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  `CREATE TABLE IF NOT EXISTS bot_accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    credential_ref TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL,
    default_agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS server_bot_bindings (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL UNIQUE,
    bot_account_id TEXT NOT NULL UNIQUE REFERENCES bot_accounts(id) ON DELETE CASCADE,
    capability_profile TEXT NOT NULL,
    approval_policy TEXT NOT NULL,
    alert_policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bot_operators (
    id TEXT PRIMARY KEY,
    bot_account_id TEXT NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
    platform_user_id TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(bot_account_id, platform_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    id TEXT PRIMARY KEY,
    bot_account_id TEXT NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES server_bot_bindings(id) ON DELETE CASCADE,
    operator_id TEXT NOT NULL REFERENCES bot_operators(id),
    request_id TEXT NOT NULL,
    command_kind TEXT NOT NULL,
    args_digest TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT
  )`,
];

interface AccountRecord {
  id: string;
  platform: BotAccount['platform'];
  name: string;
  enabled: 0 | 1;
  credential_ref: string;
  transport: BotAccount['transport'];
  default_agent_id: string;
  created_at: string;
  updated_at: string;
}

interface BindingRecord {
  id: string;
  server_id: string;
  bot_account_id: string;
  capability_profile: ServerBotBinding['capabilityProfile'];
  approval_policy: ServerBotBinding['approvalPolicy'];
  alert_policy_json: string;
  created_at: string;
  updated_at: string;
}

interface OperatorRecord {
  id: string;
  bot_account_id: string;
  platform_user_id: string;
  display_name: string | null;
  role: BotOperator['role'];
  paired_at: string;
  revoked_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && String((error as { code?: unknown }).code) === 'SQLITE_CONSTRAINT_UNIQUE';
}

function toAccount(record: AccountRecord): BotAccount {
  return {
    id: record.id,
    platform: record.platform,
    name: record.name,
    enabled: record.enabled === 1,
    credentialRef: record.credential_ref,
    transport: record.transport,
    defaultAgentId: record.default_agent_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toBinding(record: BindingRecord): ServerBotBinding {
  return {
    id: record.id,
    serverId: record.server_id,
    botAccountId: record.bot_account_id,
    capabilityProfile: record.capability_profile,
    approvalPolicy: record.approval_policy,
    alertPolicy: JSON.parse(record.alert_policy_json) as Record<string, unknown>,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toOperator(record: OperatorRecord): BotOperator {
  const operator: BotOperator = {
    id: record.id,
    botAccountId: record.bot_account_id,
    platformUserId: record.platform_user_id,
    role: record.role,
    pairedAt: record.paired_at,
  };
  if (record.display_name !== null) operator.displayName = record.display_name;
  if (record.revoked_at !== null) operator.revokedAt = record.revoked_at;
  return operator;
}

export class ControlPlaneStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    for (const statement of SCHEMA) this.db.exec(statement);
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(input: BotAccountInput): BotAccount {
    const account = botAccountInputSchema.parse(input);
    const existing = this.account(account.id);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    try {
      this.db.prepare(
        `INSERT INTO bot_accounts
          (id, platform, name, enabled, credential_ref, transport, default_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          platform = excluded.platform,
          name = excluded.name,
          enabled = excluded.enabled,
          credential_ref = excluded.credential_ref,
          transport = excluded.transport,
          default_agent_id = excluded.default_agent_id,
          updated_at = excluded.updated_at`,
      ).run(
        account.id,
        account.platform,
        account.name,
        account.enabled ? 1 : 0,
        account.credentialRef,
        account.transport,
        account.defaultAgentId,
        createdAt,
        updatedAt,
      );
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new ControlPlaneError('CONTROL_SCHEMA', 'CONTROL_SCHEMA: credential reference already exists');
      }
      throw error;
    }
    return this.account(account.id)!;
  }

  account(id: string): BotAccount | undefined {
    const row = this.db.prepare('SELECT * FROM bot_accounts WHERE id = ?').get(id) as AccountRecord | undefined;
    return row === undefined ? undefined : toAccount(row);
  }

  bind(input: ServerBotBindingInput): ServerBotBinding {
    const binding = serverBotBindingInputSchema.parse(input);
    if (this.account(binding.botAccountId) === undefined) {
      throw new ControlPlaneError('BOT_ACCOUNT_NOT_FOUND', 'BOT_ACCOUNT_NOT_FOUND: ' + binding.botAccountId);
    }
    const now = nowIso();
    try {
      this.db.prepare(
        `INSERT INTO server_bot_bindings
          (id, server_id, bot_account_id, capability_profile, approval_policy, alert_policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        binding.id,
        binding.serverId,
        binding.botAccountId,
        binding.capabilityProfile,
        binding.approvalPolicy,
        JSON.stringify(binding.alertPolicy),
        now,
        now,
      );
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new ControlPlaneError('BINDING_CONFLICT', 'BINDING_CONFLICT: server and bot accounts must bind one-to-one');
      }
      throw error;
    }
    return this.bindingForServer(binding.serverId)!;
  }

  replaceBinding(serverId: string, input: ServerBotBindingInput): ServerBotBinding {
    const binding = serverBotBindingInputSchema.parse(input);
    if (binding.serverId !== serverId) {
      throw new ControlPlaneError('CONTROL_SCHEMA', 'CONTROL_SCHEMA: replacement server mismatch');
    }
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM server_bot_bindings WHERE server_id = ?').run(serverId);
      this.db.prepare('DELETE FROM server_bot_bindings WHERE bot_account_id = ?').run(binding.botAccountId);
      return this.bind(binding);
    });
    return replace() as ServerBotBinding;
  }

  bindingForServer(serverId: string): ServerBotBinding | undefined {
    const row = this.db.prepare('SELECT * FROM server_bot_bindings WHERE server_id = ?').get(serverId) as BindingRecord | undefined;
    return row === undefined ? undefined : toBinding(row);
  }

  bindingForAccount(accountId: string): ServerBotBinding | undefined {
    const row = this.db.prepare('SELECT * FROM server_bot_bindings WHERE bot_account_id = ?').get(accountId) as BindingRecord | undefined;
    return row === undefined ? undefined : toBinding(row);
  }

  upsertOperator(input: BotOperatorInput): BotOperator {
    const operator = botOperatorInputSchema.parse(input);
    if (this.account(operator.botAccountId) === undefined) {
      throw new ControlPlaneError('BOT_ACCOUNT_NOT_FOUND', 'BOT_ACCOUNT_NOT_FOUND: ' + operator.botAccountId);
    }
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO bot_operators
        (id, bot_account_id, platform_user_id, display_name, role, paired_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        role = excluded.role,
        revoked_at = NULL`,
    ).run(operator.id, operator.botAccountId, operator.platformUserId, operator.displayName ?? null, operator.role, now);
    return this.operator(operator.id)!;
  }

  operator(id: string): BotOperator | undefined {
    const row = this.db.prepare('SELECT * FROM bot_operators WHERE id = ?').get(id) as OperatorRecord | undefined;
    return row === undefined ? undefined : toOperator(row);
  }

  operatorForPlatformUser(botAccountId: string, platformUserId: string): BotOperator | undefined {
    const row = this.db.prepare(
      'SELECT * FROM bot_operators WHERE bot_account_id = ? AND platform_user_id = ? AND revoked_at IS NULL',
    ).get(botAccountId, platformUserId) as OperatorRecord | undefined;
    return row === undefined ? undefined : toOperator(row);
  }
}
