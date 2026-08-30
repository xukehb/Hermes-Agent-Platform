import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const accountIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);
const stateNames = ['account.json', 'sync.json', 'context-tokens.json', 'inbound-dedupe.json'] as const;
type StateName = typeof stateNames[number];

const ilinkAccountStateSchema = z.strictObject({
  botToken: z.string().min(1),
  ilinkBotId: z.string().min(1),
  loginUserId: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  updatedAt: z.string().datetime(),
});

export type IlinkAccountState = z.infer<typeof ilinkAccountStateSchema>;

const syncStateSchema = z.strictObject({
  cursor: z.string(),
});

const contextStateSchema = z.record(z.string(), z.string());
const dedupeStateSchema = z.record(z.string(), z.number().int().nonnegative());

function atomicWriteJson(temp: string, target: string, value: unknown): void {
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  if (process.platform !== 'win32') chmodSync(target, 0o600);
}

export class IlinkAccountStore {
  private readonly accountDir: string;
  private readonly now: () => number;

  constructor(root: string, accountId: string, options: { now?: () => number } = {}) {
    const id = accountIdSchema.parse(accountId);
    this.accountDir = join(root, 'accounts', id);
    this.now = options.now ?? (() => Date.now());
    mkdirSync(this.accountDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.accountDir, 0o700);
  }

  saveAccount(account: IlinkAccountState): void {
    this.writeJson('account.json', ilinkAccountStateSchema.parse(account));
  }

  loadAccount(): IlinkAccountState | undefined {
    return this.readJson('account.json', ilinkAccountStateSchema);
  }

  saveCursor(cursor: string): void {
    this.writeJson('sync.json', syncStateSchema.parse({ cursor }));
  }

  loadCursor(): string {
    return this.readJson('sync.json', syncStateSchema)?.cursor ?? '';
  }

  putContext(peerId: string, contextToken: string): void {
    const state = this.readJson('context-tokens.json', contextStateSchema) ?? {};
    state[peerId] = contextToken;
    this.writeJson('context-tokens.json', state);
  }

  contextFor(peerId: string): string | undefined {
    return (this.readJson('context-tokens.json', contextStateSchema) ?? {})[peerId];
  }

  markInboundSeen(messageId: string): boolean {
    const cutoff = this.now() - 86_400_000;
    const state = this.readJson('inbound-dedupe.json', dedupeStateSchema) ?? {};
    for (const [key, seenAt] of Object.entries(state)) {
      if (seenAt < cutoff) delete state[key];
    }
    if (state[messageId] !== undefined) return false;
    state[messageId] = this.now();
    this.writeJson('inbound-dedupe.json', state);
    return true;
  }

  private readJson<T>(name: StateName, schema: z.ZodType<T>): T | undefined {
    const path = join(this.accountDir, name);
    if (!existsSync(path)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return schema.parse(raw);
    } catch {
      const corrupt = join(this.accountDir, `${name}.corrupt.${Date.now()}`);
      try {
        renameSync(path, corrupt);
      } catch {
        // Leave the original in place when quarantine fails.
      }
      throw new Error('ILINK_STATE_CORRUPT: ' + name);
    }
  }

  private writeJson(name: StateName, value: unknown): void {
    const target = join(this.accountDir, name);
    const temp = join(this.accountDir, `.${name}.${randomUUID()}.tmp`);
    atomicWriteJson(temp, target, value);
  }
}
