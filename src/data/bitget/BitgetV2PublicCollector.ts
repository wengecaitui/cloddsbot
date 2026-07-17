// Stage 3B2B + 3B2B-R1: Bitget V2 Public Collector
// Completes the V2 protocol pipeline: planner → WS → parser → close detect → WsTicker/WsKline
// 3B2B-R1: unified socket retirement, single reconnect entry, strict ack event split.

import type { SubscriptionPlan } from '../../runtime/market/UniverseManager';
import type { WsTicker, WsKline } from '../types';
import {
  planBitgetSubscriptionRequests,
  type BitgetSubscriptionRequest,
  type BitgetSubscriptionPlannerOptions,
} from './SubscriptionPlanner';
import {
  parseBitgetPublicMessage,
  type BitgetParsedPublicFrame,
  type BitgetTickerUpdate,
  type BitgetCandleUpdate,
} from './PublicMessageParser';
import { createCandleCloseDetector, type CandleCloseDetector } from './CandleCloseDetector';

export const BITGET_V2_PUBLIC_ENDPOINT = 'wss://ws.bitget.com/v2/ws/public';

export type BitgetCollectorState = 'idle' | 'connecting' | 'subscribing' | 'running' | 'reconnect_wait' | 'stopped' | 'failed';

// ── Abstractions for testability ───────────────────────────────────────────

export interface BitgetWebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type BitgetWebSocketFactory = (url: string) => BitgetWebSocketLike;

export interface BitgetTimerScheduler {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ── Options & types ────────────────────────────────────────────────────────

export interface BitgetV2PublicCollectorOptions {
  readonly plan: SubscriptionPlan;
  readonly endpoint?: string;
  readonly webSocketFactory?: BitgetWebSocketFactory;
  readonly scheduler?: BitgetTimerScheduler;
  readonly ackTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly plannerOptions?: Pick<BitgetSubscriptionPlannerOptions, 'maxArgsPerBatch' | 'maxPayloadBytes'>;
}

export interface BitgetCollectorFailure {
  readonly phase: 'connect' | 'send' | 'subscribe' | 'heartbeat' | 'parse' | 'reconnect';
  readonly error: Error;
}

// ── Deep clone plan ────────────────────────────────────────────────────────

function clonePlan(plan: SubscriptionPlan): SubscriptionPlan {
  const entries = plan.entries.map(e => ({
    symbol: e.symbol,
    exchangeSymbol: e.exchangeSymbol,
    intervals: [...e.intervals],
    ticker: e.ticker,
  }));
  return { version: plan.version, entries };
}

// ── Expected ack key ───────────────────────────────────────────────────────

function ackKey(arg: { instType: string; channel: string; instId: string }): string {
  return `${arg.instType}|${arg.channel}|${arg.instId}`;
}

// ── Default factory / scheduler ────────────────────────────────────────────

function defaultWebSocketFactory(url: string): BitgetWebSocketLike {
  if (typeof (globalThis as any).WebSocket !== 'function') {
    throw new Error('BitgetV2PublicCollector: WebSocket not available in this runtime');
  }
  return new (globalThis as any).WebSocket(url) as BitgetWebSocketLike;
}

const defaultScheduler: BitgetTimerScheduler = {
  setTimeout: (h, d) => globalThis.setTimeout(h, d),
  clearTimeout: (h: unknown) => globalThis.clearTimeout(h as any),
};

// ── Collector ──────────────────────────────────────────────────────────────

export class BitgetV2PublicCollector {
  private options: Required<Omit<BitgetV2PublicCollectorOptions, 'plannerOptions'>> & { plannerOptions?: Pick<BitgetSubscriptionPlannerOptions, 'maxArgsPerBatch' | 'maxPayloadBytes'> };
  private _state: BitgetCollectorState = 'idle';
  private _planVersion: number;
  private capturedRequests: readonly BitgetSubscriptionRequest[];
  private expectedAckKeys: Set<string>;
  private generation = 0;
  private manualStop = false;

  // WS
  private ws: BitgetWebSocketLike | null = null;
  private wsFactory: BitgetWebSocketFactory;
  private scheduler: BitgetTimerScheduler;

  // Promise
  private startResolve: ((value: void | PromiseLike<void>) => void) | null = null;
  private startReject: ((reason: unknown) => void) | null = null;
  private startPromise: Promise<void> | null = null;

  // Timers
  private ackTimerHandle: unknown = undefined;
  private heartbeatTimerHandle: unknown = undefined;
  private pongTimerHandle: unknown = undefined;
  private reconnectTimerHandle: unknown = undefined;

  // Data
  private closeDetector: CandleCloseDetector;

  // Callbacks
  private tickerHandler: ((t: WsTicker) => void) | null = null;
  private klineHandler: ((k: WsKline) => void) | null = null;
  private errorHandler: ((f: BitgetCollectorFailure) => void) | null = null;

  constructor(options: BitgetV2PublicCollectorOptions) {
    const endpoint = options.endpoint ?? BITGET_V2_PUBLIC_ENDPOINT;
    if (typeof endpoint !== 'string' || endpoint.length === 0 || /\s/.test(endpoint)) {
      throw new Error('BitgetV2PublicCollector: endpoint must be non-empty with no whitespace');
    }

    for (const v of [options.ackTimeoutMs ?? 3000, options.heartbeatIntervalMs ?? 30000, options.pongTimeoutMs ?? 10000, options.reconnectDelayMs ?? 3000]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
        throw new Error(`BitgetV2PublicCollector: timeout/delay values must be positive integers, got ${v}`);
      }
    }

    // Deep-clone plan immediately
    const capturedPlan = clonePlan(options.plan);
    this._planVersion = capturedPlan.version;

    // Plan subscriptions at construction
    this.capturedRequests = planBitgetSubscriptionRequests(capturedPlan, 'subscribe', options.plannerOptions);
    this.expectedAckKeys = new Set<string>();
    for (const req of this.capturedRequests) {
      for (const a of req.args) {
        this.expectedAckKeys.add(ackKey(a));
      }
    }

    this.closeDetector = createCandleCloseDetector();
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;

    this.options = {
      plan: capturedPlan,
      endpoint,
      ackTimeoutMs: options.ackTimeoutMs ?? 3000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10000,
      reconnectDelayMs: options.reconnectDelayMs ?? 3000,
      webSocketFactory: this.wsFactory,
      scheduler: this.scheduler,
      plannerOptions: options.plannerOptions,
    };
  }

  get state(): BitgetCollectorState { return this._state; }
  get planVersion(): number { return this._planVersion; }

  // ── Lifecycle: start ────────────────────────────────────────────────────

  start(): Promise<void> {
    if (this._state === 'stopped') {
      return Promise.reject(new Error('BitgetV2PublicCollector: collector is stopped'));
    }
    if (this._state === 'failed') {
      return Promise.reject(new Error('BitgetV2PublicCollector: collector startup previously failed'));
    }
    if (this.startPromise !== null) return this.startPromise;
    if (this._state === 'running') return Promise.resolve();

    this._state = 'connecting';
    this.manualStop = false;
    const gen = ++this.generation;

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;

      try {
        this.ws = this.wsFactory(this.options.endpoint);
      } catch (err: any) {
        this._state = 'failed';
        this.startPromise = null;
        this.startResolve = null;
        this.startReject = null;
        reject(err);
        return;
      }

      const ws = this.ws;

      ws.onopen = () => {
        if (this.generation !== gen || this.manualStop) return;
        this._state = 'subscribing';

        // (Re-)build pending ack keys from saved requests
        this.expectedAckKeys = new Set<string>();
        for (const req of this.capturedRequests) {
          for (const a of req.args) {
            this.expectedAckKeys.add(ackKey(a));
          }
        }

        // Send all batches
        for (const req of this.capturedRequests) {
          const payload = JSON.stringify(req);
          try {
            ws.send(payload);
          } catch (err: any) {
            this.handleStartupError(gen, true, { phase: 'send', error: err });
            return;
          }
        }

        // Start ack timeout if we expect any acks
        if (this.expectedAckKeys.size > 0) {
          this.ackTimerHandle = this.scheduler.setTimeout(() => {
            if (this.generation === gen && !this.manualStop) {
              const pending = this.expectedAckKeys.size;
              this.handleStartupError(gen, true, { phase: 'subscribe', error: new Error(`ack timeout: ${pending} pending keys`) });
            }
          }, this.options.ackTimeoutMs);
        } else {
          // Empty plan → no acks needed
          this.enterRunning(gen);
        }
      };

      ws.onmessage = (event: { data: unknown }) => {
        if (this.generation !== gen || this.manualStop) return;
        this.onMessage(event.data, gen);
      };

      ws.onclose = () => {
        if (this.generation !== gen || this.manualStop) return;
        // If start hasn't resolved yet, treat as startup failure
        if (this._state === 'connecting' || this._state === 'subscribing') {
          this.handleStartupError(gen, true, { phase: 'connect', error: new Error('socket closed before start completed') });
          return;
        }
        // Otherwise reconnect (only if initial start already succeeded)
        this.beginReconnect(gen);
      };

      ws.onerror = () => {
        if (this.generation !== gen || this.manualStop) return;
        // Firefox creates ws with error state before onopen fires — ignore if
        // still connecting; onclose will handle the failure.
        // If already running, schedule reconnect via unified entry.
        if (this._state === 'running') {
          this.beginReconnect(gen);
        }
      };
    });

    return this.startPromise;
  }

  // ── Lifecycle: stop ─────────────────────────────────────────────────────

  stop(): void {
    if (this._state === 'stopped') return;
    this.manualStop = true;
    // Invalidate any existing connection immediately (same as retirement)
    this.retireActiveConnection(this.generation);
    this._state = 'stopped';
    this.clearTimers();
    this.closeDetector.clear();

    // Reject pending start
    if (this.startPromise !== null && this.startReject) {
      const reject = this.startReject;
      this.startPromise = null;
      this.startResolve = null;
      this.startReject = null;
      reject(new Error('BitgetV2PublicCollector: collector is stopped'));
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  onTicker(handler: (ticker: WsTicker) => void): void { this.tickerHandler = handler; }
  onKline(handler: (kline: WsKline) => void): void { this.klineHandler = handler; }
  onError(handler: (failure: BitgetCollectorFailure) => void): void { this.errorHandler = handler; }

  // ── Internal ────────────────────────────────────────────────────────────

  private safeReport(phase: BitgetCollectorFailure['phase'], error: Error): void {
    try {
      this.errorHandler?.({ phase, error });
    } catch { /* never bubble */ }
  }

  private clearTimers(): void {
    if (this.ackTimerHandle !== undefined) { this.scheduler.clearTimeout(this.ackTimerHandle); this.ackTimerHandle = undefined; }
    if (this.heartbeatTimerHandle !== undefined) { this.scheduler.clearTimeout(this.heartbeatTimerHandle); this.heartbeatTimerHandle = undefined; }
    if (this.pongTimerHandle !== undefined) { this.scheduler.clearTimeout(this.pongTimerHandle); this.pongTimerHandle = undefined; }
    if (this.reconnectTimerHandle !== undefined) { this.scheduler.clearTimeout(this.reconnectTimerHandle); this.reconnectTimerHandle = undefined; }
  }

  /**
   * Unconditionally invalidate and close the active connection tied to `expectedGeneration`.
   * Returns false (no side effects) if generation does not match (stale call).
   */
  private retireActiveConnection(expectedGeneration: number): boolean {
    if (this.generation !== expectedGeneration) return false;

    // 1. Clear timers
    this.clearTimers();

    // 2. Invalidate generation immediately — old socket callbacks & timers die
    this.generation += 1;

    // 3. Capture current socket
    const captured = this.ws;
    if (captured) {
      // 4-6. Detach handlers + null out reference if still pointing at captured
      captured.onopen = null;
      captured.onmessage = null;
      captured.onclose = null;
      captured.onerror = null;
      if (this.ws === captured) this.ws = null;
      // 7. Close (swallow errors)
      try { captured.close(); } catch { /* ignore */ }
    }
    return true;
  }

  private handleStartupError(gen: number, clearPromise: boolean, failure: BitgetCollectorFailure): void {
    if (this.generation !== gen || this.manualStop) return;
    this.retireActiveConnection(gen);
    this._state = 'failed';
    if (clearPromise && this.startReject) {
      const reject = this.startReject;
      this.startPromise = null;
      this.startResolve = null;
      this.startReject = null;
      reject(failure.error);
    }
    this.safeReport(failure.phase, failure.error);
  }

  private enterRunning(gen: number): void {
    if (this.generation !== gen || this.manualStop) return;
    this._state = 'running';
    this.ackTimerHandle = undefined;

    if (this.startResolve) {
      const resolve = this.startResolve;
      this.startPromise = null;
      this.startResolve = null;
      this.startReject = null;
      resolve();
    }

    this.scheduleHeartbeat(gen);
  }

  // ── Unified reconnect entry ──────────────────────────────────────────────

  private beginReconnect(expectedGeneration: number, failure?: BitgetCollectorFailure): void {
    if (this.manualStop) return;
    if (this._state === 'stopped' || this._state === 'failed') return;
    if (this.generation !== expectedGeneration) return;

    // Report failure once (if any)
    if (failure) this.safeReport(failure.phase, failure.error);

    // Retire the faulted connection (clears timers, bumps generation, detaches + closes ws)
    this.retireActiveConnection(expectedGeneration);

    // Avoid duplicate reconnect timer
    if (this.reconnectTimerHandle !== undefined) return;

    this._state = 'reconnect_wait';
    const waitGeneration = this.generation;

    this.reconnectTimerHandle = this.scheduler.setTimeout(() => {
      // Timer fired — clear handle first
      this.reconnectTimerHandle = undefined;
      if (this.generation !== waitGeneration || this.manualStop) return;
      this._state = 'connecting';
      const newGeneration = ++this.generation;
      this.startReconnectAttempt(newGeneration);
    }, this.options.reconnectDelayMs);
  }

  // ── Message processing ──────────────────────────────────────────────────

  private onMessage(data: unknown, gen: number): void {
    if (this.generation !== gen) return;

    let frame: BitgetParsedPublicFrame;
    try {
      frame = parseBitgetPublicMessage(data);
    } catch (err: any) {
      this.safeReport('parse', err);
      return;
    }

    try {
      switch (frame.kind) {
        case 'pong':
          this.onPong(gen);
          break;
        case 'ack':
          this.onAck(frame.event, frame.arg, gen);
          break;
        case 'error':
          this.onProtocolError(frame, gen);
          break;
        case 'data':
          if (this._state === 'running') {
            this.onDataEvents(frame.events, gen);
          }
          break;
        case 'ignored':
          break;
        case 'malformed':
          this.safeReport('parse', new Error(frame.reason));
          break;
      }
    } catch (err: any) {
      this.safeReport('parse', err);
    }
  }

  private onAck(event: 'subscribe' | 'unsubscribe', arg: { instType: string; channel: string; instId: string }, gen: number): void {
    if (this.generation !== gen || this._state !== 'subscribing') return;

    // Only subscribe acks advance startup pending set. unsubscribe acks ignored.
    if (event !== 'subscribe') return;

    const key = ackKey(arg);
    // duplicate / unknown subscribe ack → no-op (does not reduce pending)
    if (!this.expectedAckKeys.has(key)) return;

    this.expectedAckKeys.delete(key);
    if (this.expectedAckKeys.size === 0) {
      this.scheduler.clearTimeout(this.ackTimerHandle);
      this.ackTimerHandle = undefined;
      this.enterRunning(gen);
    }
  }

  private onProtocolError(frame: { message: string; code: string }, gen: number): void {
    if (this.generation !== gen) return;
    if (this._state === 'subscribing') {
      this.handleStartupError(gen, true, { phase: 'subscribe', error: new Error(`subscription error: ${frame.code} ${frame.message}`) });
      return;
    }
    if (this._state === 'running') {
      // Unified reconnect entry — retires connection and schedules reconnect
      this.beginReconnect(gen, { phase: 'subscribe', error: new Error(`${frame.code} ${frame.message}`) });
    }
  }

  private onDataEvents(updates: readonly (BitgetTickerUpdate | BitgetCandleUpdate)[], gen: number): void {
    if (this.generation !== gen) return;

    const tickers: WsTicker[] = [];
    const candleUpdates: BitgetCandleUpdate[] = [];

    for (const u of updates) {
      if (u.kind === 'ticker') {
        tickers.push({
          channel: 'ticker',
          instId: u.exchangeSymbol,
          last: u.last,
          bestBid: u.bestBid,
          bestAsk: u.bestAsk,
          volume24h: u.volume24h,
          high24h: u.high24h,
          low24h: u.low24h,
          ts: u.ts,
        });
      } else if (u.kind === 'candle') {
        candleUpdates.push(u);
      }
    }

    // Dispatch tickers
    if (this.tickerHandler) {
      for (const t of tickers) {
        try { this.tickerHandler(t); } catch (err: any) { this.safeReport('parse', err); }
      }
    }

    // Detector ALWAYS advances, even without a registered kline handler.
    if (candleUpdates.length > 0) {
      const closed = this.closeDetector.ingestMany(candleUpdates);
      if (this.klineHandler) {
        for (const k of closed) {
          try { this.klineHandler(k); } catch (err: any) { this.safeReport('parse', err); }
        }
      }
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  private scheduleHeartbeat(gen: number): void {
    if (this.generation !== gen || this._state !== 'running' || this.manualStop) return;

    this.heartbeatTimerHandle = this.scheduler.setTimeout(() => {
      if (this.generation !== gen || this._state !== 'running' || this.manualStop) return;
      if (!this.ws) return;

      try {
        this.ws.send('ping');
      } catch (err: any) {
        this.clearTimers();
        this.beginReconnect(gen, { phase: 'heartbeat', error: err as Error });
        return;
      }

      // Start pong wait
      this.pongTimerHandle = this.scheduler.setTimeout(() => {
        if (this.generation !== gen || this.manualStop) return;
        this.beginReconnect(gen, { phase: 'heartbeat', error: new Error('pong timeout') });
      }, this.options.pongTimeoutMs);
    }, this.options.heartbeatIntervalMs);
  }

  private onPong(gen: number): void {
    if (this.generation !== gen || this.manualStop) return;
    // Clear pong timeout and schedule next heartbeat
    if (this.pongTimerHandle !== undefined) {
      this.scheduler.clearTimeout(this.pongTimerHandle);
      this.pongTimerHandle = undefined;
    }
    this.scheduleHeartbeat(gen);
  }

  // ── Reconnect ──────────────────────────────────────────────────────────

  private startReconnectAttempt(gen: number): void {
    if (this.generation !== gen || this.manualStop) return;

    let ws: BitgetWebSocketLike;
    try {
      ws = this.wsFactory(this.options.endpoint);
    } catch (err: any) {
      this.beginReconnect(this.generation, { phase: 'reconnect', error: err as Error });
      return;
    }

    this.ws = ws;
    this._state = 'subscribing';

    this.expectedAckKeys = new Set<string>();
    for (const req of this.capturedRequests) {
      for (const a of req.args) {
        this.expectedAckKeys.add(ackKey(a));
      }
    }

    const setHandlersForReconnect = () => {
      ws.onopen = () => {
        if (this.generation !== gen || this.manualStop) return;
        this._state = 'subscribing';
        for (const req of this.capturedRequests) {
          try { ws.send(JSON.stringify(req)); } catch (err: any) {
            this.beginReconnect(this.generation, { phase: 'reconnect', error: err as Error });
            return;
          }
        }
        if (this.expectedAckKeys.size > 0) {
          this.ackTimerHandle = this.scheduler.setTimeout(() => {
            if (this.generation === gen && !this.manualStop) {
              this.beginReconnect(this.generation, { phase: 'reconnect', error: new Error('reconnect ack timeout') });
            }
          }, this.options.ackTimeoutMs);
        } else {
          this.enterRunning(gen);
        }
      };
      ws.onmessage = (event: { data: unknown }) => {
        if (this.generation !== gen || this.manualStop) return;
        this.onMessage(event.data, gen);
      };
      ws.onclose = () => {
        if (this.generation !== gen || this.manualStop) return;
        this.beginReconnect(this.generation);
      };
      ws.onerror = () => {
        if (this.generation !== gen || this.manualStop) return;
        // Always reconnect on error (unified entry)
        this.beginReconnect(this.generation);
      };
    };

    setHandlersForReconnect();
  }
}
