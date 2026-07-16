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
  assert.deepEqual(store.getSeries('BTCUSDT', '1m', 50), []);
  assert.equal(store.hasMinimumSeries('BTCUSDT', '1m', 1), false);
});

// ── 2. single append ───────────────────────────────────────────────────────

test('2. single append accepted', () => {
  const store = createCandleSeriesStore();
  const ok = store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000), receivedAt: 1000 });
  assert.equal(ok, true);
  const series = store.getSeries('BTCUSDT', '1m', 50);
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
  const series = store.getSeries('BTCUSDT', '1m', 5);
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
  const series = store.getSeries('BTCUSDT', '1m', 10);
  assert.equal(series.length, 3, 'capacity capped at 3');
  assert.equal(series[0].ts, 3000, 'oldest evicted');
  assert.equal(series[2].ts, 5000, 'newest retained');
});

// ── 5. multi-symbol isolation ───────────────────────────────────────────────

test('5. multi-symbol isolation', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000, 100), receivedAt: 1000 });
  store.appendClosedKline({ kline: kline('ETHUSDT', '1m', 1000, 50), receivedAt: 1000 });

  const btc = store.getSeries('BTCUSDT', '1m', 10);
  const eth = store.getSeries('ETHUSDT', '1m', 10);
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

  const m1 = store.getSeries('BTCUSDT', '1m', 10);
  const m5 = store.getSeries('BTCUSDT', '5m', 10);
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
  const series = store.getSeries('BTCUSDT', '1m', 10);
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

  const series = store.getSeries('BTCUSDT', '1m', 10);
  assert.equal(series.length, 1, 'count unchanged after replace');
  assert.equal(series[0].close, 53, 'replaced with newer receivedAt value');
});

// ── 9. confirm=false rejected ───────────────────────────────────────────────

test('9. unconfirmed kline rejected', () => {
  const store = createCandleSeriesStore();
  const unconfirmed: WsKline = { ...kline('BTCUSDT', '1m', 1000), confirm: false };
  assert.equal(store.appendClosedKline({ kline: unconfirmed, receivedAt: 1000 }), false);
  assert.equal(store.getSeries('BTCUSDT', '1m', 10).length, 0);
});

// ── 10. defensive copy ──────────────────────────────────────────────────────

test('10. getSeries returns defensive copies', () => {
  const store = createCandleSeriesStore();
  store.appendClosedKline({ kline: kline('BTCUSDT', '1m', 1000, 100), receivedAt: 1000 });
  const series = store.getSeries('BTCUSDT', '1m', 10);
  // mutate returned object — store must not be affected
  series[0].close = 999;
  series[0].ts = 9999;
  const again = store.getSeries('BTCUSDT', '1m', 10);
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
  assert.deepEqual(store.getSeries('BTCUSDT', '1m', 0), []);
  assert.deepEqual(store.getSeries('BTCUSDT', '1m', -5), []);
  // hasMinimumSeries with non-positive minimum
  assert.equal(store.hasMinimumSeries('BTCUSDT', '1m', 0), false);
});

// ── 12. capacity validation ─────────────────────────────────────────────────

test('12. capacityPerSeries must be positive integer', () => {
  assert.throws(() => createCandleSeriesStore({ capacityPerSeries: 0 }));
  assert.throws(() => createCandleSeriesStore({ capacityPerSeries: -1 }));
  assert.throws(() => createCandleSeriesStore({ capacityPerSeries: 1.5 }));
});
