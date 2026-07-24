// Stage 4A2: PaperRuntimeRegistry — with observability events, health, clock.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { FastPipeline } from '../pipeline/FastPipeline';
import { PaperExecutionService } from './PaperExecutionService';
import type { PaperAccountSnapshot } from '../types/paper-account';
import { PaperFastPathCoordinator, type PaperCoordinatorResult } from './PaperFastPathCoordinator';
import {
  type Clock, type PaperRuntimeEvent, type PaperRuntimeEventSink,
  type PaperRuntimeHealthSnapshot,
  systemClock, NullPaperRuntimeEventSink, makeEventId,
} from './PaperObservability';

export interface PaperRuntimeBinding {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly pipeline: FastPipeline;
  readonly service: PaperExecutionService;
  readonly coordinator: PaperFastPathCoordinator;
}
export interface RegistryEntry {
  readonly accountId: string;
  readonly exchange: ExchangeId;
}

interface StoredBinding { binding: Readonly<PaperRuntimeBinding>; key: string; }
interface HealthState { totalRuns: number; successfulRuns: number; rejectedRuns: number; failedRuns: number; appliedFills: number; duplicateFills: number; durations: number[]; lastRunAtMs?: number; lastSuccessAtMs?: number; lastFailureAtMs?: number; lastErrorCode?: string; }

export class PaperRuntimeRegistry {
  private bindings = new Map<string, StoredBinding>();
  private healthState = new Map<string, HealthState>();
  private sink: PaperRuntimeEventSink;
  private clock: Clock;

  constructor(opts?: { eventSink?: PaperRuntimeEventSink; clock?: Clock }) {
    this.sink = opts?.eventSink ?? new NullPaperRuntimeEventSink();
    this.clock = opts?.clock ?? systemClock;
  }

  private k(accountId: string, exchange: ExchangeId): string { return `${accountId}:${exchange}`; }
  private hk(accountId: string, exchange: ExchangeId): string { return this.k(accountId, exchange); }
  private getHealth(accountId: string, exchange: ExchangeId): HealthState {
    const k = this.hk(accountId, exchange);
    let h = this.healthState.get(k);
    if (!h) { h = { totalRuns:0, successfulRuns:0, rejectedRuns:0, failedRuns:0, appliedFills:0, duplicateFills:0, durations:[] }; this.healthState.set(k, h); }
    return h;
  }

  private validateKey(accountId: string, exchange: ExchangeId): void {
    if (typeof accountId !== 'string' || accountId !== accountId.trim() || accountId.length === 0) throw new Error('Registry: invalid accountId');
    if (!isExchangeId(exchange)) throw new Error('Registry: invalid exchange');
  }

  private emit(e: PaperRuntimeEvent): void { try { void this.sink.emit(e); } catch {} }

  register(binding: PaperRuntimeBinding): void {
    this.validateKey(binding.accountId, binding.exchange);
    const k = this.k(binding.accountId, binding.exchange);
    if (this.bindings.has(k)) throw new Error(`Registry: duplicate binding ${k}`);
    if (binding.pipeline.getExchange() !== binding.exchange) throw new Error('Registry: pipeline exchange mismatch');
    const id = binding.service.getIdentity();
    if (id.accountId !== binding.accountId) throw new Error('Registry: service accountId mismatch');
    if (id.exchange !== binding.exchange) throw new Error('Registry: service exchange mismatch');
    if (binding.coordinator.getExchange() !== binding.exchange) throw new Error('Registry: coordinator exchange mismatch');
    if (!binding.coordinator.isBoundTo(binding.pipeline, binding.service, binding.exchange)) throw new Error('Registry: coordinator not bound to given pipeline/service');
    this.bindings.set(k, { binding: Object.freeze({ ...binding }), key: k });
    this.emit({ eventId: makeEventId(), eventType: 'runtime.registered', accountId: binding.accountId, exchange: binding.exchange, occurredAtMs: this.clock.now() });
  }

  unregister(accountId: string, exchange: ExchangeId): boolean {
    this.validateKey(accountId, exchange);
    const ok = this.bindings.delete(this.k(accountId, exchange));
    if (ok) this.emit({ eventId: makeEventId(), eventType: 'runtime.unregistered', accountId, exchange, occurredAtMs: this.clock.now() });
    return ok;
  }

  has(accountId: string, exchange: ExchangeId): boolean {
    this.validateKey(accountId, exchange);
    return this.bindings.has(this.k(accountId, exchange));
  }

  list(): readonly RegistryEntry[] {
    return [...this.bindings.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([, { binding }]) => ({ accountId: binding.accountId, exchange: binding.exchange }));
  }

  private get(accountId: string, exchange: ExchangeId): Readonly<PaperRuntimeBinding> {
    this.validateKey(accountId, exchange);
    const entry = this.bindings.get(this.k(accountId, exchange));
    if (!entry) throw new Error(`Registry: no binding for ${this.k(accountId, exchange)}`);
    return entry.binding;
  }

  async run(accountId: string, signal: { exchange: ExchangeId; symbol: string; source: string }, params: { feeBps: number; slippageBps: number }): Promise<PaperCoordinatorResult> {
    const startedAt = this.clock.now();
    const h = this.getHealth(accountId, signal.exchange);
    h.totalRuns++;

    // Run started event
    this.emit({ eventId: makeEventId(), eventType: 'run.started', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: startedAt });

    // Route lookup
    let binding: Readonly<PaperRuntimeBinding>;
    try {
      binding = this.get(accountId, signal.exchange);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ eventId: makeEventId(), eventType: 'run.rejected', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: this.clock.now(), errorCode: 'UNKNOWN_ROUTE', errorMessage: msg });
      h.rejectedRuns++; throw err;
    }

    // Input validation
    try {
      this.validateKey(accountId, signal.exchange);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ eventId: makeEventId(), eventType: 'run.rejected', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: this.clock.now(), errorCode: 'INVALID_INPUT', errorMessage: msg });
      h.rejectedRuns++; throw err;
    }

    let result: PaperCoordinatorResult;
    try {
      result = await binding.coordinator.run(signal, params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const now = this.clock.now();
      const dur = Math.max(0, now - startedAt);
      h.failedRuns++; h.lastFailureAtMs = now; h.lastErrorCode = 'COORDINATOR_ERROR'; h.durations.push(dur);
      this.emit({ eventId: makeEventId(), eventType: 'runtime.error', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: now, durationMs: dur, errorCode: 'COORDINATOR_ERROR', errorMessage: msg });
      throw err;
    }

    const completedAt = this.clock.now();
    const duration = Math.max(0, completedAt - startedAt);
    h.durations.push(duration); h.lastRunAtMs = completedAt;

    if (result.pipelineResult.decision !== 'trade') {
      h.successfulRuns++; h.lastSuccessAtMs = completedAt;
      this.emit({ eventId: makeEventId(), eventType: 'pipeline.completed', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: completedAt, durationMs: duration, decision: result.pipelineResult.decision });
      this.emit({ eventId: makeEventId(), eventType: 'run.completed', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: completedAt, durationMs: duration, decision: result.pipelineResult.decision });
      return result;
    }

    // Trade path
    const pe = result.paperEvent;
    if (pe) {
      switch (pe.status) {
        case 'applied': h.appliedFills++; break;
        case 'duplicate': h.duplicateFills++; break;
        case 'failed': h.failedRuns++; h.lastFailureAtMs = completedAt; h.lastErrorCode = 'PAPER_FAILED'; break;
      }
      this.emit({ eventId: makeEventId(), eventType: `paper.${pe.status}` as PaperRuntimeEvent['eventType'], accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: completedAt, durationMs: duration, decision: 'trade', paperStatus: pe.status, errorCode: pe.error, errorMessage: pe.error });
    }
    h.successfulRuns++; h.lastSuccessAtMs = completedAt;
    this.emit({ eventId: makeEventId(), eventType: 'run.completed', accountId, exchange: signal.exchange, symbol: signal.symbol, occurredAtMs: completedAt, durationMs: duration, decision: 'trade', paperStatus: pe?.status });
    return result;
  }

  snapshot(accountId: string, exchange: ExchangeId): PaperAccountSnapshot {
    this.emit({ eventId: makeEventId(), eventType: 'snapshot.read', accountId, exchange, occurredAtMs: this.clock.now() });
    return this.get(accountId, exchange).service.snapshot();
  }

  // ── Health ──────────────────────────────────────────────────
  health(accountId: string, exchange: ExchangeId): PaperRuntimeHealthSnapshot {
    const h = this.healthState.get(this.hk(accountId, exchange));
    const runCount = h ? h.appliedFills + h.duplicateFills + h.successfulRuns : 0;
    const failed = h ? h.failedRuns : 0;
    const avg = h && h.durations.length > 0 ? h.durations.reduce((a,b)=>a+b,0) / h.durations.length : 0;
    const max = h && h.durations.length > 0 ? Math.max(...h.durations) : 0;
    const total = (h?.totalRuns ?? 0);
    const succ = total - failed - (h?.rejectedRuns ?? 0);
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (failed > 3) status = 'unhealthy';
    else if (failed > 0) status = 'degraded';
    return {
      accountId, exchange,
      registered: this.bindings.has(this.k(accountId, exchange)),
      status, totalRuns: total, successfulRuns: Math.max(0, succ),
      rejectedRuns: h?.rejectedRuns ?? 0, failedRuns: failed,
      appliedFills: h?.appliedFills ?? 0, duplicateFills: h?.duplicateFills ?? 0,
      lastRunAtMs: h?.lastRunAtMs, lastSuccessAtMs: h?.lastSuccessAtMs,
      lastFailureAtMs: h?.lastFailureAtMs, lastErrorCode: h?.lastErrorCode,
      averageDurationMs: avg, maxDurationMs: max,
    };
  }

  healthAll(): readonly PaperRuntimeHealthSnapshot[] {
    return [...this.healthState.keys()].sort().map(k => {
      const [accountId, exchange] = [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':')+1) as ExchangeId];
      return this.health(accountId, exchange);
    });
  }
}
