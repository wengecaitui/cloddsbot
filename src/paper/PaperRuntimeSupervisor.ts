// Stage 4A3: PaperRuntimeSupervisor — lifecycle state machine + graceful supervision.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import { PaperRuntimeRegistry, type PaperRuntimeBinding } from './PaperRuntimeRegistry';
import { PaperFastPathCoordinator, type PaperCoordinatorResult } from './PaperFastPathCoordinator';
import type { Clock, PaperRuntimeEventSink, PaperRuntimeEvent } from './PaperObservability';
import { systemClock, NullPaperRuntimeEventSink, makeEventId } from './PaperObservability';
import {
  type PaperRuntimeLifecycleState, type PaperRuntimeLifecycleSnapshot,
  type PaperRuntimeBatchResult, type PaperRuntimeLifecycleAdapter,
  PaperRuntimeLifecycleError, NoopPaperRuntimeLifecycleAdapter,
} from './PaperLifecycle';

// ── Internal state ────────────────────────────────────────────
interface LifecycleRecord {
  accountId: string;
  exchange: ExchangeId;
  state: PaperRuntimeLifecycleState;
  generation: number;
  registeredAtMs: number;
  lastTransitionAtMs: number;
  startedAtMs?: number;
  stoppedAtMs?: number;
  lastFailureAtMs?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  inFlightRuns: number;
  adapter: PaperRuntimeLifecycleAdapter;
  transitionGate: Promise<unknown> | null; // active transition peer
  drainPromise: Promise<void> | null;     // graceful stop drain
  drainResolve: (() => void) | null;      // resolve drain when inFlight=0
  metrics: {
    startTotal: number; startFailed: number;
    stopTotal: number; stopFailed: number;
    restartTotal: number; restartFailed: number;
    runRejected: number; inFlightMax: number;
  };
}

// ── Supervisor ────────────────────────────────────────────────
export class PaperRuntimeSupervisor {
  private records = new Map<string, LifecycleRecord>();
  private registry: PaperRuntimeRegistry;
  private sink: PaperRuntimeEventSink;
  private clock: Clock;

  constructor(opts: { registry: PaperRuntimeRegistry; eventSink?: PaperRuntimeEventSink; clock?: Clock }) {
    this.registry = opts.registry;
    this.sink = opts.eventSink ?? new NullPaperRuntimeEventSink();
    this.clock = opts.clock ?? systemClock;
  }

  private key(accountId: string, exchange: ExchangeId): string { return `${accountId}:${exchange}`; }
  private validateKey(accountId: string, exchange: ExchangeId): void {
    if (typeof accountId !== 'string' || accountId !== accountId.trim() || accountId.length === 0) throw new PaperRuntimeLifecycleError('LIFECYCLE_INVALID_ACCOUNT', 'invalid accountId', accountId, exchange);
    if (!isExchangeId(exchange)) throw new PaperRuntimeLifecycleError('LIFECYCLE_INVALID_EXCHANGE', 'invalid exchange', accountId, exchange);
  }
  private get(accountId: string, exchange: ExchangeId): LifecycleRecord {
    this.validateKey(accountId, exchange);
    const r = this.records.get(this.key(accountId, exchange));
    if (!r) throw new PaperRuntimeLifecycleError('RUNTIME_NOT_REGISTERED', `no lifecycle for ${accountId}:${exchange}`, accountId, exchange);
    return r;
  }
  private emit(e: PaperRuntimeEvent): void { try { void this.sink.emit(e); } catch {} }

  // ── Snapshot ────────────────────────────────────────────────
  private snapshot(r: LifecycleRecord): PaperRuntimeLifecycleSnapshot {
    return Object.freeze({
      accountId: r.accountId, exchange: r.exchange,
      state: r.state, acceptingRuns: r.state === 'running',
      inFlightRuns: r.inFlightRuns, generation: r.generation,
      registeredAtMs: r.registeredAtMs, lastTransitionAtMs: r.lastTransitionAtMs,
      startedAtMs: r.startedAtMs, stoppedAtMs: r.stoppedAtMs,
      lastFailureAtMs: r.lastFailureAtMs, lastErrorCode: r.lastErrorCode, lastErrorMessage: r.lastErrorMessage,
    });
  }

  // ── Register ────────────────────────────────────────────────
  register(binding: PaperRuntimeBinding, adapter?: PaperRuntimeLifecycleAdapter): void {
    this.registry.register(binding);
    const now = this.clock.now();
    const r: LifecycleRecord = {
      accountId: binding.accountId, exchange: binding.exchange,
      state: 'stopped', generation: 0, registeredAtMs: now, lastTransitionAtMs: now,
      inFlightRuns: 0,
      adapter: adapter ?? new NoopPaperRuntimeLifecycleAdapter(),
      transitionGate: null, drainPromise: null, drainResolve: null,
      metrics: { startTotal:0, startFailed:0, stopTotal:0, stopFailed:0, restartTotal:0, restartFailed:0, runRejected:0, inFlightMax:0 },
    };
    this.records.set(this.key(binding.accountId, binding.exchange), r);
  }

  unregister(accountId: string, exchange: ExchangeId): boolean {
    const r = this.get(accountId, exchange);
    if (r.state !== 'stopped') throw new PaperRuntimeLifecycleError('RUNTIME_NOT_STOPPED', `cannot unregister in state ${r.state}`, accountId, exchange);
    if (r.inFlightRuns !== 0) throw new PaperRuntimeLifecycleError('RUNTIME_NOT_STOPPED', 'in-flight runs pending', accountId, exchange);
    if (r.transitionGate) throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', 'transition in progress', accountId, exchange);
    this.records.delete(this.key(accountId, exchange));
    return this.registry.unregister(accountId, exchange);
  }

  // ── Lifecycle queries ───────────────────────────────────────
  lifecycle(accountId: string, exchange: ExchangeId): PaperRuntimeLifecycleSnapshot { return this.snapshot(this.get(accountId, exchange)); }
  lifecycleAll(): readonly PaperRuntimeLifecycleSnapshot[] {
    return [...this.records.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>this.snapshot(r));
  }

  // ── Start ───────────────────────────────────────────────────
  async start(accountId: string, exchange: ExchangeId): Promise<PaperRuntimeLifecycleSnapshot> {
    const r = this.get(accountId, exchange);
    if (r.state === 'running') return this.snapshot(r);

    // Concurrent transition check
    if (r.transitionGate) { await r.transitionGate; return this.snapshot(r); }
    if (r.state === 'starting') { await new Promise(res => setTimeout(res, 10)); return this.snapshot(r); }

    const gate = this._doStart(r);
    r.transitionGate = gate;
    try { await gate; return this.snapshot(r); }
    finally { r.transitionGate = null; }
  }

  private async _doStart(r: LifecycleRecord): Promise<void> {
    const now = this.clock.now();
    r.metrics.startTotal++;
    r.state = 'starting'; r.lastTransitionAtMs = now;
    this.emit({ eventId: makeEventId(), eventType: 'runtime.starting' as any, accountId: r.accountId, exchange: r.exchange, occurredAtMs: now, metadata: { lifecycleState: 'starting', generation: r.generation, inFlightRuns: r.inFlightRuns } });
    try {
      await r.adapter.start();
      r.state = 'running'; r.generation++; r.lastTransitionAtMs = this.clock.now(); r.startedAtMs = this.clock.now();
      this.emit({ eventId: makeEventId(), eventType: 'runtime.started' as any, accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), metadata: { lifecycleState: 'running', generation: r.generation } });
    } catch (err: unknown) {
      r.state = 'failed'; r.lastFailureAtMs = this.clock.now();
      r.lastErrorCode = 'LIFECYCLE_START_FAILED'; r.lastErrorMessage = err instanceof Error ? err.message : String(err);
      r.metrics.startFailed++;
      this.emit({ eventId: makeEventId(), eventType: 'runtime.lifecycle_error' as any, accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), errorCode: r.lastErrorCode, errorMessage: r.lastErrorMessage, metadata: { lifecycleState: 'failed', generation: r.generation } });
      throw new PaperRuntimeLifecycleError('LIFECYCLE_START_FAILED', r.lastErrorMessage!, r.accountId, r.exchange);
    }
  }

  // ── Stop ────────────────────────────────────────────────────
  async stop(accountId: string, exchange: ExchangeId): Promise<PaperRuntimeLifecycleSnapshot> {
    const r = this.get(accountId, exchange);
    if (r.state === 'stopped') return this.snapshot(r);
    if (r.state === 'failed') return this.snapshot(r);
    if (r.state === 'stopping') { await (r.transitionGate ?? Promise.resolve()); return this.snapshot(r); }
    if (r.transitionGate) throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', 'stop rejected: transition in progress', accountId, exchange);
    if (r.state !== 'running' && r.state !== 'starting') throw new PaperRuntimeLifecycleError('LIFECYCLE_INVALID_STATE', `cannot stop from ${r.state}`, accountId, exchange);
    const gate = this._doStop(r);
    r.transitionGate = gate;
    try { await gate; return this.snapshot(r); }
    finally { r.transitionGate = null; }
  }

  private async _doStop(r: LifecycleRecord): Promise<void> {
    const now = this.clock.now();
    r.metrics.stopTotal++;
    r.state = 'stopping'; r.lastTransitionAtMs = now;
    this.emit({ eventId: makeEventId(), eventType: 'runtime.stopping' as any, accountId: r.accountId, exchange: r.exchange, occurredAtMs: now, metadata: { lifecycleState: 'stopping', inFlightRuns: r.inFlightRuns } });
    // Graceful drain
    if (r.inFlightRuns > 0) {
      r.drainPromise = new Promise<void>(res => { r.drainResolve = res; });
      await r.drainPromise;
    }
    try {
      await r.adapter.stop();
      r.state = 'stopped'; r.lastTransitionAtMs = this.clock.now(); r.stoppedAtMs = this.clock.now();
      this.emit({ eventId: makeEventId(), eventType: 'runtime.stopped' as any, accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), metadata: { lifecycleState: 'stopped' } });
    } catch (err: unknown) {
      r.state = 'failed'; r.lastFailureAtMs = this.clock.now();
      r.lastErrorCode = 'LIFECYCLE_STOP_FAILED'; r.lastErrorMessage = err instanceof Error ? err.message : String(err);
      r.metrics.stopFailed++;
      this.emit({ eventId: makeEventId(), eventType: 'runtime.lifecycle_error' as any, accountId: r.accountId, exchange: r.exchange, occurredAtMs: this.clock.now(), errorCode: r.lastErrorCode, errorMessage: r.lastErrorMessage });
    } finally {
      r.drainPromise = null; r.drainResolve = null;
    }
  }

  // ── Restart ─────────────────────────────────────────────────
  async restart(accountId: string, exchange: ExchangeId): Promise<PaperRuntimeLifecycleSnapshot> {
    const r = this.get(accountId, exchange);
    if (r.transitionGate) throw new PaperRuntimeLifecycleError('LIFECYCLE_TRANSITION_IN_PROGRESS', 'restart rejected: transition in progress', accountId, exchange);
    r.metrics.restartTotal++;
    this.emit({ eventId: makeEventId(), eventType: 'runtime.restarting' as any, accountId, exchange, occurredAtMs: this.clock.now() });
    const gate = (async () => {
      if (r.state === 'running') await this._doStop(r);
      if (r.state === 'failed') {
        // Recovery stop
        try { await r.adapter.stop(); } catch {}
      }
      if (r.state === 'stopped' || r.state === 'failed') {
        await this._doStart(r);
        this.emit({ eventId: makeEventId(), eventType: 'runtime.restarted' as any, accountId, exchange, occurredAtMs: this.clock.now(), metadata: { lifecycleState: 'running', generation: r.generation } });
      }
    })();
    r.transitionGate = gate;
    try { await gate; return this.snapshot(r); }
    catch (err) {
      r.state = 'failed'; r.lastErrorCode = 'LIFECYCLE_RESTART_FAILED'; r.lastErrorMessage = err instanceof Error ? err.message : String(err);
      r.metrics.restartFailed++;
      this.emit({ eventId: makeEventId(), eventType: 'runtime.lifecycle_error' as any, accountId, exchange, occurredAtMs: this.clock.now(), errorCode: r.lastErrorCode, errorMessage: r.lastErrorMessage });
      throw err;
    }
    finally { r.transitionGate = null; }
  }

  // ── Lifecycle-gated run ─────────────────────────────────────
  async run(accountId: string, signal: { exchange: ExchangeId; symbol: string; source: string }, params: { feeBps: number; slippageBps: number }): Promise<PaperCoordinatorResult> {
    const r = this.get(accountId, signal.exchange);
    if (r.state !== 'running') { r.metrics.runRejected++; throw new PaperRuntimeLifecycleError('RUNTIME_NOT_RUNNING', `cannot run in state ${r.state}`, accountId, signal.exchange); }
    r.inFlightRuns++;
    if (r.inFlightRuns > r.metrics.inFlightMax) r.metrics.inFlightMax = r.inFlightRuns;
    try {
      return await this.registry.run(accountId, signal, params);
    } finally {
      r.inFlightRuns--;
      if (r.inFlightRuns === 0 && r.drainResolve) { const res = r.drainResolve; r.drainResolve = null; res(); }
    }
  }

  // ── Batch ───────────────────────────────────────────────────
  async startAll(): Promise<readonly PaperRuntimeBatchResult[]> {
    const results: PaperRuntimeBatchResult[] = [];
    for (const r of [...this.records.values()].sort((a,b)=>this.key(a.accountId,a.exchange).localeCompare(this.key(b.accountId,b.exchange)))) {
      try { await this.start(r.accountId, r.exchange); results.push({ accountId: r.accountId, exchange: r.exchange, operation: 'start', success: true, state: this.snapshot(r).state }); }
      catch (e: any) { results.push({ accountId: r.accountId, exchange: r.exchange, operation: 'start', success: false, state: this.snapshot(r).state, errorCode: e?.code, errorMessage: e?.message }); }
    }
    return results;
  }
  async stopAll(): Promise<readonly PaperRuntimeBatchResult[]> {
    const results: PaperRuntimeBatchResult[] = [];
    for (const r of [...this.records.values()].sort((a,b)=>this.key(a.accountId,a.exchange).localeCompare(this.key(b.accountId,b.exchange)))) {
      try { await this.stop(r.accountId, r.exchange); results.push({ accountId: r.accountId, exchange: r.exchange, operation: 'stop', success: true, state: this.snapshot(r).state }); }
      catch (e: any) { results.push({ accountId: r.accountId, exchange: r.exchange, operation: 'stop', success: false, state: this.snapshot(r).state, errorCode: e?.code, errorMessage: e?.message }); }
    }
    return results;
  }
}
