// Stage 3A3: MarketDataRuntime tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketDataRuntime } from '../../../src/runtime/market/MarketDataRuntime';
import type { MarketDataCollectorPort, MarketDataRuntimeFailure } from '../../../src/runtime/market/MarketDataRuntime';
import { createTradingEventBus } from '../../../src/events/TradingEventBus';
import { createMarketSnapshotStore } from '../../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../../src/data/CandleSeriesStore';
import type { Clock } from '../../../src/data/MarketSnapshot';
import type { WsTicker, WsKline } from '../../../src/data/types';

// ── Fake Clock ──────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _now: number = 100_000;
  now(): number { return this._now; }
  advance(ms: number): void { this._now += ms; }
  setTime(ts: number): void { this._now = ts; }
}

// ── Fake Collector ──────────────────────────────────────────────────────────

class FakeCollector implements MarketDataCollectorPort {
  private _tickerHandlers: Array<(t: WsTicker) => void> = [];
  private _klineHandlers: Array<(k: WsKline) => void> = [];
  public started = false;
  public startShouldThrow = false;
  public stopCount = 0;

  start(): Promise<void> {
    if (this.startShouldThrow) return Promise.reject(new Error('collector-start-fail'));
    this.started = true;
    return Promise.resolve();
  }
  stop(): void {
    this.stopCount += 1;
    this.started = false;
  }
  onTicker(handler: (t: WsTicker) => void): void { this._tickerHandlers.push(handler); }
  onKline(handler: (k: WsKline) => void): void { this._klineHandlers.push(handler); }

  emitTicker(t: WsTicker): void { for (const h of this._tickerHandlers) h(t); }
  emitKline(k: WsKline): void { for (const h of this._klineHandlers) h(k); }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TICKER: WsTicker = {
  channel: 'ticker', instId: 'BTCUSDT',
  last: 67000, bestBid: 66990, bestAsk: 67010,
  volume24h: 10000, high24h: 68000, low24h: 66000, ts: 5000,
};

const KLINE_CLOSED: WsKline = {
  channel: 'kline', instId: 'BTCUSDT', interval: '1m',
  open: 66900, high: 67100, low: 66800, close: 67000,
  volume: 100, ts: 5000, confirm: true,
};

const KLINE_UNCONFIRMED: WsKline = {
  ...KLINE_CLOSED, confirm: false,
};

function makeRuntime(opts: {
  clock?: FakeClock;
  collector?: FakeCollector;
  onError?: (f: MarketDataRuntimeFailure) => void;
} = {}) {
  const clock = opts.clock ?? new FakeClock();
  const collector = opts.collector ?? new FakeCollector();
  const runtime = createMarketDataRuntime({
    clock,
    collectorFactory: () => collector,
    staleAfterMs: 60_000,
    onError: opts.onError,
  });
  return { runtime, clock, collector };
}

// ── 1. start wiring: ticker → bus → store ───────────────────────────────────

test('1. start wires ticker to store via bus', async () => {
  const { runtime, clock, collector } = makeRuntime();
  await runtime.start();
  assert.equal(runtime.isRunning, true);

  collector.emitTicker(TICKER);

  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap.ticker !== null);
  assert.equal(snap.ticker!.ticker.last, 67000);
  assert.equal(snap.ticker!.receivedAt, clock.now());
});

// ── 2. start wires confirmed kline to store via bus ─────────────────────────

test('2. start wires confirmed kline to store', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();

  collector.emitKline(KLINE_CLOSED);

  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap.klines['1m'] !== undefined);
  assert.equal(snap.klines['1m'].kline.close, 67000);
});

// ── 3. unconfirmed kline filtered before bus ────────────────────────────────

test('3. unconfirmed kline filtered before bus publish', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();

  collector.emitKline(KLINE_UNCONFIRMED);

  const snap = runtime.store.getSnapshot('BTCUSDT');
  assert.equal(snap, undefined);
});

// ── 4. receivedAt injected by runtime using clock ───────────────────────────

test('4. receivedAt injected by runtime via clock', async () => {
  const clock = new FakeClock();
  clock.setTime(42_000);
  const { runtime, collector } = makeRuntime({ clock });
  await runtime.start();

  collector.emitTicker({ ...TICKER, ts: 100 });

  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.equal(snap.ticker!.receivedAt, 42_000);
});

// ── 5. start idempotent (second start returns same promise) ──────────────────

test('5. start idempotent — second start returns same promise', async () => {
  const { runtime } = makeRuntime();
  const p1 = runtime.start();
  const p2 = runtime.start();
  assert.equal(p1, p2);
  await p1;
  assert.equal(runtime.isRunning, true);
});

// ── 6. start throws → running stays false, generation reset ─────────────────

test('6. collector start failure → running false, can retry', async () => {
  const collector = new FakeCollector();
  collector.startShouldThrow = true;
  const { runtime } = makeRuntime({ collector });

  await assert.rejects(() => runtime.start(), /collector-start-fail/);
  assert.equal(runtime.isRunning, false);

  // Retry with a fresh collector
  collector.startShouldThrow = false;
  await runtime.start();
  assert.equal(runtime.isRunning, true);
});

// ── 7. stop is idempotent ───────────────────────────────────────────────────

test('7. stop is idempotent', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();
  runtime.stop();
  runtime.stop();
  runtime.stop();
  assert.equal(runtime.isRunning, false);
  assert.equal(collector.stopCount, 1);
});

// ── 8. stop invalidates late ticker callback ─────────────────────────────────

test('8. stop invalidates late ticker callback (no store mutation)', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();
  runtime.stop();

  collector.emitTicker(TICKER);

  const snap = runtime.store.getSnapshot('BTCUSDT');
  assert.equal(snap, undefined, 'late ticker must not mutate store');
});

// ── 9. stop invalidates late kline callback ─────────────────────────────────

test('9. stop invalidates late kline callback (no store mutation)', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();
  runtime.stop();

  collector.emitKline(KLINE_CLOSED);

  const snap = runtime.store.getSnapshot('BTCUSDT');
  assert.equal(snap, undefined, 'late kline must not mutate store');
});

// ── 10. restart works (fresh generation) ────────────────────────────────────

test('10. restart works: stop then start re-wires', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();
  runtime.stop();

  await runtime.start();
  assert.equal(runtime.isRunning, true);

  collector.emitTicker(TICKER);
  const snap = runtime.store.getSnapshot('BTCUSDT');
  assert.ok(snap !== undefined);
  assert.ok(snap!.ticker !== null);
});

// ── 11. restart invalidates old collector late callbacks ───────────────────

test('11. restart invalidates old collector late callbacks', async () => {
  const collectors: FakeCollector[] = [];
  const runtime = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    collectorFactory: () => {
      const c = new FakeCollector();
      collectors.push(c);
      return c;
    },
  });
  await runtime.start();
  const oldCollector = collectors[0];
  runtime.stop();

  await runtime.start();
  assert.equal(collectors.length, 2, 'factory must have been called twice');
  const newCollector = collectors[1];

  oldCollector.emitTicker({ ...TICKER, last: 11111 });
  let snap = runtime.store.getSnapshot('BTCUSDT');
  assert.equal(snap, undefined, 'old collector callback rejected');

  newCollector.emitTicker(TICKER);
  snap = runtime.store.getSnapshot('BTCUSDT');
  assert.ok(snap !== undefined);
  assert.equal(snap!.ticker!.ticker.last, 67000);
  runtime.stop();
});

// ── 12. Subscriber failure surfaces via onError ─────────────────────────────

test('12. subscriber failure surfaces via onError', async () => {
  const errors: MarketDataRuntimeFailure[] = [];
  const { runtime, collector } = makeRuntime({
    onError: (f) => errors.push(f),
  });

  runtime.bus.subscribe('market.ticker.updated', () => {
    throw new Error('subscriber-boom');
  });

  await runtime.start();
  collector.emitTicker(TICKER);

  assert.ok(errors.length >= 1, 'onError must be called for failed subscriber');
  assert.equal(errors[0].source, 'store_subscriber');
});

// ── 13. Custom bus + store injection respected ──────────────────────────────

test('13. injected bus and store are used', async () => {
  const bus = createTradingEventBus();
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  const collector = new FakeCollector();
  const runtime = createMarketDataRuntime({
    collectorFactory: () => collector,
    bus,
    store,
  });

  let observedTickers = 0;
  bus.subscribe('market.ticker.updated', () => { observedTickers += 1; });

  await runtime.start();
  collector.emitTicker(TICKER);

  assert.equal(observedTickers, 1);
  assert.ok(store.getSnapshot('BTCUSDT') !== undefined);
  assert.equal(runtime.bus, bus);
  assert.equal(runtime.store, store);
});

// ── 14. bus.publish throw surfaces via onError ──────────────────────────────

test('14. bus.publish throw surfaces via onError', async () => {
  const errors: MarketDataRuntimeFailure[] = [];
  const { collector, clock } = makeRuntime();

  const throwingBus = createTradingEventBus();
  const original = throwingBus.publish.bind(throwingBus);
  throwingBus.publish = ((type: any, payload: any) => {
    if (type === 'market.ticker.updated') {
      throw new Error('bus-publish-boom');
    }
    return original(type as any, payload as any);
  }) as any;

  const runtime = createMarketDataRuntime({
    collectorFactory: () => collector,
    clock,
    bus: throwingBus,
    onError: (f) => errors.push(f),
  });

  await runtime.start();
  collector.emitTicker(TICKER);

  assert.ok(errors.length >= 1);
  assert.equal(errors[0].source, 'bus_publish');
  runtime.stop();
});

// ── 15. multi-symbol isolation via Runtime ──────────────────────────────────

test('15. multi-symbol isolation via runtime', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();

  collector.emitTicker(TICKER);
  collector.emitTicker({ ...TICKER, instId: 'ETHUSDT', last: 3500 });

  const btc = runtime.store.getSnapshot('BTCUSDT')!;
  const eth = runtime.store.getSnapshot('ETHUSDT')!;
  assert.ok(btc !== undefined, 'BTC snapshot must exist');
  assert.ok(eth !== undefined, 'ETH snapshot must exist');
  assert.equal(btc.ticker!.ticker.last, 67000, 'BTC not overwritten by ETH');
  assert.equal(eth.ticker!.ticker.last, 3500, 'ETH not polluted by BTC');
  assert.equal(btc.snapshotVersion, 1, 'BTC version independent');
  assert.equal(eth.snapshotVersion, 1, 'ETH version independent');
  runtime.stop();
});

// ── 16. multi-interval isolation via Runtime ────────────────────────────────

test('16. multi-interval isolation via runtime', async () => {
  const { runtime, collector } = makeRuntime();
  await runtime.start();

  const kline5m: WsKline = { ...KLINE_CLOSED, interval: '5m', ts: 5000 };
  collector.emitKline(KLINE_CLOSED);
  collector.emitKline(kline5m);

  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap.klines['1m'] !== undefined, '1m must exist');
  assert.ok(snap.klines['5m'] !== undefined, '5m must exist');
  assert.equal(snap.klines['1m'].kline.close, 67000, '1m data correct');
  assert.equal(snap.klines['5m'].kline.close, 67000, '5m data correct');

  const kline1mNew: WsKline = { ...KLINE_CLOSED, ts: 5001, close: 68000 };
  collector.emitKline(kline1mNew);
  const snap2 = runtime.store.getSnapshot('BTCUSDT')!;
  assert.equal(snap2.klines['1m'].kline.close, 68000, '1m update applied');
  assert.equal(snap2.klines['5m'].kline.close, 67000, '5m not overwritten');
  runtime.stop();
});

// ── 17. onError throwing is isolated ────────────────────────────────────────

test('17. onError throwing does not break runtime', async () => {
  let onErrorCalls = 0;
  const clock = new FakeClock();
  const { runtime, collector } = makeRuntime({
    clock,
    onError: () => {
      onErrorCalls += 1;
      throw new Error('onError boom');
    },
  });

  runtime.bus.subscribe('market.ticker.updated', () => {
    throw new Error('subscriber-boom');
  });

  await runtime.start();
  collector.emitTicker(TICKER);
  assert.ok(onErrorCalls >= 1, 'onError was invoked');

  clock.advance(10);
  collector.emitTicker({ ...TICKER, last: 70000 });
  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap !== undefined, 'store still writable after onError failure');
  assert.equal(snap.ticker!.ticker.last, 70000, 'subsequent valid event processed');
  runtime.stop();
});

// ── 18. two runtime instances independent ───────────────────────────────────

test('18. two runtime instances independent', async () => {
  const clockA = new FakeClock();
  const clockB = new FakeClock();
  const collectorA = new FakeCollector();
  const collectorB = new FakeCollector();
  const runtimeA = createMarketDataRuntime({
    collectorFactory: () => collectorA,
    clock: clockA,
    staleAfterMs: 60_000,
  });
  const runtimeB = createMarketDataRuntime({
    collectorFactory: () => collectorB,
    clock: clockB,
    staleAfterMs: 60_000,
  });

  await runtimeA.start();
  await runtimeB.start();

  collectorA.emitTicker(TICKER);
  collectorB.emitTicker({ ...TICKER, instId: 'ETHUSDT', last: 3500 });

  assert.ok(runtimeA.store.getSnapshot('BTCUSDT') !== undefined, 'A has BTC');
  assert.equal(runtimeA.store.getSnapshot('ETHUSDT'), undefined, 'A has no ETH');
  assert.ok(runtimeB.store.getSnapshot('ETHUSDT') !== undefined, 'B has ETH');
  assert.equal(runtimeB.store.getSnapshot('BTCUSDT'), undefined, 'B has no BTC');
  assert.ok(runtimeA.bus !== runtimeB.bus, 'A and B have separate buses');

  runtimeA.stop();
  assert.equal(runtimeA.isRunning, false);
  assert.equal(runtimeB.isRunning, true, 'B still running after A stopped');
  clockB.advance(100);
  collectorB.emitTicker({ ...TICKER, instId: 'ETHUSDT', last: 3600 });
  const ethSnap = runtimeB.store.getSnapshot('ETHUSDT')!;
  assert.equal(ethSnap.ticker!.ticker.last, 3600, 'B still processes after A stop');
  runtimeB.stop();
});

// ── 19. stop detaches store subscribers ─────────────────────────────────────

test('19. stop detaches store subscribers (bus→store projection stops)', async () => {
  const bus = createTradingEventBus();
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  const collector = new FakeCollector();
  const runtime = createMarketDataRuntime({
    collectorFactory: () => collector,
    bus,
    store,
    clock: new FakeClock(),
  });

  // 1. Write initial ticker via collector
  await runtime.start();
  collector.emitTicker(TICKER);
  assert.ok(store.getSnapshot('BTCUSDT') !== undefined, 'initial write ok');

  const versionBefore = store.getSnapshot('BTCUSDT')!.snapshotVersion;

  // 2. Stop — Bus→Store projection should be disconnected
  runtime.stop();

  // 3. Directly publish to bus — should NOT reach store
  bus.publish('market.ticker.updated', { ticker: TICKER, receivedAt: Date.now() });

  const snap = store.getSnapshot('BTCUSDT')!;
  assert.equal(snap.snapshotVersion, versionBefore, 'version must NOT increase after stop');
  runtime.stop();
});

// ── 20. start failure removes subscribers before retry ──────────────────────

test('20. start failure removes subscribers before retry', async () => {
  const bus = createTradingEventBus();
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  const collector = new FakeCollector();
  collector.startShouldThrow = true;
  const runtime = createMarketDataRuntime({
    collectorFactory: () => collector,
    bus,
    store,
    clock: new FakeClock(),
  });

  // 1. First start fails
  await assert.rejects(() => runtime.start(), /collector-start-fail/);
  assert.equal(runtime.isRunning, false);

  // 2. Publish directly to bus after failure — should NOT reach store
  bus.publish('market.ticker.updated', { ticker: TICKER, receivedAt: Date.now() });
  assert.equal(store.getSnapshot('BTCUSDT'), undefined, 'store must remain empty after start failure');

  // 3. Retry with working collector
  collector.startShouldThrow = false;
  await runtime.start();
  assert.equal(runtime.isRunning, true);

  // 4. Single ticker → single version increment
  collector.emitTicker(TICKER);
  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap !== undefined, 'retry start writes to store');
  assert.equal(snap.snapshotVersion, 1, 'single version increment after retry');

  runtime.stop();
});

// ── PendingCollector — delays start until resolved/rejected externally ───────

class PendingCollector extends FakeCollector {
  private _resolve: (() => void) | null = null;
  private _reject: ((e: Error) => void) | null = null;

  start(): Promise<void> {
    if (this.startShouldThrow) return Promise.reject(new Error('collector-start-fail'));
    return new Promise<void>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolveStart(): void { this._resolve?.(); }
  rejectStart(e: Error): void { this._reject?.(e); }
}

// ── 21. stop while collector start is pending ────────────────────────────────

test('21. stop while collector start is pending — old cycle does not resurrect', async () => {
  const collector = new PendingCollector();
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  const bus = createTradingEventBus();
  const runtime = createMarketDataRuntime({
    collectorFactory: () => collector,
    bus,
    store,
    clock: new FakeClock(),
  });

  // Start — cycle 1 pending (collector.start hasn't resolved yet)
  const startPromise = runtime.start();
  assert.equal(runtime.isRunning, false, 'not running while start is pending');

  // Stop while start is pending
  runtime.stop();
  assert.equal(runtime.isRunning, false);
  assert.equal(collector.stopCount, 1, 'stop() calls collector.stop() even when start pending (resource guard)');

  // Resolve the old pending start
  collector.resolveStart();

  // Wait for old promise to settle
  await startPromise;

  // Runtime must still be stopped; old cycle must not set running=true
  assert.equal(runtime.isRunning, false, 'old cycle must not resurrect runtime');

  // Old collector callback must not write to store
  collector.emitTicker(TICKER);
  assert.equal(store.getSnapshot('BTCUSDT'), undefined, 'old collector callback must not mutate store');
});

// ── 22. old start resolve cannot corrupt restarted cycle ─────────────────────

test('22. old start resolve cannot corrupt restarted cycle', async () => {
  const collectorA = new PendingCollector();
  const clock = new FakeClock();
  const runtime = createMarketDataRuntime({
    collectorFactory: () => collectorA,
    clock,
    staleAfterMs: 60_000,
  });

  // Cycle 1 pending
  const p1 = runtime.start();
  assert.equal(runtime.isRunning, false);

  // Stop before cycle 1 resolves
  runtime.stop();

  // Cycle 2 — new collector
  const collectorB = new PendingCollector();
  // Rewire factory to return collectorB
  // (We can't rewire factory after creation, so we use a trick:
  //  re-create the runtime within the test to use separate collectors)
  // Actually, let's use a simpler approach: tracked factory
  const collectors: PendingCollector[] = [];
  const rt2 = createMarketDataRuntime({
    collectorFactory: () => {
      const c = new PendingCollector();
      collectors.push(c);
      return c;
    },
    clock,
    staleAfterMs: 60_000,
  });

  // Cycle 1: first start
  const p2a = rt2.start();
  const c1 = collectors[0]!;

  // Stop
  rt2.stop();
  assert.equal(rt2.isRunning, false);

  // Resolve old cycle (cycle 1)
  c1.resolveStart();
  await p2a;  // old promise resolves

  // Cycle 2
  const p2b = rt2.start();
  const c2 = collectors[1]!;

  // rt2.start() while pending returns the same promise
  const p2c = rt2.start();
  assert.equal(p2b, p2c, 'concurrent start returns same promise');

  // Resolve cycle 2
  c2.resolveStart();
  await p2b;

  assert.equal(rt2.isRunning, true, 'cycle 2 must become running');
  rt2.stop();
});

// ── 23. old start rejection cannot damage restarted cycle ────────────────────

test('23. old start rejection cannot damage restarted cycle', async () => {
  const collectors: PendingCollector[] = [];
  const bus = createTradingEventBus();
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  const runtime = createMarketDataRuntime({
    collectorFactory: () => {
      const c = new PendingCollector();
      collectors.push(c);
      return c;
    },
    bus,
    store,
    clock: new FakeClock(),
  });

  // Cycle 1 pending — will reject
  const p1 = runtime.start();
  const c1 = collectors[0]!;

  // Stop and restart
  runtime.stop();
  const p2 = runtime.start();
  const c2 = collectors[1]!;

  // Reject cycle 1 (old) — must not affect cycle 2
  c1.rejectStart(new Error('cycle-1-rejected'));
  await p1.then(() => {}, () => {}); // swallow rejection

  // Cycle 2 still works
  assert.equal(runtime.isRunning, false, 'cycle 2 still pending');
  c2.resolveStart();
  await p2;

  assert.equal(runtime.isRunning, true, 'cycle 2 must become running');

  // Cycle 2 collector writes to store — single increment
  c2.emitTicker(TICKER);
  const snap = runtime.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap !== undefined, 'cycle 2 writes to store');
  assert.equal(snap.snapshotVersion, 1, 'single version increment');
  runtime.stop();
});

// ── 24. kline event updates candleStore alongside snapshotStore ─────────────

test('24. kline event updates candleStore alongside snapshotStore', async () => {
  const collector24 = new FakeCollector();
  const candle24 = createCandleSeriesStore();
  const runtime24 = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    candleStore: candle24,
    collectorFactory: () => collector24,
  });
  await runtime24.start();

  collector24.emitKline(KLINE_CLOSED);

  // Snapshot updated
  const snap = runtime24.store.getSnapshot('BTCUSDT')!;
  assert.ok(snap.klines['1m'] !== undefined, 'snapshot updated');
  assert.equal(snap.klines['1m'].kline.close, 67000);

  // CandleStore updated
  const series = candle24.getSeries('BTCUSDT', '1m', 10);
  assert.equal(series.length, 1, 'candleStore has the kline');
  assert.equal(series[0].close, 67000);
  runtime24.stop();
});

// ── 25. injected candleStore is reused across restart ───────────────────────

test('25. injected candleStore reused across restart', async () => {
  const candle25 = createCandleSeriesStore();
  const collector25 = new FakeCollector();
  const runtime25 = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    candleStore: candle25,
    collectorFactory: () => collector25,
  });

  await runtime25.start();
  collector25.emitKline(KLINE_CLOSED);
  runtime25.stop();

  assert.equal(candle25.getSeries('BTCUSDT', '1m', 10).length, 1, '1 kline before restart');

  // Restart with same candleStore
  const collector25b = new FakeCollector();
  const runtime25b = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    candleStore: candle25,
    collectorFactory: () => collector25b,
  });
  await runtime25b.start();
  // Use a different ts so candleStore appends rather than replaces (same-ts guard)
  collector25b.emitKline({ ...KLINE_CLOSED, ts: KLINE_CLOSED.ts + 60000 });
  runtime25b.stop();

  const series = candle25.getSeries('BTCUSDT', '1m', 10);
  assert.equal(series.length, 2, 'candleStore grew (not replaced)');
  assert.equal(series[0].close, 67000, 'first kline preserved');
  assert.equal(series[1].close, 67000, 'second kline appended');
});

// ── 26. stop + direct bus.publish does not update candleStore ───────────────

test('26. stop + direct bus.publish does not update candleStore', async () => {
  const candle26 = createCandleSeriesStore();
  const bus26 = createTradingEventBus();
  const collector26 = new FakeCollector();
  const runtime26 = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    candleStore: candle26,
    bus: bus26,
    collectorFactory: () => collector26,
  });

  await runtime26.start();
  collector26.emitKline(KLINE_CLOSED);
  assert.equal(candle26.getSeries('BTCUSDT', '1m', 10).length, 1, 'kline written via collector');
  runtime26.stop();

  // Direct bus.publish after stop
  bus26.publish('market.kline.closed', { kline: KLINE_CLOSED, receivedAt: Date.now() });
  assert.equal(candle26.getSeries('BTCUSDT', '1m', 10).length, 1, 'candleStore unchanged after stop');
});

// ── 27. default candleStore created when none injected ──────────────────────

test('27. default candleStore created when none injected', () => {
  const runtime = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    collectorFactory: () => new FakeCollector(),
  });
  assert.ok(runtime.candleStore !== undefined);
  assert.equal(typeof runtime.candleStore.getSeries, 'function');
});

// ── 28. candleStore is the same instance across restart (default) ───────────

test('28. default candleStore same instance across restart', async () => {
  const collector28 = new FakeCollector();
  const runtime28 = createMarketDataRuntime({
    clock: new FakeClock(),
    staleAfterMs: 60_000,
    collectorFactory: () => collector28,
  });
  const cs1 = runtime28.candleStore;

  await runtime28.start();
  runtime28.stop();
  await runtime28.start();
  const cs2 = runtime28.candleStore;

  assert.equal(cs1, cs2, 'same candleStore instance throughout lifecycle');
  runtime28.stop();
});
