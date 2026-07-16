// Stage 3A3: MarketDataRuntime — ticker + kline data composition
// Stage 3A5: project confirmed kline into CandleSeriesStore as well
import type { WsTicker, WsKline } from '../../data/types';
import type { Clock } from '../../data/MarketSnapshot';
import type { MarketSnapshotStore } from '../../data/MarketSnapshot';
import type { CandleSeriesStore } from '../../data/CandleSeriesStore';
import type { TradingEventBus } from '../../events';
import type { TradingEventPayloadMap } from '../../events';
import { createTradingEventBus, KlineClosedEventRejectedError } from '../../events';
import { createMarketSnapshotStore } from '../../data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../data/CandleSeriesStore';

export interface MarketDataCollectorPort {
  start(): Promise<void>;
  stop(): void;
  onTicker(handler: (ticker: WsTicker) => void): void;
  onKline(handler: (kline: WsKline) => void): void;
}

export interface MarketDataRuntimeFailure {
  readonly source: 'collector_start' | 'collector_callback' | 'bus_publish' | 'store_subscriber';
  readonly error: unknown;
  readonly symbol?: string;
}

export interface MarketDataRuntime {
  readonly bus: TradingEventBus;
  readonly store: MarketSnapshotStore;
  readonly candleStore: CandleSeriesStore;
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): void;
}

export interface MarketDataRuntimeOptions {
  collectorFactory: () => MarketDataCollectorPort;
  clock?: Clock;
  staleAfterMs?: number;
  bus?: TradingEventBus;
  store?: MarketSnapshotStore;
  candleStore?: CandleSeriesStore;
  onError?: (failure: MarketDataRuntimeFailure) => void;
}

type Generation = number;
let nextGeneration: Generation = 0;

export function createMarketDataRuntime(
  options: MarketDataRuntimeOptions,
): MarketDataRuntime {
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const bus: TradingEventBus = options.bus ?? createTradingEventBus();
  const store: MarketSnapshotStore =
    options.store ?? createMarketSnapshotStore({ clock, staleAfterMs });
  // Stage 3A5: candle store — inject or default. Created once at runtime init,
  // preserved across stop/start cycles (no re-creation).
  const candleStore: CandleSeriesStore = options.candleStore ?? createCandleSeriesStore();
  const onError = options.onError;

  // — Internal state ------------------------------------------------

  let startPromise: Promise<void> | null = null;
  let running = false;
  let activeCollector: MarketDataCollectorPort | null = null;
  let generation: Generation = 0;
  let unsubStoreTicker: (() => void) | null = null;
  let unsubStoreKline: (() => void) | null = null;
  let cycleToken = 0;

  // — Safe error reporting ------------------------------------------

  function safeReport(failure: MarketDataRuntimeFailure): void {
    try { onError?.(failure); } catch { /* never bubble */ }
  }

  // — Store subscriber lifecycle ------------------------------------

  function subscribeStore(): void {
    if (unsubStoreTicker !== null || unsubStoreKline !== null) return;
    const unsubTicker = bus.subscribe('market.ticker.updated', (event) => {
      store.updateTicker({ ticker: event.ticker, receivedAt: event.receivedAt });
    });
    unsubStoreTicker = unsubTicker;
    try {
      unsubStoreKline = bus.subscribe('market.kline.closed', (event) => {
        // Stage 3A5: dual projection into snapshot + candle series
        store.updateClosedKline({ kline: event.kline, receivedAt: event.receivedAt });
        candleStore.appendClosedKline({ kline: event.kline, receivedAt: event.receivedAt });
      });
    } catch (err) {
      unsubStoreTicker = null;
      unsubTicker();
      throw err;
    }
  }

  function unsubscribeStore(): void {
    const t = unsubStoreTicker;
    const k = unsubStoreKline;
    unsubStoreTicker = null;
    unsubStoreKline = null;
    if (t) { try { t(); } catch (e) { safeReport({ source: 'store_subscriber', error: e }); } }
    if (k) { try { k(); } catch (e) { safeReport({ source: 'store_subscriber', error: e }); } }
  }

  // — Factory -------------------------------------------------------

  return {
    get bus(): TradingEventBus { return bus; },
    get store(): MarketSnapshotStore { return store; },
    get candleStore(): CandleSeriesStore { return candleStore; },
    get isRunning(): boolean { return running; },

    start(): Promise<void> {
      if (startPromise !== null) return startPromise;
      if (running) return Promise.resolve();

      startPromise = (async () => {
        nextGeneration += 1;
        generation = nextGeneration;
        const myGen = generation;
        const collector = options.collectorFactory();
        const myToken = ++cycleToken;

        subscribeStore();

        collector.onTicker((ticker) => {
          if (generation !== myGen || collector !== activeCollector) return;
          try {
            const receivedAt = clock.now();
            const result = bus.publish('market.ticker.updated', { ticker, receivedAt });
            if (result.failures > 0) safeReport({
              source: 'store_subscriber',
              error: new Error(`${result.failures} ticker subscriber(s) failed`),
              symbol: ticker.instId,
            });
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
            safeReport({
              source: 'bus_publish',
              error: err instanceof KlineClosedEventRejectedError ? err.message : err,
              symbol: kline.instId,
            });
          }
        });

        activeCollector = collector;

        try {
          await collector.start();
        } catch (err) {
          if (myToken === cycleToken) {
            nextGeneration += 1;
            generation = nextGeneration;
            activeCollector = null;
            running = false;
            unsubscribeStore();
            collector.stop();
            startPromise = null;
            safeReport({ source: 'collector_start', error: err });
            throw err;
          }
          return;
        }

        if (myToken === cycleToken) {
          running = true;
          startPromise = null;
        }
      })();

      return startPromise;
    },

    stop(): void {
      if (!running && activeCollector === null) return;

      cycleToken += 1;

      nextGeneration += 1;
      generation = nextGeneration;

      const collector = activeCollector;
      activeCollector = null;
      running = false;
      startPromise = null;

      unsubscribeStore();
      collector?.stop();
    },
  };
}
