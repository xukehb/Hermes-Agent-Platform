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
import { accountIdSchema } from './types.js';

export interface CredentialSummary {
  configured: boolean;
  fields: string[];
}

function assertCredentialValue(value: unknown): asserts value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('CONTROL_CREDENTIALS_INVALID');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '' || typeof entry !== 'string') throw new Error('CONTROL_CREDENTIALS_INVALID');
  }
}

export class BotCredentialStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  write(accountId: string, credentials: Record<string, string>): void {
    const id = accountIdSchema.parse(accountId);
    assertCredentialValue(credentials);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.root, 0o700);

    const target = this.pathForTest(id);
    const temp = join(this.root, `.${id}.${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(credentials, null, 2));
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

  read(accountId: string): Record<string, string> | undefined {
    const id = accountIdSchema.parse(accountId);
    const path = this.pathForTest(id);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    assertCredentialValue(parsed);
    return parsed;
  }

  summary(accountId: string): CredentialSummary {
    const credentials = this.read(accountId);
    if (credentials === undefined) return { configured: false, fields: [] };
    return { configured: true, fields: Object.keys(credentials).sort() };
  }

  pathForTest(accountId: string): string {
    const id = accountIdSchema.parse(accountId);
    return join(this.root, `${id}.json`);
  }
}
