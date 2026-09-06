import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ControlPlaneError,
  operatorRoleSchema,
  type BotOperator,
  type ControlExecutionContext,
  type OperatorRole,
} from './types.js';
import type { ControlPlaneStore } from './store.js';

const readOnlyCommands = new Set([
  'help', 'status', 'trace', 'usage', 'models', 'agents', 'projects',
  'skills', 'plugins', 'agent', 'git', 'diff', 'model',
]);
const operateCommands = new Set(['prompt', 'shell', 'commit', 'push', 'project', 'model_switch', 'stop', 'new', 'reload']);

/**
 * Control-plane policy is intentionally default-deny.  The capability profile
 * is an upper bound even for admins, so an observe binding cannot be upgraded
 * by changing the paired operator's role.
 */
export function isCommandAllowed(
  role: OperatorRole,
  profile: 'observe' | 'operate',
  commandKind: string,
): boolean {
  if (readOnlyCommands.has(commandKind)) return true;
  if (!operateCommands.has(commandKind)) return false;
  return profile === 'operate' && role !== 'viewer';
}

export interface PairingCodeIssue {
  id: string;
  code: string;
  expiresAt: string;
}

export interface AuthorizeInboundInput {
  botAccountId: string;
  platformUserId: string;
  requestId: string;
  commandKind: string;
}

export class BotAuthorizationService {
  private readonly store: ControlPlaneStore;
  private readonly now: () => Date;

  constructor(store: ControlPlaneStore, options: { now?: () => Date } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
  }

  issuePairingCode(input: { botAccountId: string; role: OperatorRole; ttlMs: number }): PairingCodeIssue {
    const role = operatorRoleSchema.parse(input.role);
    const ttlMs = z.number().int().positive().max(86_400_000).parse(input.ttlMs);
    const code = this.generateCode();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    const id = randomUUID();
    this.store.createPairingCode({
      id,
      botAccountId: input.botAccountId,
      codeHash: this.hash(input.botAccountId, code),
      role,
      expiresAt,
    });
    return { id, code, expiresAt };
  }

  consumePairingCode(input: {
    botAccountId: string;
    code: string;
    platformUserId: string;
    displayName?: string;
  }): BotOperator {
    const code = z.string().regex(/^[0-9]{6}$/).parse(input.code);
    const consumedAt = this.now().toISOString();
    const pairing = this.store.consumePairingCode(input.botAccountId, this.hash(input.botAccountId, code), consumedAt);
    if (pairing === undefined) {
      throw new ControlPlaneError('PAIRING_CODE_INVALID', 'PAIRING_CODE_INVALID: pairing code is invalid or already used');
    }
    if (Date.parse(pairing.expiresAt) <= this.now().getTime()) {
      throw new ControlPlaneError('PAIRING_CODE_EXPIRED', 'PAIRING_CODE_EXPIRED: pairing code expired');
    }
    const operatorInput = {
      id: 'op-' + randomUUID().replaceAll('-', '').slice(0, 24),
      botAccountId: input.botAccountId,
      platformUserId: input.platformUserId,
      role: pairing.role,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    };
    return this.store.upsertOperator(operatorInput);
  }

  authorizeInbound(input: AuthorizeInboundInput): ControlExecutionContext {
    const binding = this.store.bindingForAccount(input.botAccountId);
    const operator = this.store.operatorForPlatformUser(input.botAccountId, input.platformUserId);
    if (binding === undefined || operator === undefined) {
      throw new ControlPlaneError('CONTROL_FORBIDDEN', 'CONTROL_FORBIDDEN: bot user is not paired with this server');
    }
    if (!isCommandAllowed(operator.role, binding.capabilityProfile, input.commandKind)) {
      throw new ControlPlaneError('CONTROL_FORBIDDEN', 'CONTROL_FORBIDDEN: command is not allowed for this operator or binding');
    }
    return {
      accountId: input.botAccountId,
      bindingId: binding.id,
      serverId: binding.serverId,
      operatorId: operator.id,
      role: operator.role,
      capabilityProfile: binding.capabilityProfile,
      requestId: input.requestId,
      approvalPolicy: binding.approvalPolicy,
    };
  }

  private generateCode(): string {
    const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
    return value.toString().padStart(6, '0');
  }

  private hash(botAccountId: string, code: string): string {
    return createHash('sha256').update(botAccountId).update(':').update(code).digest('hex');
  }
}
