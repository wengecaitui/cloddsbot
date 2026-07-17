// Stage 3B3C + 3B3C-R1 + 3B3C-R2: Binance USD-M Public Collector
//
// Architecture:
//   SubscriptionPlan → Planner → route batches:
//     market  (ticker + kline)  → one socket
//     public  (bookTicker)      → one socket (only when ticker=true)
//
// Lifecycle:
//   start() opens both sockets → waits for all subscribe acks → running
//   ticker + bookTicker cached per symbol, merged into WsTicker on either update
//   Kline: x=true → WsKline with confirm=true; x=false → skip
//   Closed candle dedup by (exchangeSymbol, interval, startTs)
//   Stale socket isolated by generation token
//   Per-route inactivity watchdog — one route's data cannot mask another's silence
//   24h rotation timer closes connection and triggers reconnect after lifetimeMs
//
// Hardening (R1, R2):
//   - Outbound subscribe JSON strictly { method, params, id } — no internal route field
//   - Ack race fixed: onAck accepts acks during both connecting and subscribing;
//     maybeEnterRunning() gates transition until all routes open + all ids acked
//   - Pre-open onerror rejects start immediately, retires all sockets, reports once
//   - Reconnect route factory failure closes partial sockets, uses unified reconnect
//   - Reconnect clears ticker + bookTicker caches (prevents cross-generation merge);
//     closedCandles preserved across reconnect
//   - Per-route inactivity watchdog — each required route gets its own timer
//   - Watchdog/rotation report failure exactly once via beginReconnect's failure arg

import type { SubscriptionPlan } from '../../runtime/market/UniverseManager';
import type { WsTicker, WsKline } from '../types';
import {
  planBinanceSubscriptionRequests,
  type BinanceSubscriptionRequest,
  type BinanceSubscriptionPlannerOptions,
  type BinanceRoute,
} from './BinanceSubscriptionPlanner';
import {
  parseBinancePublicMessage,
  type BinanceParsedFrame,
  type BinanceTickerUpdate,
  type BinanceBookTickerUpdate,
  type BinanceKlineUpdate,
  type BinanceDataFrame,
} from './BinancePublicMessageParser';
import type { Clock } from '../../data/MarketSnapshot';

// ── Externally visible types ──────────────────────────────────────────────

export const BINANCE_MARKET_ENDPOINT = 'wss://fstream.binance.com/market/ws';
export const BINANCE_PUBLIC_ENDPOINT = 'wss://fstream.binance.com/public/ws';

export type BinanceCollectorState = 'idle' | 'connecting' | 'subscribing' | 'running' | 'reconnect_wait' | 'stopped' | 'failed';

export interface BinanceWSLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type BinanceWebSocketFactory = (url: string) => BinanceWSLike;

export interface BinanceTimerScheduler {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BinanceCollectorFailure {
  readonly phase: 'connect' | 'send' | 'subscribe' | 'parse' | 'reconnect' | 'watchdog' | 'rotation';
  readonly error: Error;
}

export interface BinanceV2PublicCollectorOptions {
  readonly plan: SubscriptionPlan;
  readonly marketEndpoint?: string;
  readonly publicEndpoint?: string;
  readonly webSocketFactory?: BinanceWebSocketFactory;
  readonly scheduler?: BinanceTimerScheduler;
  readonly clock?: Clock;
  readonly ackTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly inactivityPeriodMs?: number;
  readonly lifetimeMs?: number;
  readonly plannerOptions?: Pick<BinanceSubscriptionPlannerOptions, 'maxStreamsPerRequest' | 'startId'>;
}

// ── Internal cache ────────────────────────────────────────────────────────

interface TickerCache {
  readonly exchangeSymbol: string;
  last: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  ts: number;
}

interface BookTickerCache {
  readonly exchangeSymbol: string;
  bestBid: number;
  bestAsk: number;
}

interface ClosedCandleKey {
  readonly exchangeSymbol: string;
  readonly interval: string;
  readonly startTs: number;
}

function candleKey(es: string, interval: string, startTs: number): ClosedCandleKey {
  return { exchangeSymbol: es, interval, startTs };
}
function keyStr(k: ClosedCandleKey): string {
  return `${k.exchangeSymbol}|${k.interval}|${k.startTs}`;
}

// ── Route socket wrapper ──────────────────────────────────────────────────

interface RouteSocket {
  route: BinanceRoute;
  ws: BinanceWSLike | null;
  requests: readonly BinanceSubscriptionRequest[];
  pendingIds: Set<number>;
  isOpen: boolean;
}

// ── Outbound JSON shape ────────────────────────────────────────────────────

function subscribePayload(req: BinanceSubscriptionRequest): string {
  return JSON.stringify({
    method: req.method,
    params: req.params,
    id: req.id,
  });
}

// ── Default factory / scheduler / clock ───────────────────────────────────

function defaultWebSocketFactory(url: string): BinanceWSLike {
  if (typeof (globalThis as any).WebSocket !== 'function') {
    throw new Error('BinanceV2PublicCollector: WebSocket not available in this runtime');
  }
  return new (globalThis as any).WebSocket(url) as BinanceWSLike;
}

const defaultScheduler: BinanceTimerScheduler = {
  setTimeout: (h, d) => globalThis.setTimeout(h, d),
  clearTimeout: (h) => globalThis.clearTimeout(h as any),
};

const defaultClock: Clock = { now: () => Date.now() };

function clonePlan(plan: SubscriptionPlan): SubscriptionPlan {
  const entries = plan.entries.map(e => ({
    symbol: e.symbol,
    exchangeSymbol: e.exchangeSymbol,
    intervals: [...e.intervals],
    ticker: e.ticker,
  }));
  return { version: plan.version, entries };
}

// ── Collector ─────────────────────────────────────────────────────────────

export class BinanceV2PublicCollector {
  private options: Required<Omit<BinanceV2PublicCollectorOptions, 'plannerOptions'>> & { plannerOptions?: Pick<BinanceSubscriptionPlannerOptions, 'maxStreamsPerRequest' | 'startId'> };
  private _state: BinanceCollectorState = 'idle';
  private _planVersion: number;
  private generation = 0;
  private manualStop = false;

  private routeSockets: RouteSocket[] = [];

  private wsFactory: BinanceWebSocketFactory;
  private scheduler: BinanceTimerScheduler;
  private clock: Clock;

  private startResolve: ((value: void | PromiseLike<void>) => void) | null = null;
  private startReject: ((reason: unknown) => void) | null = null;
  private startPromise: Promise<void> | null = null;

  // Timers
  private ackTimerHandle: unknown = undefined;
  private reconnectTimerHandle: unknown = undefined;
  private inactivityTimers: Map<string, unknown> = new Map();
  private rotationTimerHandle: unknown = undefined;

  // Data
  private tickerCaches: Map<string, TickerCache> = new Map();
  private bookTickerCaches: Map<string, BookTickerCache> = new Map();
  private closedCandles: Set<string> = new Set();
  private capturedRequests: readonly BinanceSubscriptionRequest[] = [];

  private tickerHandler: ((t: WsTicker) => void) | null = null;
  private klineHandler: ((k: WsKline) => void) | null = null;
  private errorHandler: ((f: BinanceCollectorFailure) => void) | null = null;

  constructor(options: BinanceV2PublicCollectorOptions) {
    for (const v of [options.ackTimeoutMs ?? 10000, options.reconnectDelayMs ?? 3000, options.inactivityPeriodMs ?? 7_200_000, options.lifetimeMs ?? 82_800_000]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
        throw new Error('BinanceV2PublicCollector: timeout/delay values must be positive integers');
      }
    }

    const capturedPlan = clonePlan(options.plan);
    this._planVersion = capturedPlan.version;
    this.capturedRequests = planBinanceSubscriptionRequests(capturedPlan, 'SUBSCRIBE', {
      maxStreamsPerRequest: options.plannerOptions?.maxStreamsPerRequest,
      startId: options.plannerOptions?.startId,
    });

    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.clock ?? defaultClock;

    this.options = {
      plan: capturedPlan,
      marketEndpoint: options.marketEndpoint ?? BINANCE_MARKET_ENDPOINT,
      publicEndpoint: options.publicEndpoint ?? BINANCE_PUBLIC_ENDPOINT,
      webSocketFactory: this.wsFactory,
      scheduler: this.scheduler,
      clock: defaultClock,
      ackTimeoutMs: options.ackTimeoutMs ?? 10000,
      reconnectDelayMs: options.reconnectDelayMs ?? 3000,
      inactivityPeriodMs: options.inactivityPeriodMs ?? 7_200_000,
      lifetimeMs: options.lifetimeMs ?? 82_800_000,
      plannerOptions: options.plannerOptions,
    };

    this.initRouteSockets();
  }

  get state(): BinanceCollectorState { return this._state; }
  get planVersion(): number { return this._planVersion; }

  onTicker(h: (t: WsTicker) => void): void { this.tickerHandler = h; }
  onKline(h: (k: WsKline) => void): void { this.klineHandler = h; }
  onError(h: (f: BinanceCollectorFailure) => void): void { this.errorHandler = h; }

  // ── Lifecycle: start ─────────────────────────────────────────────────────

  start(): Promise<void> {
    if (this._state === 'stopped') {
      return Promise.reject(new Error('BinanceV2PublicCollector: collector is stopped'));
    }
    if (this._state === 'failed') {
      return Promise.reject(new Error('BinanceV2PublicCollector: collector startup previously failed'));
    }
    if (this.startPromise !== null) return this.startPromise;
    if (this._state === 'running') return Promise.resolve();

    this._state = 'connecting';
    this.manualStop = false;
    const gen = ++this.generation;

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;

      this.initRouteSockets();
      const socketsToCreate = this.routeSockets.length;

      if (socketsToCreate === 0) {
        this.enterRunning(gen);
        return;
      }

      for (const rs of this.routeSockets) {
        try {
          const endpoint = rs.route === 'market' ? this.options.marketEndpoint : this.options.publicEndpoint;
          rs.ws = this.wsFactory(endpoint);
        } catch (err: any) {
          this.handleStartupError(gen, err, 'connect');
          return;
        }
        rs.isOpen = false;
        const ws = rs.ws!;
        const capturedRs = rs;

        ws.onopen = () => {
          if (this.generation !== gen || this.manualStop) return;
          capturedRs.isOpen = true;

          capturedRs.pendingIds = new Set(capturedRs.requests.map(r => r.id));
          for (const req of capturedRs.requests) {
            try {
              ws.send(subscribePayload(req));
            } catch (err: any) {
              this.handleStartupError(gen, err, 'send');
              return;
            }
          }

          if (this._state === 'connecting') {
            this._state = 'subscribing';
          }
          if (this.ackTimerHandle === undefined && capturedRs.pendingIds.size > 0) {
            this.ackTimerHandle = this.scheduler.setTimeout(() => {
              if (this.generation === gen && !this.manualStop) {
                const totalPending = this.routeSockets.reduce((sum, r) => sum + r.pendingIds.size, 0);
                this.handleStartupError(gen, new Error(`ack timeout: ${totalPending} pending ids`), 'subscribe');
              }
            }, this.options.ackTimeoutMs);
          }
          this.maybeEnterRunning(gen);
        };

        ws.onmessage = (event: { data: unknown }) => {
          if (this.generation !== gen || this.manualStop) return;
          this.onMessage(event.data, gen, capturedRs);
        };

        ws.onclose = () => {
          if (this.generation !== gen || this.manualStop) return;
          if (!capturedRs.isOpen || this._state === 'connecting' || this._state === 'subscribing') {
            this.handleStartupError(gen, new Error('socket closed before startup'), 'connect');
            return;
          }
          this.beginReconnect(gen);
        };

        ws.onerror = () => {
          if (this.generation !== gen || this.manualStop) return;
          if (this._state === 'connecting' || this._state === 'subscribing') {
            // Reject start immediately — do NOT wait for onclose which may never fire.
            this.handleStartupError(gen, new Error('socket error during startup'), 'connect');
            return;
          }
          if (this._state === 'running') {
            this.beginReconnect(gen);
          }
        };
      }
    });

    return this.startPromise;
  }

  // ── Lifecycle: stop ─────────────────────────────────────────────────────

  stop(): void {
    if (this._state === 'stopped') return;
    this.manualStop = true;
    this.generation += 1;
    this._state = 'stopped';
    this.clearTimers();
    this.tickerCaches.clear();
    this.bookTickerCaches.clear();
    this.closedCandles.clear();

    if (this.startPromise !== null && this.startReject) {
      const reject = this.startReject;
      this.startPromise = null;
      this.startResolve = null;
      this.startReject = null;
      reject(new Error('BinanceV2PublicCollector: collector is stopped'));
    }

    this.closeAllSockets();
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private safeReport(phase: BinanceCollectorFailure['phase'], error: Error): void {
    try { this.errorHandler?.({ phase, error }); } catch { /* never bubble */ }
  }

  private clearTimers(): void {
    if (this.ackTimerHandle !== undefined) { this.scheduler.clearTimeout(this.ackTimerHandle); this.ackTimerHandle = undefined; }
    if (this.reconnectTimerHandle !== undefined) { this.scheduler.clearTimeout(this.reconnectTimerHandle); this.reconnectTimerHandle = undefined; }
    // Clear per-route inactivity timers
    for (const [route, handle] of this.inactivityTimers) {
      this.scheduler.clearTimeout(handle);
    }
    this.inactivityTimers.clear();
    if (this.rotationTimerHandle !== undefined) { this.scheduler.clearTimeout(this.rotationTimerHandle); this.rotationTimerHandle = undefined; }
  }

  private closeAllSockets(): void {
    for (const rs of this.routeSockets) {
      if (rs.ws) {
        rs.ws.onopen = null;
        rs.ws.onmessage = null;
        rs.ws.onclose = null;
        rs.ws.onerror = null;
        try { rs.ws.close(); } catch { /* ignore */ }
        rs.ws = null;
        rs.isOpen = false;
      }
    }
  }

  private retireAllSockets(expectedGeneration: number): boolean {
    if (this.generation !== expectedGeneration) return false;
    this.clearTimers();
    this.generation += 1;
    this.closeAllSockets();
    return true;
  }

  private handleStartupError(gen: number, error: Error, phase: BinanceCollectorFailure['phase']): void {
    if (this.generation !== gen || this.manualStop) return;
    this.retireAllSockets(gen);
    this._state = 'failed';
    if (this.startReject) {
      const reject = this.startReject;
      this.startPromise = null;
      this.startResolve = null;
      this.startReject = null;
      reject(error);
    }
    this.safeReport(phase, error);
  }

  private maybeEnterRunning(gen: number): void {
    if (this.generation !== gen || this.manualStop) return;
    if (this._state !== 'connecting' && this._state !== 'subscribing') return;

    const allOpen = this.routeSockets.every(r => r.isOpen && r.ws !== null);
    if (!allOpen) return;

    const totalPending = this.routeSockets.reduce((sum, r) => sum + r.pendingIds.size, 0);
    if (totalPending > 0) return;

    if (this.ackTimerHandle !== undefined) {
      this.scheduler.clearTimeout(this.ackTimerHandle);
      this.ackTimerHandle = undefined;
    }
    this.enterRunning(gen);
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

    // Start per-route inactivity watchdogs
    for (const rs of this.routeSockets) {
      this.scheduleInactivityTimer(gen, rs.route);
    }
    this.startRotationTimer(gen);
  }

  // ── Unified reconnect ──────────────────────────────────────────────────

  private beginReconnect(expectedGeneration: number, failure?: BinanceCollectorFailure): void {
    if (this.manualStop) return;
    if (this._state === 'stopped' || this._state === 'failed') return;
    if (this.generation !== expectedGeneration) return;

    if (failure) this.safeReport(failure.phase, failure.error);

    // Clear caches on reconnect — prevents stale ticker/bookTicker from a
    // previous connection generation merging with fresh data from the new one.
    // closedCandles is PRESERVED across reconnect (dedup state is durable).
    this.tickerCaches.clear();
    this.bookTickerCaches.clear();

    this.retireAllSockets(expectedGeneration);

    if (this._state === 'reconnect_wait') return;

    this._state = 'reconnect_wait';
    const waitGeneration = this.generation;

    this.reconnectTimerHandle = this.scheduler.setTimeout(() => {
      this.reconnectTimerHandle = undefined;
      if (this.generation !== waitGeneration || this.manualStop) return;
      this._state = 'connecting';
      const newGen = ++this.generation;
      this.startReconnectAttempt(newGen);
    }, this.options.reconnectDelayMs);
  }

  private startReconnectAttempt(gen: number): void {
    if (this.generation !== gen || this.manualStop) return;

    this.initRouteSockets();
    const total = this.routeSockets.length;

    if (total === 0) {
      this.enterRunning(gen);
      return;
    }

    for (const rs of this.routeSockets) {
      try {
        const endpoint = rs.route === 'market' ? this.options.marketEndpoint : this.options.publicEndpoint;
        rs.ws = this.wsFactory(endpoint);
      } catch (err: any) {
        // Factory failed — close any sockets already created in this iteration
        // and use unified reconnect (no custom bypass logic).
        this.closeAllSockets();
        this.beginReconnect(gen, { phase: 'connect', error: err as Error });
        return;
      }
      rs.isOpen = false;
      const ws = rs.ws!;
      const capturedRs = rs;

      ws.onopen = () => {
        if (this.generation !== gen || this.manualStop) return;
        capturedRs.isOpen = true;

        capturedRs.pendingIds = new Set(capturedRs.requests.map(r => r.id));
        for (const req of capturedRs.requests) {
          try { ws.send(subscribePayload(req)); } catch (err: any) {
            this.safeReport('send', err as Error);
            this.beginReconnect(gen);
            return;
          }
        }

        if (this._state === 'connecting') {
          this._state = 'subscribing';
        }
        if (this.ackTimerHandle === undefined && capturedRs.pendingIds.size > 0) {
          this.ackTimerHandle = this.scheduler.setTimeout(() => {
            if (this.generation === gen && !this.manualStop) {
              const totalPending = this.routeSockets.reduce((s, r) => s + r.pendingIds.size, 0);
              this.safeReport('subscribe', new Error(`reconnect ack timeout: ${totalPending} pending`));
              this.beginReconnect(gen);
            }
          }, this.options.ackTimeoutMs);
        }
        this.maybeEnterRunning(gen);
      };

      ws.onmessage = (event: { data: unknown }) => {
        if (this.generation !== gen || this.manualStop) return;
        this.onMessage(event.data, gen, capturedRs);
      };

      ws.onclose = () => {
        if (this.generation !== gen || this.manualStop) return;
        this.beginReconnect(gen);
      };

      ws.onerror = () => {
        if (this.generation !== gen || this.manualStop) return;
        this.beginReconnect(gen);
      };
    }
  }

  // ── Route init ──────────────────────────────────────────────────────────

  private initRouteSockets(): void {
    this.routeSockets = [];

    const marketReqs = this.capturedRequests.filter(r => r.route === 'market');
    const publicReqs = this.capturedRequests.filter(r => r.route === 'public');

    if (marketReqs.length > 0) {
      this.routeSockets.push({ route: 'market', ws: null, requests: marketReqs, pendingIds: new Set(), isOpen: false });
    }
    if (publicReqs.length > 0) {
      this.routeSockets.push({ route: 'public', ws: null, requests: publicReqs, pendingIds: new Set(), isOpen: false });
    }
  }

  // ── Message processing ──────────────────────────────────────────────────

  private onMessage(data: unknown, gen: number, routeSocket: RouteSocket): void {
    if (this.generation !== gen) return;

    // Per-route inactivity timer: reset the timer for THIS route only.
    this.resetRouteInactivityTimer(gen, routeSocket.route);

    let frame: BinanceParsedFrame;
    try {
      frame = parseBinancePublicMessage(data);
    } catch (err: any) {
      this.safeReport('parse', err as Error);
      return;
    }

    try {
      switch (frame.kind) {
        case 'ack':
          this.onAck(frame.id, gen, routeSocket);
          break;
        case 'error':
          this.onProtocolError(frame, gen);
          break;
        case 'data':
          if (this._state === 'running') {
            this.onDataFrame(frame, gen);
          }
          break;
        case 'ignored':
          break;
        case 'malformed':
          this.safeReport('parse', new Error(frame.reason));
          break;
      }
    } catch (err: any) {
      this.safeReport('parse', err as Error);
    }
  }

  private onAck(id: number, gen: number, routeSocket: RouteSocket): void {
    if (this.generation !== gen) return;
    if (this._state !== 'connecting' && this._state !== 'subscribing') return;

    if (routeSocket.pendingIds.has(id)) {
      routeSocket.pendingIds.delete(id);
      this.maybeEnterRunning(gen);
    }
  }

  private onProtocolError(frame: { message: string; code: string }, gen: number): void {
    if (this.generation !== gen) return;
    if (this._state === 'connecting' || this._state === 'subscribing') {
      this.handleStartupError(gen, new Error(`subscription error: ${frame.code} ${frame.message}`), 'subscribe');
      return;
    }
    if (this._state === 'running') {
      this.beginReconnect(gen, { phase: 'subscribe', error: new Error(`${frame.code} ${frame.message}`) });
    }
  }

  private onDataFrame(frame: BinanceDataFrame, gen: number): void {
    if (this.generation !== gen) return;

    const tickersToEmit: WsTicker[] = [];

    for (const ev of frame.events) {
      if (ev.kind === 'ticker') {
        this.tickerCaches.set(ev.exchangeSymbol.toLowerCase(), {
          exchangeSymbol: ev.exchangeSymbol,
          last: ev.last,
          high24h: ev.high24h,
          low24h: ev.low24h,
          volume24h: ev.volume24h,
          ts: ev.ts,
        });
        const merged = this.tryMerge(ev.exchangeSymbol);
        if (merged) tickersToEmit.push(merged);
      } else if (ev.kind === 'bookTicker') {
        this.bookTickerCaches.set(ev.exchangeSymbol.toLowerCase(), {
          exchangeSymbol: ev.exchangeSymbol,
          bestBid: ev.bestBid,
          bestAsk: ev.bestAsk,
        });
        const merged = this.tryMerge(ev.exchangeSymbol);
        if (merged) tickersToEmit.push(merged);
      } else if (ev.kind === 'kline') {
        if (!ev.closed) continue;
        const k = candleKey(ev.exchangeSymbol, ev.interval, ev.startTs);
        const sk = keyStr(k);
        if (this.closedCandles.has(sk)) continue;
        this.closedCandles.add(sk);

        if (this.klineHandler) {
          try {
            this.klineHandler({
              channel: 'kline',
              instId: ev.exchangeSymbol,
              interval: ev.interval,
              open: ev.open,
              high: ev.high,
              low: ev.low,
              close: ev.close,
              volume: ev.volume,
              ts: ev.startTs,
              confirm: true,
            });
          } catch (err: any) { this.safeReport('parse', err); }
        }
      }
    }

    if (this.tickerHandler) {
      for (const t of tickersToEmit) {
        try { this.tickerHandler(t); } catch (err: any) { this.safeReport('parse', err); }
      }
    }
  }

  private tryMerge(exchangeSymbol: string): WsTicker | null {
    const key = exchangeSymbol.toLowerCase();
    const tc = this.tickerCaches.get(key);
    const bc = this.bookTickerCaches.get(key);
    if (!tc || !bc) return null;

    return {
      channel: 'ticker',
      instId: tc.exchangeSymbol,
      last: tc.last,
      bestBid: bc.bestBid,
      bestAsk: bc.bestAsk,
      volume24h: tc.volume24h,
      high24h: tc.high24h,
      low24h: tc.low24h,
      ts: tc.ts,
    };
  }

  // ── Per-route inactivity watchdog ──────────────────────────────────────
  //
  // Each required route (market, public) gets its own inactivity timer.
  // Data on one route does NOT reset the other route's timer.
  // When any route times out: all sockets retired + single reconnect.
  // Reports failure exactly once via beginReconnect's failure argument.

  private resetRouteInactivityTimer(gen: number, route: BinanceRoute): void {
    if (this.generation !== gen) return;
    const existing = this.inactivityTimers.get(route);
    if (existing !== undefined) {
      this.scheduler.clearTimeout(existing);
    }
    this.scheduleInactivityTimer(gen, route);
  }

  private scheduleInactivityTimer(gen: number, route: BinanceRoute): void {
    if (this.generation !== gen) return;
    const handle = this.scheduler.setTimeout(() => {
      if (this.generation !== gen || this.manualStop) return;
      const existing = this.inactivityTimers.get(route);
      if (existing === handle) {
        this.inactivityTimers.delete(route);
      }
      this.beginReconnect(gen, { phase: 'watchdog', error: new Error(`inactivity timeout: ${route} route`) });
    }, this.options.inactivityPeriodMs);
    this.inactivityTimers.set(route, handle);
  }

  // ── Active connection rotation ──────────────────────────────────────────

  private startRotationTimer(gen: number): void {
    if (this.generation !== gen) return;
    this.rotationTimerHandle = this.scheduler.setTimeout(() => {
      if (this.generation !== gen || this.manualStop) return;
      this.beginReconnect(gen, { phase: 'rotation', error: new Error('connection lifetime exceeded') });
    }, this.options.lifetimeMs);
  }
}
