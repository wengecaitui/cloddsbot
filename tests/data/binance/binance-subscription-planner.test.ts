// Stage 3B3B-R2: Binance Subscription Planner tests (route-aware batching)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBinanceSubscriptionRequests, type BinanceSubscriptionRequest } from '../../../src/data/binance/BinanceSubscriptionPlanner';
import type { SubscriptionPlan } from '../../../src/runtime/market/UniverseManager';

function makePlan(version = 1, entries: Array<{
  symbol: string;
  exchangeSymbol: string;
  intervals: string[];
  ticker: boolean;
}>): SubscriptionPlan {
  return { version, entries };
}

function byRoute(reqs: readonly BinanceSubscriptionRequest[], route: string): BinanceSubscriptionRequest[] {
  return reqs.filter(r => r.route === route);
}
function collectParams(reqs: readonly BinanceSubscriptionRequest[]): string[] {
  return reqs.flatMap(r => [...r.params]);
}

// ── 1. ticker=true yields market + public requests ─────────────────────────

test('1. ticker=true produces market and public requests', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  // route order: market first, then public
  assert.equal(reqs.length, 2, 'market + public');
  assert.equal(reqs[0].route, 'market');
  assert.equal(reqs[1].route, 'public');
  // market params: ticker + kline
  const market = byRoute(reqs, 'market');
  assert.ok(market.length >= 1);
  const mParams = collectParams(market);
  assert.ok(mParams.includes('btcusdt@ticker'));
  assert.ok(mParams.includes('btcusdt@kline_1m'));
  assert.ok(!mParams.includes('btcusdt@bookTicker'), 'market has no bookTicker');
  // public params: bookTicker only
  const pub = byRoute(reqs, 'public');
  assert.equal(pub.length, 1);
  assert.deepEqual([...pub[0].params], ['btcusdt@bookTicker']);
});

// ── 2. ticker=false → only market klines, no public request ────────────────

test('2. ticker=false yields only market request', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['5m'], ticker: false }]);
  const reqs = planBinanceSubscriptionRequests(p);
  assert.equal(reqs.length, 1, 'only market');
  assert.equal(reqs[0].route, 'market');
  const params = reqs[0].params;
  assert.ok(params.includes('btcusdt@kline_5m'));
  assert.ok(!params.includes('@ticker'));
  assert.ok(!params.includes('@bookTicker'));
});

// ── 3. multi interval within market ────────────────────────────────────────

test('3. multi-interval all market klines', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m', '5m', '1h'], ticker: false }]);
  const reqs = planBinanceSubscriptionRequests(p);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].route, 'market');
  const params = reqs[0].params;
  assert.equal(params.length, 3);
  assert.ok(params.includes('btcusdt@kline_1m'));
  assert.ok(params.includes('btcusdt@kline_5m'));
  assert.ok(params.includes('btcusdt@kline_1h'));
});

// ── 4. stream name lowercase ───────────────────────────────────────────────

test('4. stream name lowercase', () => {
  const p = makePlan(1, [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  const all = collectParams(reqs);
  assert.ok(all.includes('btcusdt@ticker'));
  assert.ok(all.includes('btcusdt@bookTicker'));
  assert.ok(all.includes('btcusdt@kline_1m'));
});

// ── 5. deterministic ordering (market first, public second) ────────────────

test('5. market before public, symbols sorted within route', () => {
  const p = makePlan(1, [
    { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m'], ticker: true },
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
  ]);
  const reqs = planBinanceSubscriptionRequests(p);
  // First request: market (BTC before ETH)
  assert.equal(reqs[0].route, 'market');
  const mParams = reqs[0].params;
  const idxBTC = mParams.indexOf('btcusdt@ticker');
  const idxETH = mParams.indexOf('ethusdt@ticker');
  assert.ok(idxBTC >= 0 && idxETH >= 0 && idxBTC < idxETH, 'BTC ticker before ETH ticker');
  // Second request: public (ids increasing)
  assert.equal(reqs[1].route, 'public');
  // If more than one public, they could be split. BTCUSDT bookTicker should appear.
  const pubParams = collectParams(byRoute(reqs, 'public'));
  assert.ok(pubParams.includes('btcusdt@bookTicker'));
  assert.ok(pubParams.includes('ethusdt@bookTicker'));
});

// ── 6. batching within route ──────────────────────────────────────────────

test('6. batching per route with global sequential ids', () => {
  // Each entry: 2 market (ticker+book? no, ticker→market, book→public) + 9 candles = 11 market + 2 public
  // Actually: entry with ticker=true gives:
  //   market: 1 ticker + 9 klines = 10 streams
  //   public: 1 bookTicker = 1 stream
  // With 2 entries: 20 market + 2 public streams, max=10 → 2 market + 1 public = 3 reqs
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'BUSDT', intervals: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h'], ticker: true },
  ]);
  const reqs = planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { maxStreamsPerRequest: 10 });
  // 2 market batches + 1 public batch = 3 total
  assert.equal(reqs.length, 3);
  // ids sequential: 1, 2, 3 (market 1, market 2, public)
  assert.equal(reqs[0].id, 1);
  assert.equal(reqs[1].id, 2);
  assert.equal(reqs[2].id, 3);
  assert.equal(reqs[0].route, 'market');
  assert.equal(reqs[1].route, 'market');
  assert.equal(reqs[2].route, 'public');
});

// ── 7. invalid options throw ──────────────────────────────────────────────

test('7. invalid startId throws', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  assert.throws(() => planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { startId: 0 }), /safe integer/);
  assert.throws(() => planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { startId: -1 }), /safe integer/);
});

// ── 8. invalid op throws ──────────────────────────────────────────────────

test('8. invalid op throws', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  assert.throws(() => (planBinanceSubscriptionRequests as any)(p, 'INVALID'), /must be SUBSCRIBE/);
});

// ── 9. duplicate canonical symbol → reject ────────────────────────────────

test('9. duplicate canonical symbol rejects', () => {
  const p = makePlan(1, [
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTC1', intervals: ['1m'], ticker: true },
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTC2', intervals: ['1m'], ticker: true },
  ]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /duplicate canonical/);
});

// ── 10. duplicate exchange symbol case-insensitive → reject ────────────────

test('10. duplicate exchange symbol case-insensitive rejects', () => {
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'FOO', intervals: ['1m'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'foo', intervals: ['1m'], ticker: true },
  ]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /duplicate exchange.*case-insensitive/i);
});

// ── 11. unsupported interval → reject ──────────────────────────────────────

test('11. unsupported interval rejects', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['7d'], ticker: true }]);
  assert.throws(() => planBinanceSubscriptionRequests(p), /unsupported interval/);
});

// ── 12. defensive copy ────────────────────────────────────────────────────

test('12. defensive copy — mutation does not leak', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  const a = planBinanceSubscriptionRequests(p);
  const b = planBinanceSubscriptionRequests(p);
  assert.deepEqual(a, b);
  (a[0] as any).extra = true;
  const c = planBinanceSubscriptionRequests(p);
  assert.notEqual((c[0] as any).extra, true, 'mutation did not leak');
});

// ── 13. empty plan → empty result ─────────────────────────────────────────

test('13. empty plan returns empty requests', () => {
  const p = makePlan(1, []);
  const reqs = planBinanceSubscriptionRequests(p);
  assert.equal(reqs.length, 0);
});

// ── 14. SUBSCRIBE + UNSUBSCRIBE preserve route ────────────────────────────

test('14. SUBSCRIBE and UNSUBSCRIBE both carry route', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true }]);
  const sub = planBinanceSubscriptionRequests(p, 'SUBSCRIBE');
  assert.equal(sub[0].method, 'SUBSCRIBE');
  assert.ok(sub[0].route);
  assert.equal(sub[1].method, 'SUBSCRIBE');
  assert.ok(sub[1].route);

  const unsub = planBinanceSubscriptionRequests(p, 'UNSUBSCRIBE');
  assert.equal(unsub[0].method, 'UNSUBSCRIBE');
  assert.ok(unsub[0].route);
});

// ── 15. id cross-route sequential ─────────────────────────────────────────

test('15. ids are globally sequential across routes', () => {
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'BUSDT', intervals: ['1m'], ticker: true },
    { symbol: 'C', exchangeSymbol: 'CUSDT', intervals: ['1m'], ticker: true },
  ]);
  const reqs = planBinanceSubscriptionRequests(p, 'SUBSCRIBE', { maxStreamsPerRequest: 5 });
  for (let i = 1; i < reqs.length; i++) {
    assert.equal(reqs[i].id, reqs[i - 1].id + 1, `id seq ${i}`);
  }
});

// ── 16. input order does not affect output determinism ────────────────────

test('16. different entry order produces same output (sorted by exchangeSymbol)', () => {
  const p1 = makePlan(1, [
    { symbol: 'Z', exchangeSymbol: 'ZUSDT', intervals: ['1m'], ticker: true },
    { symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true },
  ]);
  const p2 = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m'], ticker: true },
    { symbol: 'Z', exchangeSymbol: 'ZUSDT', intervals: ['1m'], ticker: true },
  ]);
  const r1 = planBinanceSubscriptionRequests(p1);
  const r2 = planBinanceSubscriptionRequests(p2);
  assert.deepEqual(r1, r2, 'entry order does not affect output');
});

// ── 17. ticker + bookTicker in separate routes, never mixed ───────────────

test('17. no single request contains both market and public streams', () => {
  const p = makePlan(1, [
    { symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m', '5m'], ticker: true },
    { symbol: 'B', exchangeSymbol: 'BUSDT', intervals: ['1m'], ticker: true },
  ]);
  const reqs = planBinanceSubscriptionRequests(p);
  for (const r of reqs) {
    const hasMarket = r.params.some(s => s.includes('@ticker') || s.includes('@kline_'));
    const hasPublic = r.params.some(s => s.includes('@bookTicker'));
    assert.ok(!(hasMarket && hasPublic), `request ${r.id} mixed routes`);
  }
});

// ── 18. duplicate interval dedup within route ─────────────────────────────

test('18. duplicate interval dedup within market', () => {
  const p = makePlan(1, [{ symbol: 'A', exchangeSymbol: 'AUSDT', intervals: ['1m', '1m', '5m', '5m'], ticker: true }]);
  const reqs = planBinanceSubscriptionRequests(p);
  const marketParams = collectParams(byRoute(reqs, 'market'));
  const count1m = marketParams.filter(s => s === 'ausdt@kline_1m').length;
  assert.equal(count1m, 1, 'duplicate interval deduped');
});
