// Stage 3A4: FastPipeline market data guard integration tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { DecisionEngine } from '../../src/pipeline/DecisionEngine';
import type { FastPipelineResult, FastPipelineMarketData } from '../../src/pipeline/FastPipeline';
import type { MarketBiasReportFull } from '../../src/types/market-bias';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import type { Clock, MarketSnapshotStore } from '../../src/data/MarketSnapshot';
import type { WsTicker, WsKline } from '../../src/data/types';

// ── Mocks ───────────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _now = 200_000;
  now() { return this._now; }
  advance(ms: number) { this._now += ms; }
}

const clock = new FakeClock();

const SNAPSHOT_STORE = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
const CANDLE_STORE = createCandleSeriesStore({ capacityPerSeries: 500 });

// Helper: simulate a running market data environment
function feed(symbol: string, interval: string = '1m') {
  // ticker
  const ticker: WsTicker = { channel: 'ticker', instId: symbol, last: 67000, bestBid: 66990, bestAsk: 67010, volume24h: 10000, high24h: 68000, low24h: 66000, ts: 5000 };
  SNAPSHOT_STORE.updateTicker({ ticker, receivedAt: clock.now() });

  // 200 confirmed klines
  for (let i = 1; i <= 200; i++) {
    const kline: WsKline = { channel: 'kline', instId: symbol, interval, open: 66900 + i, high: 67100 + i, low: 66800 + i, close: 67000 + i, volume: 100 + i, ts: 1000 + i * 1000, confirm: true };
    SNAPSHOT_STORE.updateClosedKline({ kline, receivedAt: clock.now() });
    CANDLE_STORE.appendClosedKline({ kline, receivedAt: clock.now() });
  }
  clock.advance(10);
}

function biasReport(symbol: string = 'BTCUSDT'): MarketBiasReportFull {
  return {
    timestamp: Date.now(),
    updatedAt: Date.now(),
    globalBias: 'bullish',
    confidence: 75,
    assets: [{ symbol, bias: 'bullish', confidence: 75, volatility: 30, direction: 'long', suggestedPositionPct: 10, entryCondition: '', stopLoss: 66000, takeProfit: 69000 }],
    globalLongShortRatio: 1.5,
    globalVolatility: 30,
    fearGreedIndex: 65,
    fundingStatus: 'neutral',
    whitelist: [symbol],
    blacklist: [],
    riskEvents: [],
    meta: { source: 'hermes_cron', modelVersion: '1', generationTimeMs: 100, inputSummary: '' },
  };
}

// Mock router that provides fresh bias report
function makeRouter(symbol = 'BTCUSDT') {
  let report = biasReport(symbol);
  return {
    getBiasReport: () => report,
    getConfig: () => ({ maxBiasReportAgeHours: 2 }),
    killSwitch: null as any,
    updateBiasReport: (r: any) => { report = r; },
  };
}

// Mock IndicatorService that records call parameters
class SpyIndicatorService {
  public lastAsset = '';
  public lastSeries: any = null;
  public callCount = 0;

  async calculateAll(req: any) {
    this.callCount += 1;
    this.lastAsset = req.asset;
    this.lastSeries = req.series ?? null;
    return [];
  }
}

function makeMarketData(store = SNAPSHOT_STORE, candle = CANDLE_STORE): FastPipelineMarketData {
  return {
    snapshotStore: store,
    candleStore: candle,
    interval: '1m',
    minimumSeries: 100,
    seriesLimit: 200,
    maxKlineAgeMs: 120_000,
  };
}

// ── 1. backward compatibility (no marketData) ───────────────────────────────

test('1. empty market data config is backward compatible', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  // Should not short-circuit on missing market data
  assert.equal(spy.callCount, 1, 'indicator service was called');
});

// ── 2. missing snapshot → skip ─────────────────────────────────────────────

test('2. missing snapshot returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter('UNKNOWNSYMBOL');
  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: makeMarketData(),
  });
  const result = await fp.execute({ source: 'test', symbol: 'UNKNOWNSYMBOL' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('no snapshot'));
  assert.equal(spy.callCount, 0, 'indicator service should NOT be called');
});

// ── 3. stale snapshot → defense ───────────────────────────────────────────

test('3. stale snapshot returns defense', async () => {
  // Create a store whose clock is way in the past so snapshot goes stale
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const slowClock = new FakeClock();
  slowClock.advance(-120_000); // clock behind → snapshot will be stale
  const staleStore = createMarketSnapshotStore({ clock: slowClock, staleAfterMs: 60_000 });
  // But feed data with a different clock so snapshot is actually recent...
  // Actually easier: create a store with very short stale window
  const tinyStore = createMarketSnapshotStore({ clock, staleAfterMs: 1 });
  const ticker: WsTicker = { channel: 'ticker', instId: 'BTCUSDT', last: 67000, bestBid: 66990, bestAsk: 67010, volume24h: 10000, high24h: 68000, low24h: 66000, ts: 5000 };
  tinyStore.updateTicker({ ticker, receivedAt: clock.now() });
  clock.advance(10); // age > staleAfterMs=1 → isStale=true

  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: { ...makeMarketData(tinyStore), maxKlineAgeMs: 999_999 },
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'defense');
  assert.ok(result.reason.includes('stale'));
  assert.equal(spy.callCount, 0, 'indicator service not called');
});

// ── 4. missing interval → skip ─────────────────────────────────────────────

test('4. missing interval in snapshot returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  // Feed only ticker, no kline at all
  const emptyStore = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const ticker: WsTicker = { channel: 'ticker', instId: 'BTCUSDT', last: 67000, bestBid: 66990, bestAsk: 67010, volume24h: 10000, high24h: 68000, low24h: 66000, ts: 5000 };
  emptyStore.updateTicker({ ticker, receivedAt: clock.now() });

  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: makeMarketData(emptyStore),
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('missing 1m kline'));
  assert.equal(spy.callCount, 0);
});

// ── 5. warm-up insufficient → skip ─────────────────────────────────────────

test('5. insufficient candle history returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  // Store with data but not enough candles for minimumSeries=100
  const lowCandle = createCandleSeriesStore({ capacityPerSeries: 500 });
  const store = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  for (let i = 1; i <= 5; i++) {
    const kline: WsKline = { channel: 'kline', instId: 'BTCUSDT', interval: '1m', open: 66900 + i, high: 67100 + i, low: 66800 + i, close: 67000 + i, volume: 100 + i, ts: 1000 + i * 1000, confirm: true };
    store.updateClosedKline({ kline, receivedAt: clock.now() });
    lowCandle.appendClosedKline({ kline, receivedAt: clock.now() });
  }
  clock.advance(10);

  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: { ...makeMarketData(store, lowCandle), minimumSeries: 100 },
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('insufficient candle history'));
  assert.ok(result.reason.includes('5/100') || result.reason.includes('5'), 'reason shows count/minimum');
  assert.equal(spy.callCount, 0);
});

// ── 6. snapshot/candle desync → skip ───────────────────────────────────────

test('6. snapshot/candle desync returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const store = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  // Feed different last ts to store vs candle
  for (let i = 1; i <= 100; i++) {
    const kline: WsKline = { channel: 'kline', instId: 'BTCUSDT', interval: '1m', open: 66900 + i, high: 67100 + i, low: 66800 + i, close: 67000 + i, volume: 100 + i, ts: 1000 + i * 1000, confirm: true };
    store.updateClosedKline({ kline, receivedAt: clock.now() });
    candle.appendClosedKline({ kline, receivedAt: clock.now() });
  }
  clock.advance(10);
  // Candle has 100 entries (ts 1001000 to 101000), snapshot last ts = 101000
  // Now manually add one more to candle to cause desync
  const extraKline: WsKline = { channel: 'kline', instId: 'BTCUSDT', interval: '1m', open: 68000, high: 68100, low: 67900, close: 68050, volume: 200, ts: 99999999, confirm: true };
  candle.appendClosedKline({ kline: extraKline, receivedAt: clock.now() });
  // Snapshot still has last ts = 101000

  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: makeMarketData(store, candle),
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('desync'));
  assert.equal(spy.callCount, 0);
});

// ── 7. healthy path: series passed to IndicatorService ─────────────────────

test('7. healthy path passes series to indicator service', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const store = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });

  for (let i = 1; i <= 150; i++) {
    const kline: WsKline = { channel: 'kline', instId: 'BTCUSDT', interval: '1m', open: 66900 + i, high: 67100 + i, low: 66800 + i, close: 67000 + i, volume: 100 + i, ts: 1000 + i * 1000, confirm: true };
    store.updateClosedKline({ kline, receivedAt: clock.now() });
    candle.appendClosedKline({ kline, receivedAt: clock.now() });
  }
  clock.advance(10);

  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: makeMarketData(store, candle),
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  assert.equal(spy.callCount, 1, 'indicator service was called');
  assert.equal(spy.lastAsset, 'BTCUSDT');
  assert.ok(Array.isArray(spy.lastSeries), 'series passed');
  assert.ok(spy.lastSeries.length >= 100, 'series has sufficient entries');
  // Oldest-first ordering
  if (spy.lastSeries.length >= 2) {
    assert.ok(spy.lastSeries[0].ts! < spy.lastSeries[spy.lastSeries.length - 1].ts!, 'oldest-first ordering');
  }
  // Should not short-circuit normally — but bias report matters for DE output
  // Just verify it returned something
  assert.ok(['trade', 'skip', 'defense'].includes(result.decision));
});

// ── 8. stale kline (age > maxKlineAgeMs) → defense ─────────────────────────

test('8. stale kline age returns defense', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();

  // Store snapshot with very old kline
  const oldClock = new FakeClock();
  const store = createMarketSnapshotStore({ clock: oldClock, staleAfterMs: 999_999 });
  const kline: WsKline = { channel: 'kline', instId: 'BTCUSDT', interval: '1m', open: 66900, high: 67100, low: 66800, close: 67000, volume: 100, ts: 1000, confirm: true };
  store.updateClosedKline({ kline, receivedAt: 1000 });

  // Candle also has the same old klines
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 1; i <= 150; i++) {
    candle.appendClosedKline({ kline: { ...kline, ts: 1000 + i * 1000 }, receivedAt: 1000 + i * 1000 });
  }
  // Move clock forward so generatedAt is far ahead of kline receivedAt
  oldClock.advance(300_000);

  const fp = new FastPipeline({
    router: router as any,
    indicatorService: spy as any,
    marketData: makeMarketData(store, candle),
  });
  const result = await fp.execute({ source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'defense');
  assert.ok(result.reason.includes('kline stale'));
  assert.equal(spy.callCount, 0);
});
