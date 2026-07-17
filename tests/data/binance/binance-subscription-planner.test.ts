// Stage 3B3B-R1: Binance Subscription Planner tests (hardened)
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

// ── 4. stream name lowercase ───────────────────────────────────────────────

test('4. stream name is lowercase (symbol portion)', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  const joined = reqs[0].params.join(' ');
  assert.ok(joined.includes('btcusdt@ticker'), 'symbol lowercased');
  assert.ok(joined.includes('btcusdt@kline_1m'), 'kline lowercase');
});

// ── 5. deterministic ordering ──────────────────────────────────────────────

test('5. deterministic stream ordering', () => {
  const p = makePlan(1, [
    { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m', '5m'], ticker: true },
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
  ]);
  const reqs = planBinanceSubscriptionRequests(p);
  const params = reqs[0].params;
  const idxBTC = params.indexOf('btcusdt@ticker');
  const idxETH = params.indexOf('ethusdt@ticker');
  assert.ok(idxBTC < idxETH, 'BTC before ETH');
  const idxTicker = params.indexOf('btcusdt@ticker');
  const idxBook = params.indexOf('btcusdt@bookTicker');
  const idxKline = params.indexOf('btcusdt@kline_1m');
  assert.ok(idxTicker < idxBook, 'ticker before bookTicker');
  assert.ok(idxBook < idxKline, 'bookTicker before candle');
});

// ── 6. dedup identical streams ────────────────────────────────────────────

test('6. duplicate interval dedup', () => {
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
  const reqs = planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { maxStreamsPerRequest: 10 });
  assert.ok(reqs.length >= 3, 'at least 3 batches');
  assert.equal(reqs[0].id, 1);
  assert.equal(reqs[1].id, 2);
  assert.equal(reqs[2].id, 3);
});

// ── 8. invalid options throw ──────────────────────────────────────────────

test('8. invalid startId throws', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  assert.throws(() => planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { startId: 0 }), /safe integer/);
  assert.throws(() => planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { startId: -1 }), /safe integer/);
});

// ── 9. invalid op throws ──────────────────────────────────────────────────

test('9. invalid op throws', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  assert.throws(() => (planBinanceSubscriptionRequests as any)(p, 'INVALID'), /must be SUBSCRIBE/);
});

// ── 10. duplicate canonical symbol → reject ───────────────────────────────

test('10. duplicate canonical symbol rejects', () => {
  const p = makePlan(1, [
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTC1', intervals: ['1m'], ticker: true },
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTC2', intervals: ['1m'], ticker: true },
  ]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /duplicate canonical/);
});

// ── 11. duplicate exchange symbol case-insensitive → reject ───────────────

test('11. duplicate exchange symbol case-insensitive rejects', () => {
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'FOO', intervals: ['1m'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'foo', intervals: ['1m'], ticker: true },
  ]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /duplicate exchange.*case-insensitive/i);
});

// ── 12. unsupported interval → reject ─────────────────────────────────────

test('12. unsupported interval rejects', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['7d'], ticker: true }]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /unsupported interval/);
});

// ── 13. defensive copy ────────────────────────────────────────────────────

test('13. defensive copy — mutation does not leak', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  const a = planBinanceSubscriptionRequests(p);
  const b = planBinanceSubscriptionRequests(p);
  assert.deepEqual(a, b);
  (a[0] as any).extra = true;
  const c = planBinanceSubscriptionRequests(p);
  assert.notEqual((c[0] as any).extra, true, 'mutation did not leak');
});

// ── 14. empty plan → empty result ─────────────────────────────────────────

test('14. empty plan returns empty requests', () => {
  const p = makePlan(1, []);
  const reqs = planBinanceSubscriptionRequests(p);
  assert.equal(reqs.length, 0);
});

// ── 15. unsubscribe ───────────────────────────────────────────────────────

test('15. op=UNSUBSCRIBE produces request with correct method', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p, 'UNSUBSCRIBE');
  assert.equal(reqs[0].method, 'UNSUBSCRIBE');
});
