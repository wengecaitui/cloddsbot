// Stage 3A3: MarketDataRuntime — ticker + kline data composition
import type { WsTicker, WsKline } from '../../data/types';
import type { Clock } from '../../data/MarketSnapshot';
import type { MarketSnapshotStore } from '../../data/MarketSnapshot';
import type { TradingEventBus } from '../../events';
import type { TradingEventPayloadMap } from '../../events';
import { createTradingEventBus, KlineClosedEventRejectedError } from '../../events';
import { createMarketSnapshotStore } from '../../data/MarketSnapshotStore';

// ── Collector Port ──────────────────────────────────────────────────────────

export interface MarketDataCollectorPort {
  start(): Promise<void>;
  stop(): void;
  onTicker(handler: (ticker: WsTicker) => void): void;
  onKline(handler: (kline: WsKline) => void): void;
}

// ── Runtime Failure ─────────────────────────────────────────────────────────

export interface MarketDataRuntimeFailure {
  readonly source: 'collector_start' | 'collector_callback' | 'bus_publish' | 'store_subscriber';
  readonly error: unknown;
  readonly symbol?: string;
}

// ── Runtime Contract ────────────────────────────────────────────────────────

export interface MarketDataRuntime {
  readonly bus: TradingEventBus;
  readonly store: MarketSnapshotStore;
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): void;
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface MarketDataRuntimeOptions {
  collectorFactory: () => MarketDataCollectorPort;
  clock?: Clock;
  staleAfterMs?: number;
  bus?: TradingEventBus;
  store?: MarketSnapshotStore;
  onError?: (failure: MarketDataRuntimeFailure) => void;
}

// ── Generation guard ────────────────────────────────────────────────────────

type Generation = number;
let nextGeneration: Generation = 0;

// ── Factory ─────────────────────────────────────────────────────────────────

export function createMarketDataRuntime(
  options: MarketDataRuntimeOptions,
): MarketDataRuntime {
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const staleAfterMs = options.staleAfterMs ?? 60_000;

  const bus: TradingEventBus = options.bus ?? createTradingEventBus();
  const store: MarketSnapshotStore =
    options.store ?? createMarketSnapshotStore({ clock, staleAfterMs });

  const onError = options.onError;

  // — Internal state ----------------------------------------------------------

  let startPromise: Promise<void> | null = null;
  let running = false;
  let activeCollector: MarketDataCollectorPort | null = null;
  let generation: Generation = 0;
  let unsubStoreTicker: (() => void) | null = null;
  let unsubStoreKline: (() => void) | null = null;

  // — Safe error reporting ----------------------------------------------------

  function safeReport(failure: MarketDataRuntimeFailure): void {
    try {
      onError?.(failure);
    } catch {
      // onError itself must never bubble
    }
  }

  // — Store subscriber lifecycle ----------------------------------------------

  function subscribeStore(): void {
    // Only register if both are clear
    if (unsubStoreTicker !== null || unsubStoreKline !== null) return;

    const unsubTicker = bus.subscribe('market.ticker.updated', (event) => {
      store.updateTicker({ ticker: event.ticker, receivedAt: event.receivedAt });
    });
    unsubStoreTicker = unsubTicker;

    try {
      const unsubKline = bus.subscribe('market.kline.closed', (event) => {
        store.updateClosedKline({ kline: event.kline, receivedAt: event.receivedAt });
      });
      unsubStoreKline = unsubKline;
    } catch (err) {
      // Second subscription failed — roll back the first
      unsubStoreTicker = null;
      unsubTicker();
      throw err;
    }
  }

  function unsubscribeStore(): void {
    const tickerUnsub = unsubStoreTicker;
    const klineUnsub = unsubStoreKline;

    // Clear immediately (idempotent: subsequent calls find both null)
    unsubStoreTicker = null;
    unsubStoreKline = null;

    if (tickerUnsub) {
      try { tickerUnsub(); } catch (e) { safeReport({ source: 'store_subscriber', error: e }); }
    }
    if (klineUnsub) {
      try { klineUnsub(); } catch (e) { safeReport({ source: 'store_subscriber', error: e }); }
    }
  }

  // — Factory -----------------------------------------------------------------

  return {
    get bus(): TradingEventBus { return bus; },
    get store(): MarketSnapshotStore { return store; },
    get isRunning(): boolean { return running; },

    start(): Promise<void> {
      // Already starting → wait for the same promise
      if (startPromise !== null) return startPromise;
      // Already running → no-op
      if (running) return Promise.resolve();

      startPromise = (async () => {
        nextGeneration += 1;
        generation = nextGeneration;
        const myGen = generation;
        const collector = options.collectorFactory();

        // 1. Register store subscribers (only if not already registered)
        subscribeStore();

        // 2. Register collector callbacks
        collector.onTicker((ticker) => {
          if (generation !== myGen || collector !== activeCollector) return;
          try {
            const receivedAt = clock.now();
            const result = bus.publish('market.ticker.updated', { ticker, receivedAt });
            if (result.failures > 0) {
              safeReport({
                source: 'store_subscriber',
                error: new Error(`${result.failures} ticker subscriber(s) failed`),
                symbol: ticker.instId,
              });
            }
          } catch (err) {
            safeReport({ source: 'bus_publish', error: err, symbol: ticker.instId });
          }
        });

        collector.onKline((kline) => {
          if (generation !== myGen || collector !== activeCollector) return;
          if (kline.confirm !== true) return;
          try {
            const receivedAt = clock.now();
            bus.publish('market.kline.closed', { kline, receivedAt });
          } catch (err) {
            const klineResult = err instanceof KlineClosedEventRejectedError
              ? err.message
              : err;
            safeReport({ source: 'bus_publish', error: klineResult, symbol: kline.instId });
          }
        });

        // 3. Store references
        activeCollector = collector;

        // 4. Start collector
        try {
          await collector.start();
        } catch (err) {
          // Collector start failed — clean up
          nextGeneration += 1;
          generation = nextGeneration;
          activeCollector = null;
          running = false;
          unsubscribeStore();
          collector.stop();
          startPromise = null;
          safeReport({ source: 'collector_start', error: err });
          throw err; // propagate to caller
        }

        running = true;
        startPromise = null;
      })();

      return startPromise;
    },

    stop(): void {
      if (!running && activeCollector === null) return; // idempotent

      // 1. Invalidate generation (old callbacks are silently dropped)
      nextGeneration += 1;
      generation = nextGeneration;

      // 2. Save and clear collector before stopping it
      const collector = activeCollector;
      activeCollector = null;
      running = false;
      startPromise = null;

      // 3. Detach store subscribers (no more Bus → Store projection)
      unsubscribeStore();

      // 4. Stop collector
      collector?.stop();
    },
  };
}
