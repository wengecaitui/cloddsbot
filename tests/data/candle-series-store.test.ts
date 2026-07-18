// Stage 3A4: CandleSeriesStore tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import type { WsKline, Series } from '../../src/data/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function kline(
  instId: string,
  interval: string,
  ts: number,
  close = 100,
  volume = 10,
): WsKline {
  return {
    channel: 'kline',
    exchange: 'bitget',
    instId,
    interval,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume,
    ts,
    confirm: true,
  };
}

// ── 1. empty read ──────────────────────────────────────────────────────────

test('1. empty store returns empty series and false minimum', () => {
  const store = createCandleSeriesStore();
  assert.deepEqual(store.getSeries('bitget', 'BTCUSDT', '1m', 50), []);
  assert.equal(store.hasMinimumSeries('bitget', 'BTCUSDT', '1m', 1), false);
});

// ── 2. single append ───────────────────────────────────────────────────────

test('2. single append accepted', () => {
  const store = createCandleSeriesStore();
  const ok = store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: 1000 });
  assert.equal(ok, true);
  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 50);
  assert.equal(series.length, 1);
  assert.equal(series[0].close, 100);
  assert.equal(series[0].ts, 1000);
});

// ── 3. old → new order ─────────────────────────────────────────────────────

test('3. getSeries returns oldest-first ordering', () => {
  const store = createCandleSeriesStore();
  for (let i = 1; i <= 5; i++) {
    store.appendClosedKline({ kline: kline('BTCUSDT', '1m', i * 1000, i), receivedAt: i * 1000 });
  }
  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 5);
  assert.equal(series.length, 5);
  // oldest-first
  assert.equal(series[0].ts, 1000);
  assert.equal(series[4].ts, 5000);
  assert.equal(series[0].close, 1);
  assert.equal(series[4].close, 5);
});

// ── 4. capacity eviction ────────────────────────────────────────────────────

test('4. capacity evicts oldest', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 3 });
  for (let i = 1; i <= 5; i++) {
    store.appendClosedKline({ kline: kline('BTCUSDT', '1m', i * 1000, i), receivedAt: i * 1000 });
  }
  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  assert.equal(series.length, 3, 'capacity capped at 3');
  assert.equal(series[0].ts, 3000, 'oldest evicted');
  assert.equal(series[2].ts, 5000, 'newest retained');
});

// ── 5. multi-symbol isolation ───────────────────────────────────────────────

test('5. multi-symbol isolation', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000, 100), receivedAt: 1000 });
  store.appendClosedKline({ kline: kline('ETHUSDT', '1m', 1000, 50), receivedAt: 1000 });

  const btc = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  const eth = store.getSeries('bitget', 'ETHUSDT', '1m', 10);
  assert.equal(btc.length, 1);
  assert.equal(eth.length, 1);
  assert.equal(btc[0].close, 100);
  assert.equal(eth[0].close, 50);
});

// ── 6. multi-interval isolation ─────────────────────────────────────────────

test('6. multi-interval isolation', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000, 100), receivedAt: 1000 });
  store.appendClosedKline({ kline: kline('BTCUSDT', '5m', 1000, 200), receivedAt: 1000 });

  const m1 = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  const m5 = store.getSeries('bitget', 'BTCUSDT', '5m', 10);
  assert.equal(m1.length, 1);
  assert.equal(m5.length, 1);
  assert.equal(m1[0].close, 100);
  assert.equal(m5[0].close, 200);
});

// ── 7. older ts rejected ────────────────────────────────────────────────────

test('7. older ts rejected', () => {
  const store = createCandleSeriesStore();
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 5000, 50), receivedAt: 5000 }), true);
  // older ts → reject, no growth
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 4000, 40), receivedAt: 4000 }), false);
  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  assert.equal(series.length, 1);
  assert.equal(series[0].ts, 5000);
});

// ── 8. same ts receivedAt rule ──────────────────────────────────────────────

test('8. same ts: newer receivedAt replaces, same receivedAt rejected', () => {
  const store = createCandleSeriesStore();
  // first at ts=5000, receivedAt=100
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 5000, 50), receivedAt: 100 }), true);
  // same ts, older receivedAt → reject
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 5000, 51), receivedAt: 90 }), false);
  // same ts, same receivedAt → reject
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 5000, 52), receivedAt: 100 }), false);
  // same ts, newer receivedAt → replace (no growth)
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 5000, 53), receivedAt: 110 }), true);

  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  assert.equal(series.length, 1, 'count unchanged after replace');
  assert.equal(series[0].close, 53, 'replaced with newer receivedAt value');
});

// ── 9. confirm=false rejected ───────────────────────────────────────────────

test('9. unconfirmed kline rejected', () => {
  const store = createCandleSeriesStore();
  const unconfirmed: WsKline = { ...kline('BTCUSDT', '1m', 1000), confirm: false };
  assert.equal(store.appendClosedKline({ kline: unconfirmed, receivedAt: 1000 }), false);
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 0);
});

// ── 10. defensive copy ──────────────────────────────────────────────────────

test('10. getSeries returns defensive copies', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000, 100), receivedAt: 1000 });
  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  // mutate returned object — store must not be affected
  series[0].close = 999;
  series[0].ts = 9999;
  const again = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  assert.equal(again[0].close, 100, 'close not mutated');
  assert.equal(again[0].ts, 1000, 'ts not mutated');
});

// ── 11. invalid params ──────────────────────────────────────────────────────

test('11. invalid params rejected', () => {
  const store = createCandleSeriesStore();
  // non-finite ts
  assert.equal(store.appendClosedKline({ kline: { ...kline('BTCUSDT', '1m', NaN as unknown as number, 100), confirm: true }, receivedAt: 100 }), false);
  // non-finite receivedAt
  assert.equal(store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: Infinity }), false);
  // getSeries with non-positive count
  assert.deepEqual(store.getSeries('bitget', 'BTCUSDT', '1m', 0), []);
  assert.deepEqual(store.getSeries('BTCUSDT', '1m', -5), []);
  // hasMinimumSeries with non-positive minimum
  assert.equal(store.hasMinimumSeries('bitget', 'BTCUSDT', '1m', 0), false);
});

// ── 12. capacity validation ─────────────────────────────────────────────────

test('12. capacityPerSeries must be positive integer', () => {
  assert.throws(() => createCandleSeriesStore({ capacityPerSeries: 0 }));
  assert.throws(() => createCandleSeriesStore({ capacityPerSeries: -1 }));
  assert.throws(() => createCandleSeriesStore({ capacityPerSeries: 1.5 }));
});

// ── Stage 3B1A: removeSymbol / removeInterval ──────────────────────────────

test('13. removeSymbol deletes all intervals for symbol', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: 100 });
  store.appendClosedKline({ kline: kline('BTCUSDT', '5m', 2000), receivedAt: 200 });
  store.appendClosedKline({ kline: kline('ETHUSDT', '1m', 3000), receivedAt: 300 });

  assert.equal(store.removeSymbol('bitget', 'BTCUSDT'), true, 'removed BTCUSDT');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 0, 'BTC 1m empty');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '5m', 10).length, 0, 'BTC 5m empty');
  assert.equal(store.getSeries('bitget', 'ETHUSDT', '1m', 10).length, 1, 'ETH 1m preserved');
});

test('14. removeSymbol non-existent returns false', () => {
  const store = createCandleSeriesStore();
  assert.equal(store.removeSymbol('bitget', 'FAKE'), false);
});

test('15. removeInterval deletes one interval', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: 100 });
  store.appendClosedKline({ kline: kline('BTCUSDT', '5m', 2000), receivedAt: 200 });

  assert.equal(store.removeInterval('bitget', 'BTCUSDT', '5m'), true, 'removed 5m');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '5m', 10).length, 0, '5m empty');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 1, '1m preserved');
});

test('16. removeInterval non-existent returns false', () => {
  const store = createCandleSeriesStore();
  assert.equal(store.removeInterval('bitget', 'FAKE', '1m'), false);
});

test('17. remove then re-add starts empty', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: 100 });
  store.removeSymbol('bitget', 'BTCUSDT');
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 2000), receivedAt: 200 });
  const series = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  assert.equal(series.length, 1, 'only new kline');
  assert.equal(series[0].ts, 2000, 'old kline gone');
});

test('18. removeSymbol isolated between symbols', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: 100 });
  store.appendClosedKline({ kline: kline('ETHUSDT', '1m', 2000), receivedAt: 200 });
  store.removeSymbol('bitget', 'ETHUSDT');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 1, 'BTC preserved');
  assert.equal(store.getSeries('bitget', 'ETHUSDT', '1m', 10).length, 0, 'ETH gone');
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C2-R1 — Dual-exchange source isolation (additive)
// ═══════════════════════════════════════════════════════════════════════════

function klineEx(instId: string, interval: string, ts: number, ex: string, close = 100): WsKline {
  return { channel: 'kline', exchange: ex as any, instId, interval, open: close - 1, high: close + 2, low: close - 2, close, volume: 10, ts, confirm: true };
}

test('19. dual-exchange same symbol+interval: independent buffers', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'binance'), receivedAt: 100 });
  const bSeries = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  const nSeries = store.getSeries('binance', 'BTCUSDT', '1m', 10);
  assert.equal(bSeries.length, 1, 'bitget has its own');
  assert.equal(nSeries.length, 1, 'binance has its own');
  assert.equal(bSeries[0].ts, 1000);
  assert.equal(nSeries[0].ts, 1000);
});

test('20. dual-exchange: same-ts replacement independent', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 100 });
  // Insert same ts for both — both accepted
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'binance'), receivedAt: 100 });
  // Replace only bitget (same ts, newer receivedAt)
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget', 200), receivedAt: 200 });
  const bSeries = store.getSeries('bitget', 'BTCUSDT', '1m', 10);
  const nSeries = store.getSeries('binance', 'BTCUSDT', '1m', 10);
  assert.equal(bSeries[0].close, 200, 'bitget replaced with new close');
  assert.equal(nSeries[0].close, 100, 'binance UNCHANGED — cross-exchange replacement not allowed');
});

test('21. dual-exchange: older-ts rejection independent', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 2000, 'bitget'), receivedAt: 200 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 2000, 'binance'), receivedAt: 200 });
  // Try older ts for bitget
  const ok = store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget'), receivedAt: 100 });
  assert.equal(ok, false, 'bitget older ts rejected');
  // Binance should NOT be affected — still has ts=2000
  const nSeries = store.getSeries('binance', 'BTCUSDT', '1m', 10);
  assert.equal(nSeries.length, 1, 'binance still has its candle');
  assert.equal(nSeries[0].ts, 2000, 'binance ts=2000 untouched');
});

test('22. dual-exchange: capacity eviction independent', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 3 });
  // Fill bitget to capacity
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 2000, 'bitget'), receivedAt: 200 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 3000, 'bitget'), receivedAt: 300 });
  // Binance has just 1
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'binance'), receivedAt: 100 });
  // Evict oldest on bitget
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 4000, 'bitget'), receivedAt: 400 });
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 3, 'bitget capped at 3');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10)[0].ts, 2000, 'bitget oldest evicted (ts=1000 gone)');
  assert.equal(store.getSeries('binance', 'BTCUSDT', '1m', 10).length, 1, 'binance still has only 1 — capacity independent');
});

test('23. dual-exchange: removeInterval only affects target exchange', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'binance'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '5m', 1000, 'bitget'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '5m', 1000, 'binance'), receivedAt: 100 });
  store.removeInterval('bitget', 'BTCUSDT', '1m');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 0, 'bitget 1m removed');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '5m', 10).length, 1, 'bitget 5m preserved');
  assert.equal(store.getSeries('binance', 'BTCUSDT', '1m', 10).length, 1, 'binance 1m preserved');
  assert.equal(store.getSeries('binance', 'BTCUSDT', '5m', 10).length, 1, 'binance 5m preserved');
});

test('24. dual-exchange: removeSymbol only affects target exchange', () => {
  const store = createCandleSeriesStore({ capacityPerSeries: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'bitget'), receivedAt: 100 });
  store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'binance'), receivedAt: 100 });
  store.removeSymbol('bitget', 'BTCUSDT');
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 0, 'bitget removed');
  assert.equal(store.getSeries('binance', 'BTCUSDT', '1m', 10).length, 1, 'binance preserved');
});

test('25. illegal exchange append rejected', () => {
  const store = createCandleSeriesStore();
  assert.throws(
    () => store.appendClosedKline({ kline: klineEx('BTCUSDT', '1m', 1000, 'coinbase'), receivedAt: 100 }),
    /sourceKey.*invalid exchange/i,
  );
  // And nothing stored — verify via the legitimate exchanges; coinbase never created a buffer
  assert.equal(store.getSeries('bitget', 'BTCUSDT', '1m', 10).length, 0, 'bitget buffer untouched');
  assert.equal(store.getSeries('binance', 'BTCUSDT', '1m', 10).length, 0, 'binance buffer untouched');
});
