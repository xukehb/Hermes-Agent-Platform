import { EventEmitter } from 'node:events';
import { usageTelemetryEventSchema, type UsageTelemetryEvent } from './types.js';

export interface TelemetryStore {
  recordUsageEvent(event: UsageTelemetryEvent): boolean;
}

export interface TelemetrySnapshot {
  sequence: number;
  status: { kind: 'ok' } | { kind: 'degraded'; message: string };
  activeTasks: Array<{ taskId: string; agentId: string; serverId: string; totalTokens: number }>;
  byServer: Array<{ serverId: string; totalTokens: number }>;
  totalTokens: number;
}

export class TelemetryService {
  private readonly store: TelemetryStore;
  private readonly emitter = new EventEmitter();
  private readonly seen = new Set<string>();
  private readonly active = new Map<string, { taskId: string; agentId: string; serverId: string; totalTokens: number }>();
  private readonly servers = new Map<string, number>();
  private status: TelemetrySnapshot['status'] = { kind: 'ok' };
  private sequence = 0;
  private totalTokens = 0;

  constructor(store: TelemetryStore) {
    this.store = store;
  }

  record(input: UsageTelemetryEvent): void {
    const event = usageTelemetryEventSchema.parse(input);
    try {
      const accepted = this.store.recordUsageEvent(event);
      if (!accepted || this.seen.has(event.eventId)) return;
      this.seen.add(event.eventId);
      this.sequence = Math.max(this.sequence, event.sequence);
      const active = this.active.get(event.taskId) ?? {
        taskId: event.taskId,
        agentId: event.agentId,
        serverId: event.serverId,
        totalTokens: 0,
      };
      active.totalTokens += event.totalTokens;
      this.active.set(event.taskId, active);
      this.servers.set(event.serverId, (this.servers.get(event.serverId) ?? 0) + event.totalTokens);
      this.totalTokens += event.totalTokens;
      this.status = { kind: 'ok' };
      this.emitter.emit('changed', this.sequence);
    } catch (error) {
      this.status = { kind: 'degraded', message: safeTelemetryError(error) };
      this.emitter.emit('changed', this.sequence);
    }
  }

  finishTask(taskId: string): void {
    this.active.delete(taskId);
    this.emitter.emit('changed', this.sequence);
  }

  subscribe(listener: (sequence: number) => void): () => void {
    this.emitter.on('changed', listener);
    return () => this.emitter.off('changed', listener);
  }

  snapshot(): TelemetrySnapshot {
    return {
      sequence: this.sequence,
      status: this.status,
      activeTasks: [...this.active.values()].map((item) => ({ ...item })),
      byServer: [...this.servers.entries()]
        .map(([serverId, totalTokens]) => ({ serverId, totalTokens }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      totalTokens: this.totalTokens,
    };
  }
}

function safeTelemetryError(error: unknown): string {
  return error instanceof Error ? error.message : 'telemetry failed';
}
