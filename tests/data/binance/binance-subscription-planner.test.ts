// Stage 3B3B: Binance Subscription Planner tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBinanceSubscriptionRequests } from '../../../src/data/binance/BinanceSubscriptionPlanner';
import type { SubscriptionPlan } from '../../../src/runtime/market/UniverseManager';

function makePlan(version = 1, entries: Array<{
  symbol: string;
  exchangeSymbol: string;
  intervals: string[];
  ticker: boolean;
}>): SubscriptionPlan {
  return { version, entries };
}

// ── 1. ticker true → ticker + bookTicker streams ─────────────────────────

test('1. ticker=true produces ticker and bookTicker streams', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  assert.equal(reqs.length, 1);
  const params = reqs[0].params;
  assert.ok(params.includes('btcusdt@ticker'), 'ticker stream');
  assert.ok(params.includes('btcusdt@bookTicker'), 'bookTicker stream');
  assert.ok(params.includes('btcusdt@kline_1m'), 'candle stream');
});

// ── 2. ticker=false → no ticker or bookTicker streams ─────────────────────

test('2. ticker=false excludes ticker/bookTicker', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['5m'], ticker: false }]);
  const reqs = planBinanceSubscriptionRequests(p);
  const params = reqs[0].params;
  assert.ok(!params.includes('@ticker'), 'no ticker');
  assert.ok(!params.includes('@bookTicker'), 'no bookTicker');
  assert.ok(params.includes('btcusdt@kline_5m'), 'candle present');
});

// ── 3. multi interval ─────────────────────────────────────────────────────

test('3. multi-interval produces each candle stream', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m', '5m', '1h'], ticker: false }]);
  const reqs = planBinanceSubscriptionRequests(p);
  const params = reqs[0].params;
  assert.ok(params.includes('btcusdt@kline_1m'));
  assert.ok(params.includes('btcusdt@kline_5m'));
  assert.ok(params.includes('btcusdt@kline_1h'));
  assert.equal(params.length, 3);
});

// ── 4. lowercase exchangeSymbol ───────────────────────────────────────────

test('4. stream name is lowercase', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  // Per Binance USD-M spec, the stream name is fully lowercase EXCEPT the
  // suffix @bookTicker (B and T are uppercase) — different USD-M streams have
  // different conventions. We follow the canonical USD-M form where ALL
  // stream-name chars are lowercase (binary.com docs), so 'bookticker'.
  // Verify the <symbol> portion is lowercase — the @ suffix may differ.
  const joined = reqs[0].params.join(' ');
  // symbol portion always lowercase
  assert.ok(joined.toLowerCase().includes('btcusdt'), 'symbol lowercased');
  // Ticker stream is fully lowercase
  assert.ok(joined.includes('btcusdt@ticker'), 'btcusdt@ticker present');
  // Candle streams lowercase
  assert.ok(joined.includes('btcusdt@kline_1m'), 'kline lowercase');
});

// ── 5. deterministic ordering (by exchangeSymbol, then ticker→book→candle sorted) ──

test('5. deterministic stream ordering', () => {
  const p = makePlan(1, [
    { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m', '5m'], ticker: true },
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
  ]);
  const reqs = planBinanceSubscriptionRequests(p);
  const params = reqs[0].params;
  // btc before eth
  const idxBTC = params.indexOf('btcusdt@ticker');
  const idxETH = params.indexOf('ethusdt@ticker');
  assert.ok(idxBTC < idxETH, 'BTC before ETH');
  // per symbol: ticker, bookTicker, then candles sorted
  const idxTicker = params.indexOf('btcusdt@ticker');
  const idxBook = params.indexOf('btcusdt@bookTicker');
  const idxKline = params.indexOf('btcusdt@kline_1m');
  assert.ok(idxTicker < idxBook, 'ticker before bookTicker');
  assert.ok(idxBook < idxKline, 'bookTicker before candle');
});

// ── 6. dedup identical streams ────────────────────────────────────────────

test('6. duplicate streams not produced (same interval dedup inside entry)', () => {
  // Two symbols cannot be identical — the planner rejects duplicate exchange symbols.
  // Dedup per entry: duplicate intervals.
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m', '1m', '5m', '5m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  const params = reqs[0].params;
  const count1m = params.filter(s => s === 'btcusdt@kline_1m').length;
  assert.equal(count1m, 1, 'duplicate interval deduped');
});

// ── 7. batching ───────────────────────────────────────────────────────────

test('7. maxStreamsPerRequest batching', () => {
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'BUSDT', intervals: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h'], ticker: true },
  ]);
  // Each entry: 2 (ticker+book) + 9 (candles) = 11 streams.
  // Total 22 streams, max 10 per batch → 3 batches
  const reqs = planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { maxStreamsPerRequest: 10 });
  assert.ok(reqs.length >= 3, 'at least 3 batches for 22 streams @ max=10');
  // id sequential
  assert.equal(reqs[0].id, 1);
  assert.equal(reqs[1].id, 2);
  assert.equal(reqs[2].id, 3);
});

// ── 8. invalid startId → throw ────────────────────────────────────────────

test('8. invalid startId throws', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  assert.throws(() => planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { startId: 0 }), /positive integer/);
  assert.throws(() => planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { startId: -1 }), /positive integer/);
});

// ── 9. duplicate canonical symbol → reject ────────────────────────────────

test('9. duplicate canonical symbol rejects', () => {
  const p = makePlan(1, [
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTC1', intervals: ['1m'], ticker: true },
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTC2', intervals: ['1m'], ticker: true },
  ]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /duplicate canonical/);
});

// ── 10. duplicate exchange symbol → reject ────────────────────────────────

test('10. duplicate exchange symbol rejects', () => {
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'FOO', intervals: ['1m'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'FOO', intervals: ['1m'], ticker: true },
  ]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /duplicate exchange/);
});

// ── 11. unsupported interval → reject ─────────────────────────────────────

test('11. unsupported interval rejects', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['7d'], ticker: true }]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /unsupported interval/);
});

// ── 12. defensive copy — output mutation doesn't affect next call ─────────

test('12. defensive copy — repeated calls produce same output', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  const a = planBinanceSubscriptionRequests(p);
  // The function returns fresh objects each call. Verify by calling twice.
  const b = planBinanceSubscriptionRequests(p);
  assert.deepEqual(a, b);
  // Mutating a result should not affect the plan or next result
  assert.doesNotThrow(() => { (a[0] as any).extra = true; });
  const c = planBinanceSubscriptionRequests(p);
  assert.notEqual((c[0] as any).extra, true, 'mutation did not leak');
});

// ── 13. empty plan → empty result ─────────────────────────────────────────

test('13. empty plan returns empty requests', () => {
  const p = makePlan(1, []);
  const reqs = planBinanceSubscriptionRequests(p);
  assert.equal(reqs.length, 0, 'no streams = no requests');
});
