import { z } from 'zod';
import type { ControlExecutionContext } from '../control-plane/index.js';

export interface TaskExecutionContext {
  serverId: string;
  botAccountId?: string;
  parentTaskId?: string;
  control?: ControlExecutionContext;
}

const safeTokenCount = z.number().int().nonnegative().safe();

export const usageTelemetryEventSchema = z.strictObject({
  eventId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  taskId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  sessionKey: z.string().min(1),
  agentId: z.string().min(1),
  serverId: z.string().min(1),
  botAccountId: z.string().min(1).optional(),
  providerId: z.string().min(1),
  model: z.string().min(1),
  source: z.enum(['model_turn', 'compaction', 'subagent', 'reconciliation']),
  promptTokens: safeTokenCount,
  completionTokens: safeTokenCount,
  totalTokens: safeTokenCount,
}).refine((value) => value.totalTokens >= value.promptTokens + value.completionTokens, {
  message: 'totalTokens must cover prompt and completion tokens',
});

export type UsageTelemetryEvent = z.infer<typeof usageTelemetryEventSchema>;
export type UsageSource = UsageTelemetryEvent['source'];

export interface UsageQuery {
  since: string;
  until?: string;
  serverId?: string;
  taskId?: string;
  sessionKey?: string;
  agentId?: string;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface UsageQueryResult {
  totals: UsageTotals;
  byAgent: Array<{ agentId: string; totalTokens: number; calls: number }>;
  byServer: Array<{ serverId: string; totalTokens: number; calls: number }>;
}
