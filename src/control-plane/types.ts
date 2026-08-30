import { z } from 'zod';

export const accountIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);

export const botPlatformSchema = z.enum(['wechat_ilink', 'telegram', 'feishu']);
export type BotPlatform = z.infer<typeof botPlatformSchema>;

export const runtimeStatusSchema = z.enum([
  'draft',
  'validating',
  'stopped',
  'starting',
  'online',
  'reconnecting',
  'auth_required',
  'error',
]);
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const botAccountInputSchema = z.strictObject({
  id: accountIdSchema,
  platform: botPlatformSchema,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  credentialRef: accountIdSchema,
  transport: z.enum(['ilink', 'polling', 'websocket', 'webhook']),
  defaultAgentId: z.string().trim().min(1),
});
export type BotAccountInput = z.infer<typeof botAccountInputSchema>;

export interface BotAccount extends BotAccountInput {
  createdAt: string;
  updatedAt: string;
}

export const capabilityProfileSchema = z.enum(['observe', 'operate']);
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;

export const approvalPolicySchema = z.enum(['none', 'dangerous_local', 'all_local']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const serverBotBindingInputSchema = z.strictObject({
  id: accountIdSchema,
  serverId: z.string().trim().min(1),
  botAccountId: accountIdSchema,
  capabilityProfile: capabilityProfileSchema,
  approvalPolicy: approvalPolicySchema,
  alertPolicy: z.record(z.string(), z.unknown()).default({}),
});
export type ServerBotBindingInput = z.infer<typeof serverBotBindingInputSchema>;

export interface ServerBotBinding extends ServerBotBindingInput {
  createdAt: string;
  updatedAt: string;
}

export const operatorRoleSchema = z.enum(['viewer', 'operator', 'admin']);
export type OperatorRole = z.infer<typeof operatorRoleSchema>;

export const botOperatorInputSchema = z.strictObject({
  id: accountIdSchema,
  botAccountId: accountIdSchema,
  platformUserId: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: operatorRoleSchema,
});
export type BotOperatorInput = z.infer<typeof botOperatorInputSchema>;

export interface BotOperator extends BotOperatorInput {
  pairedAt: string;
  revokedAt?: string;
}

export interface ControlExecutionContext {
  accountId: string;
  bindingId: string;
  serverId: string;
  operatorId: string;
  role: OperatorRole;
  capabilityProfile: CapabilityProfile;
  requestId: string;
}

export type ControlPlaneErrorCode =
  | 'CONTROL_SCHEMA'
  | 'BINDING_CONFLICT'
  | 'BOT_ACCOUNT_NOT_FOUND'
  | 'BOT_OPERATOR_NOT_FOUND'
  | 'PAIRING_CODE_INVALID'
  | 'PAIRING_CODE_EXPIRED'
  | 'CONTROL_FORBIDDEN'
  | 'APPROVAL_REQUIRED';

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;

  constructor(code: ControlPlaneErrorCode, message: string) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
  }
}

const transitions: Record<RuntimeStatus, ReadonlySet<RuntimeStatus>> = {
  draft: new Set(['validating', 'stopped', 'error']),
  validating: new Set(['stopped', 'auth_required', 'error']),
  stopped: new Set(['starting', 'validating', 'draft']),
  starting: new Set(['online', 'auth_required', 'error', 'stopped']),
  online: new Set(['reconnecting', 'stopped', 'error', 'auth_required']),
  reconnecting: new Set(['online', 'auth_required', 'error', 'stopped']),
  auth_required: new Set(['validating', 'starting', 'stopped', 'error']),
  error: new Set(['validating', 'starting', 'stopped', 'draft']),
};

export function canTransitionRuntime(from: RuntimeStatus, to: RuntimeStatus): boolean {
  return from === to || transitions[from].has(to);
}
