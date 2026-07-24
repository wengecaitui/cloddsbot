// Stage 4A2: Observability types — immutable event schema, clock, health.
import type { ExchangeId } from '../data/MarketIdentity';

export type PaperRuntimeEventType =
  | 'runtime.registered' | 'runtime.unregistered'
  | 'run.started' | 'run.completed' | 'run.rejected'
  | 'pipeline.completed' | 'paper.applied' | 'paper.duplicate' | 'paper.failed'
  | 'runtime.error' | 'snapshot.read';

export interface PaperRuntimeEvent {
  readonly eventId: string;
  readonly eventType: PaperRuntimeEventType;
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly symbol?: string;
  readonly occurredAtMs: number;
  readonly durationMs?: number;
  readonly decision?: string;
  readonly paperStatus?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface Clock { now(): number; }

export const systemClock: Clock = { now: () => Date.now() };

export function makeEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PaperRuntimeHealthSnapshot {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly registered: boolean;
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly rejectedRuns: number;
  readonly failedRuns: number;
  readonly appliedFills: number;
  readonly duplicateFills: number;
  readonly lastRunAtMs?: number;
  readonly lastSuccessAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly lastErrorCode?: string;
  readonly averageDurationMs: number;
  readonly maxDurationMs: number;
}

// ── Event Sink ────────────────────────────────────────────────
export interface PaperRuntimeEventSink {
  emit(event: PaperRuntimeEvent): void | Promise<void>;
}

export class NullPaperRuntimeEventSink implements PaperRuntimeEventSink {
  emit(): void {}
}

export class InMemoryPaperRuntimeEventSink implements PaperRuntimeEventSink {
  private events: PaperRuntimeEvent[] = [];
  private max: number;

  constructor(options?: { maxCapacity?: number }) {
    this.max = options?.maxCapacity ?? 1000;
  }

  emit(event: PaperRuntimeEvent): void {
    if (this.events.length >= this.max) this.events.shift();
    this.events.push(event);
  }

  list(): readonly PaperRuntimeEvent[] { return [...this.events]; }

  query(filter: { accountId?: string; exchange?: ExchangeId; eventType?: PaperRuntimeEventType }): readonly PaperRuntimeEvent[] {
    return this.events.filter(e => {
      if (filter.accountId !== undefined && e.accountId !== filter.accountId) return false;
      if (filter.exchange !== undefined && e.exchange !== filter.exchange) return false;
      if (filter.eventType !== undefined && e.eventType !== filter.eventType) return false;
      return true;
    });
  }

  clear(): void { this.events = []; }
}
