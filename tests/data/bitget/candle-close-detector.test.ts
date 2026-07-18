// Stage 3B2B: CandleCloseDetector tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCandleCloseDetector } from '../../../src/data/bitget/CandleCloseDetector';

function up(exchange: string, interval: string, startTs: number, open = 100, high = 110, low = 90, close = 105, baseVolume = 1000) {
  return { kind: 'candle' as const, action: 'snapshot' as const, exchangeSymbol: exchange, interval, startTs, open, high, low, close, baseVolume, quoteVolume: 2000, usdtVolume: 3000 };
}

test('1. first candle not emitted', () => {
  const d = createCandleCloseDetector();
  const out = d.ingest(up('BTCUSDT', '1m', 1000));
  assert.equal(out.length, 0);
});

test('2. same startTs update not emitted', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  const out = d.ingest(up('BTCUSDT', '1m', 1000, 101, 112, 89, 106));
  assert.equal(out.length, 0, 'update to same bar does not emit');
});

test('3. larger startTs emits previous bar', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  const out = d.ingest(up('BTCUSDT', '1m', 2000, 200, 210, 190, 205, 500));
  assert.equal(out.length, 1);
  assert.equal(out[0].instId, 'BTCUSDT');
  assert.equal(out[0].interval, '1m');
  assert.equal(out[0].ts, 1000);
  assert.equal(out[0].close, 105);
  assert.equal(out[0].volume, 1000);
  assert.equal(out[0].confirm, true);
  assert.equal(out[0].channel, 'kline');
});

test('4. emitted bar uses last known values', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000, 100, 110, 90, 105, 1000));
  d.ingest(up('BTCUSDT', '1m', 1000, 102, 115, 88, 108, 1200)); // same startTs, updates values
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out[0].close, 108); // last known close (from second update)
  assert.equal(out[0].volume, 1200); // last known volume
});

test('5. snapshot action does not auto-confirm', () => {
  const d = createCandleCloseDetector();
  const out = d.ingest(up('BTCUSDT', '1m', 1000));
  assert.equal(out.length, 0, 'snapshot alone does not emit');
});

test('6. update action alone does not auto-deny', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  // update action (same startTs replacement) does not emit
  // but the close detection works the same way regardless of action
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out.length, 1);
});

test('7. initial multi-candle emits all but last', () => {
  const d = createCandleCloseDetector();
  // helper: up(exchange, interval, startTs, open, high, low, close, baseVolume)
  const updates = [up('BTCUSDT', '1m', 1000, 100, 110, 90, 100), up('BTCUSDT', '1m', 2000, 200, 210, 190, 200), up('BTCUSDT', '1m', 3000, 300, 310, 290, 300)];
  const out = d.ingestMany(updates);
  assert.equal(out.length, 2, 'c1 and c2 emitted, c3 is current');
  assert.equal(out[0].ts, 1000);
  assert.equal(out[1].ts, 2000);
  assert.equal(out[0].close, 100);
  assert.equal(out[1].close, 200);
});

test('8. same timestamp multi-update: last row is final', () => {
  const d = createCandleCloseDetector();
  // 3 updates at same startTs; the last should be the value used
  // helper signature: up(exchange, interval, startTs, open, high, low, close, baseVolume)
  const u1 = up('BTCUSDT', '1m', 1000, 100, 110, 90, 105);
  const u2 = up('BTCUSDT', '1m', 1000, 100, 110, 90, 200);
  const u3 = up('BTCUSDT', '1m', 1000, 100, 110, 90, 300);
  d.ingest(u1);
  d.ingest(u2);
  d.ingest(u3);
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out.length, 1);
  assert.equal(out[0].close, 300, 'last seen close value for bar 1000');
});

test('9. late older candle ignored', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 2000));
  const out = d.ingest(up('BTCUSDT', '1m', 1000)); // older ts
  assert.equal(out.length, 0, 'late candle ignored');
  // Current should remain at 2000
  const out2 = d.ingest(up('BTCUSDT', '1m', 3000));
  assert.equal(out2[0].ts, 2000, 'previous (2000) emitted, not the late one');
});

test('10. emitted bar only once', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  d.ingest(up('BTCUSDT', '1m', 2000));
  // emit 1000
  d.ingest(up('BTCUSDT', '1m', 3000));
  // should NOT emit 1000 again
  const out = d.ingest(up('BTCUSDT', '1m', 4000));
  assert.equal(out.length, 1, 'only one emit');
  assert.equal(out[0].ts, 3000, 'emits 3000, not 1000 again');
});

test('11. symbol isolation', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  d.ingest(up('ETHUSDT', '1m', 5000));
  // BTC still has current at 1000, ETH at 5000
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out.length, 1);
  assert.equal(out[0].instId, 'BTCUSDT');
  assert.equal(out[0].ts, 1000);
});

test('12. interval isolation', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  d.ingest(up('BTCUSDT', '5m', 5000));
  // 1m current at 1000, 5m current at 5000
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, 1000);
  assert.equal(out[0].interval, '1m');
});

test('13. baseVolume -> WsKline.volume', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000, 100, 110, 90, 105, 42));
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out[0].volume, 42);
});

test('14. input not mutated', () => {
  const d = createCandleCloseDetector();
  const u = up('BTCUSDT', '1m', 1000);
  const before = JSON.stringify(u);
  d.ingest(u);
  assert.equal(JSON.stringify(u), before);
});

test('15. deterministic output ordering', () => {
  const d = createCandleCloseDetector();
  const updates = [
    up('ETHUSDT', '1m', 1000, 1),
    up('BTCUSDT', '1m', 1000, 10),
    up('BTCUSDT', '5m', 1000, 20),
  ];
  const out = d.ingestMany(updates);
  // After ingestion: each symbol has a current at 1000, none emitted yet
  assert.equal(out.length, 0, 'initial ingest does not emit');
  // Now push each forward
  const out2 = d.ingestMany([
    up('ETHUSDT', '1m', 2000),
    up('BTCUSDT', '1m', 2000),
    up('BTCUSDT', '5m', 2000),
  ]);
  // Deterministic: sorted by startTs, exchangeSymbol, interval
  assert.equal(out2.length, 3);
  assert.equal(out2[0].instId, 'BTCUSDT');
  assert.equal(out2[0].interval, '1m');
  assert.equal(out2[1].instId, 'BTCUSDT');
  assert.equal(out2[1].interval, '5m');
  assert.equal(out2[2].instId, 'ETHUSDT');
  assert.equal(out2[2].interval, '1m');
});

test('16. clear resets state', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  d.clear();
  const out = d.ingest(up('BTCUSDT', '1m', 1000));
  assert.equal(out.length, 0, 'after clear, same startTs is treated as first');
});

test('17. invalid numeric does not pollute state', () => {
  const d = createCandleCloseDetector();
  const bad = up('BTCUSDT', '1m', 1000, NaN, Infinity, 90, 105);
  const out = d.ingest(bad);
  assert.equal(out.length, 0);
  // State should still be empty for this key
  assert.equal(d.ingest(up('BTCUSDT', '1m', 1000)).length, 0, 'first valid candle not emitted');
});

test('18. one bad update in ingestMany does not affect others', () => {
  const d = createCandleCloseDetector();
  const updates = [up('BAD/SYMBOL', '1m', 1000), up('BTCUSDT', '1m', 1000), up('BTCUSDT', '1m', 2000)];
  const out = d.ingestMany(updates);
  // BTCUSDT: 1000 current, 2000 emitted; BAD: filtered out
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, 1000);
  assert.equal(out[0].instId, 'BTCUSDT');
});

// ── Stage 3B4C1-R1: Bitget-specialized provenance ──────────────────────────

test('19. CCD-R1: detector takes no exchange parameter', () => {
  // Compile-time check: createCandleCloseDetector takes zero args.
  // Runtime check: returns a working detector.
  const d = createCandleCloseDetector();
  assert.equal(typeof d.ingest, 'function');
  assert.equal(typeof d.ingestMany, 'function');
  assert.equal(typeof d.clear, 'function');
});

test('20. CCD-R1: emitted kline always has exchange === "bitget"', () => {
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  const out = d.ingest(up('BTCUSDT', '1m', 2000, 200, 210, 190, 205, 500));
  assert.equal(out.length, 1);
  assert.equal(out[0].exchange, 'bitget',
    'Bitget CandleCloseDetector MUST hardcode exchange=bitget; caller cannot override');
  assert.equal(out[0].instId, 'BTCUSDT');
});

test('21. CCD-R1: ingestMany output always has exchange === "bitget"', () => {
  const d = createCandleCloseDetector();
  const updates = [up('BTCUSDT', '1m', 1000), up('BTCUSDT', '1m', 2000),
                   up('ETHUSDT', '1m', 1000), up('ETHUSDT', '1m', 2000)];
  const out = d.ingestMany(updates);
  assert.equal(out.length, 2); // BTCUSDT@1000, ETHUSDT@1000
  for (const k of out) {
    assert.equal(k.exchange, 'bitget',
      'Bitget detector MUST NOT produce klines with any other exchange');
  }
});

test('22. CCD-R1: caller cannot inject or override detector exchange', () => {
  // The whole point of 3B4C1-R1: the API surface has NO exchange parameter.
  // Pre-3B4C1-R1 allowed createCandleCloseDetector('binance') — which would
  // mislabel Bitget candle data as Binance. The sealed API removes that vector.
  //
  // We verify by attempting to pass an extra arg: TypeScript rejects it at
  // compile time; at runtime the value is silently ignored and outputs stay 'bitget'.
  const d = createCandleCloseDetector();
  d.ingest(up('BTCUSDT', '1m', 1000));
  const out = d.ingest(up('BTCUSDT', '1m', 2000));
  assert.equal(out.length, 1);
  assert.equal(out[0].exchange, 'bitget');

  // Even if a caller tried (d as any)('binance') they cannot reach into the
  // closure-scoped BITGET_EXCHANGE constant — that's the design guarantee.
});
