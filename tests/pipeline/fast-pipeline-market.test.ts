// Stage 3A4 + 3B4C2-R1: FastPipeline market data guard integration tests
//
// Stage 3B4C2-R1 changes:
//   - makeMarketData(exchange: ExchangeId): caller must provide provenance.
//   - All fixtures (ticker/kline) carry exchange matching the configured exchange.
//   - Dual-exchange isolation: same Store with bitget + binance same symbol;
//     Pipeline reads only its configured exchange; no fallback; skip on missing.
//   - Negative construction tests for illegal exchange values.
//   - reason strings now use exchange:symbol format.
//   - All positive tests use type-safe ExchangeId (no `as any` for legal data).

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
import type { ExchangeId } from '../../src/data/MarketIdentity';

// ── Mocks ───────────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _now = 200_000;
  now() { return this._now; }
  advance(ms: number) { this._now += ms; }
}

const clock = new FakeClock();

function ticker(symbol: string, ex: ExchangeId = 'bitget'): WsTicker {
  return { channel: 'ticker', exchange: ex, instId: symbol, last: 67000, bestBid: 66990, bestAsk: 67010, volume24h: 10000, high24h: 68000, low24h: 66000, ts: 5000 };
}

function kline(symbol: string, ts: number, interval = '1m', ex: ExchangeId = 'bitget'): WsKline {
  return { channel: 'kline', exchange: ex, instId: symbol, interval, open: 66901, high: 67101, low: 66801, close: 67001, volume: 101, ts, confirm: true };
}

// ── Factory ───────────────────────────────────────────────────────────────────

function makeMarketData(ex: ExchangeId, store?: MarketSnapshotStore): FastPipelineMarketData {
  return {
    exchange: ex,
    snapshotStore: store ?? createMarketSnapshotStore({ clock, staleAfterMs: 60_000 }),
    candleStore: createCandleSeriesStore({ capacityPerSeries: 500 }),
    interval: '1m',
    minimumSeries: 100,
    seriesLimit: 200,
    maxKlineAgeMs: 120_000,
  };
}

// Helper: populate a store + candle with N klines for a given exchange+symbol.
// Returns { store, candle } with the populated stores (default fresh each call).
function feed(
  ex: ExchangeId,
  symbol: string,
  count = 200,
  interval = '1m',
  storeIn?: MarketSnapshotStore,
  candleIn?: ReturnType<typeof createCandleSeriesStore>,
) {
  const store = storeIn ?? createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const candle = candleIn ?? createCandleSeriesStore({ capacityPerSeries: 500 });
  const tk = ticker(symbol, ex);
  store.updateTicker({ ticker: tk, receivedAt: clock.now() });
  for (let i = 1; i <= count; i++) {
    const kl = kline(symbol, 1000 + i * 1000, interval, ex);
    store.updateClosedKline({ kline: kl, receivedAt: clock.now() });
    candle.appendClosedKline({ kline: kl, receivedAt: clock.now() });
  }
  clock.advance(10);
  return { store, candle };
}

function biasReport(symbol: string = 'BTCUSDT'): MarketBiasReportFull {
  return {
    exchange: 'bitget',
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

function makeRouter(symbol = 'BTCUSDT', exchange = 'bitget' as const) {
  let report = biasReport(symbol);
  // Ensure report exchange matches router exchange for cross-binding tests
  if ((report as any).exchange !== exchange) {
    report = { ...report, exchange };
  }
  return {
    exchange,
    getBiasReport: () => report,
    getConfig: () => ({ maxBiasReportAgeHours: 2 }),
    killSwitch: null as any,
    updateBiasReport: (r: any) => { report = r; },
  };
}

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

// ═══════════════════════════════════════════════════════════════════════════
// Positive construction — exchange accepted
// ═══════════════════════════════════════════════════════════════════════════

test('0a. construction with exchange=bitget accepted', () => {
  const md = makeMarketData('bitget');
  const fp = new FastPipeline({
      exchange: 'bitget', router: makeRouter() as any, indicatorService: new SpyIndicatorService() as any, marketData: md });
  assert.ok(fp instanceof FastPipeline);
});

test('0b. construction with exchange=binance accepted', () => {
  const md = makeMarketData('binance');
  const fp = new FastPipeline({
      exchange: 'binance', router: makeRouter('BTCUSDT', 'binance') as any, indicatorService: new SpyIndicatorService() as any, marketData: md });
  assert.ok(fp instanceof FastPipeline);
});

// ═══════════════════════════════════════════════════════════════════════════
// Negative construction — illegal exchange rejected
// ═══════════════════════════════════════════════════════════════════════════

// These use `as any` locally because the exchange value is deliberately invalid.
test('0c. construction with coinbase rejected', () => {
  const md = { ...makeMarketData('bitget'), exchange: 'coinbase' as any };
  assert.throws(
    () => new FastPipeline({
      exchange: 'bitget', router: makeRouter() as any, indicatorService: new SpyIndicatorService() as any, marketData: md }),
    /exchange must be a valid ExchangeId/,
  );
});

test('0d. construction with empty string rejected', () => {
  const md = { ...makeMarketData('bitget'), exchange: '' as any };
  assert.throws(
    () => new FastPipeline({
      exchange: 'bitget', router: makeRouter() as any, indicatorService: new SpyIndicatorService() as any, marketData: md }),
    /exchange must be a valid ExchangeId/,
  );
});

test('0e. construction with BITGET rejected', () => {
  const md = { ...makeMarketData('bitget'), exchange: 'BITGET' as any };
  assert.throws(
    () => new FastPipeline({
      exchange: 'bitget', router: makeRouter() as any, indicatorService: new SpyIndicatorService() as any, marketData: md }),
    /exchange must be a valid ExchangeId/,
  );
});

test('0f. construction with undefined exchange rejected', () => {
  const md = { ...makeMarketData('bitget'), exchange: undefined as any };
  assert.throws(
    () => new FastPipeline({
      exchange: 'bitget', router: makeRouter() as any, indicatorService: new SpyIndicatorService() as any, marketData: md }),
    /exchange must be a valid ExchangeId/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. backward compatibility (no marketData)
// ═══════════════════════════════════════════════════════════════════════════

test('1. empty market data config is backward compatible', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(spy.callCount, 1, 'indicator service was called');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. missing snapshot → skip (exchange-isolated)
// ═══════════════════════════════════════════════════════════════════════════

test('2. missing snapshot returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter('BTCUSDT', 'binance');
  // feed bitget data, configure for binance → no snapshot
  const { store } = feed('bitget', 'BTCUSDT');
  const md = makeMarketData('binance', store);
  const fp = new FastPipeline({
      exchange: 'binance', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'binance', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('no snapshot for binance:BTCUSDT'), `reason: ${result.reason}`);
  assert.equal(spy.callCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. stale snapshot → defense
// ═══════════════════════════════════════════════════════════════════════════

test('3. stale snapshot returns defense', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const tinyStore = createMarketSnapshotStore({ clock, staleAfterMs: 1 });
  const tk = ticker('BTCUSDT', 'bitget');
  tinyStore.updateTicker({ ticker: tk, receivedAt: clock.now() });
  clock.advance(10);
  const md = { ...makeMarketData('bitget', tinyStore), maxKlineAgeMs: 999_999 };
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'defense');
  assert.ok(result.reason.includes('bitget:BTCUSDT'), `stale reason: ${result.reason}`);
  assert.equal(spy.callCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. missing interval → skip
// ═══════════════════════════════════════════════════════════════════════════

test('4. missing interval in snapshot returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const emptyStore = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const tk = ticker('BTCUSDT', 'bitget');
  emptyStore.updateTicker({ ticker: tk, receivedAt: clock.now() });
  const md = makeMarketData('bitget', emptyStore);
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('missing 1m kline for bitget:BTCUSDT'), `reason: ${result.reason}`);
  assert.equal(spy.callCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. warm-up insufficient → skip
// ═══════════════════════════════════════════════════════════════════════════

test('5. insufficient candle history returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const store = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 1; i <= 5; i++) {
    const kl = kline('BTCUSDT', 1000 + i * 1000, '1m', 'bitget');
    store.updateClosedKline({ kline: kl, receivedAt: clock.now() });
    candle.appendClosedKline({ kline: kl, receivedAt: clock.now() });
  }
  clock.advance(10);
  const md = { ...makeMarketData('bitget', store), candleStore: candle, minimumSeries: 100 };
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('insufficient candle history for bitget:BTCUSDT'), `reason: ${result.reason}`);
  assert.equal(spy.callCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. snapshot/candle desync → skip
// ═══════════════════════════════════════════════════════════════════════════

test('6. snapshot/candle desync returns skip', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const store = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 1; i <= 100; i++) {
    const kl = kline('BTCUSDT', 1000 + i * 1000, '1m', 'bitget');
    store.updateClosedKline({ kline: kl, receivedAt: clock.now() });
    candle.appendClosedKline({ kline: kl, receivedAt: clock.now() });
  }
  clock.advance(10);
  const extra = kline('BTCUSDT', 99999999, '1m', 'bitget');
  candle.appendClosedKline({ kline: extra, receivedAt: clock.now() });
  const md = makeMarketData('bitget', store);
  (md as any).candleStore = candle;
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip');
  assert.ok(result.reason.includes('snapshot/candle desync for bitget:BTCUSDT'), `reason: ${result.reason}`);
  assert.equal(spy.callCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. healthy path: series passed to IndicatorService
// ═══════════════════════════════════════════════════════════════════════════

test('7. healthy path passes series to indicator service', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const { store, candle } = feed('bitget', 'BTCUSDT', 150);
  const md = { ...makeMarketData('bitget', store), candleStore: candle };
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(spy.callCount, 1, 'indicator service was called');
  assert.equal(spy.lastAsset, 'BTCUSDT');
  assert.ok(Array.isArray(spy.lastSeries), 'series passed');
  assert.ok(spy.lastSeries.length >= 100, 'series has sufficient entries');
  if (spy.lastSeries.length >= 2) {
    assert.ok(spy.lastSeries[0].ts! < spy.lastSeries[spy.lastSeries.length - 1].ts!, 'oldest-first');
  }
  assert.ok(['trade', 'skip', 'defense'].includes(result.decision));
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. stale kline (age > maxKlineAgeMs) → defense
// ═══════════════════════════════════════════════════════════════════════════

test('8. stale kline age returns defense', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const oldClock = new FakeClock();
  const store = createMarketSnapshotStore({ clock: oldClock, staleAfterMs: 999_999 });
  const kl = kline('BTCUSDT', 1000, '1m', 'bitget');
  store.updateClosedKline({ kline: kl, receivedAt: 1000 });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 1; i <= 150; i++) {
    candle.appendClosedKline({ kline: { ...kl, ts: 1000 + i * 1000 }, receivedAt: 1000 + i * 1000 });
  }
  oldClock.advance(300_000);
  const md = { ...makeMarketData('bitget', store), candleStore: candle };
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: md });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'defense');
  assert.ok(result.reason.includes('kline stale'), `reason: ${result.reason}`);
  assert.ok(result.reason.includes('bitget:BTCUSDT'), `reason mentions exchange:symbol: ${result.reason}`);
  assert.equal(spy.callCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C2-R1 — Dual-exchange isolation (new)
// ═══════════════════════════════════════════════════════════════════════════

test('9. same store dual exchange: bitget pipeline reads only bitget', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const sharedStore = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const sharedCandle = createCandleSeriesStore({ capacityPerSeries: 500 });
  feed('bitget', 'BTCUSDT', 150, '1m', sharedStore, sharedCandle);
  feed('binance', 'BTCUSDT', 150, '1m', sharedStore, sharedCandle);
  // The bitget pipeline must see its own data — guard passes → indicator service invoked.
  const mdBitget: FastPipelineMarketData = {
    exchange: 'bitget',
    snapshotStore: sharedStore,
    candleStore: sharedCandle,
    interval: '1m', minimumSeries: 100, seriesLimit: 200, maxKlineAgeMs: 120_000,
  };
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: mdBitget });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  // Market-data guard passed → spy was called with bitget-isolated series.
  assert.equal(spy.callCount, 1, 'bitget pipeline invoked indicator service (no market-data skip)');
  assert.equal(spy.lastAsset, 'BTCUSDT');
  // And the reason is NOT a market-data skip — must be a DE-level decision.
  assert.ok(!result.reason.includes('no snapshot'), `not a missing-snapshot skip: ${result.reason}`);
  assert.ok(!result.reason.includes('missing 1m kline'), `not a missing-kline skip: ${result.reason}`);
  assert.ok(!result.reason.includes('insufficient candle'), `not a warm-up skip: ${result.reason}`);
});

test('10. same store dual exchange: binance pipeline reads only binance', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter('BTCUSDT', 'binance');
  const sharedStore = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const sharedCandle = createCandleSeriesStore({ capacityPerSeries: 500 });
  feed('bitget', 'BTCUSDT', 150, '1m', sharedStore, sharedCandle);
  feed('binance', 'BTCUSDT', 150, '1m', sharedStore, sharedCandle);
  const mdBinance: FastPipelineMarketData = {
    exchange: 'binance',
    snapshotStore: sharedStore,
    candleStore: sharedCandle,
    interval: '1m', minimumSeries: 100, seriesLimit: 200, maxKlineAgeMs: 120_000,
  };
  const fp = new FastPipeline({
      exchange: 'binance', router: router as any, indicatorService: spy as any, marketData: mdBinance });
  const result = await fp.execute({ exchange: 'binance', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(spy.callCount, 1, 'binance pipeline invoked indicator service (no market-data skip)');
  assert.equal(spy.lastAsset, 'BTCUSDT');
  assert.ok(!result.reason.includes('no snapshot'), `not a missing-snapshot skip: ${result.reason}`);
  assert.ok(!result.reason.includes('missing 1m kline'), `not a missing-kline skip: ${result.reason}`);
  assert.ok(!result.reason.includes('insufficient candle'), `not a warm-up skip: ${result.reason}`);
});

test('11. dual exchange: bitget missing, binance present → bitget pipeline skips', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter();
  const sharedStore = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const sharedCandle = createCandleSeriesStore({ capacityPerSeries: 500 });
  // Only feed binance — bitget has no data
  feed('binance', 'BTCUSDT', 150, '1m', sharedStore, sharedCandle);
  const mdBitget: FastPipelineMarketData = {
    exchange: 'bitget',
    snapshotStore: sharedStore,
    candleStore: sharedCandle,
    interval: '1m', minimumSeries: 100, seriesLimit: 200, maxKlineAgeMs: 120_000,
  };
  const fp = new FastPipeline({
      exchange: 'bitget', router: router as any, indicatorService: spy as any, marketData: mdBitget });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip', 'bitget pipeline must skip — no bitget data despite binance having it');
  assert.ok(result.reason.includes('bitget:BTCUSDT'), `reason mentions exchange:symbol: ${result.reason}`);
  assert.equal(spy.callCount, 0, 'indicator service must NOT be called when bitget data is absent');
});

test('12. dual exchange: binance missing, bitget present → binance pipeline skips (no fallback)', async () => {
  const spy = new SpyIndicatorService();
  const router = makeRouter('BTCUSDT', 'binance');
  const sharedStore = createMarketSnapshotStore({ clock, staleAfterMs: 60_000 });
  const sharedCandle = createCandleSeriesStore({ capacityPerSeries: 500 });
  feed('bitget', 'BTCUSDT', 150, '1m', sharedStore, sharedCandle);
  const mdBinance: FastPipelineMarketData = {
    exchange: 'binance',
    snapshotStore: sharedStore,
    candleStore: sharedCandle,
    interval: '1m', minimumSeries: 100, seriesLimit: 200, maxKlineAgeMs: 120_000,
  };
  const fp = new FastPipeline({
      exchange: 'binance', router: router as any, indicatorService: spy as any, marketData: mdBinance });
  const result = await fp.execute({ exchange: 'bitget', source: 'test', symbol: 'BTCUSDT' });
  assert.equal(result.decision, 'skip', 'binance pipeline skips — no binance data, must NOT fall back to bitget');
  assert.equal(spy.callCount, 0);
});
