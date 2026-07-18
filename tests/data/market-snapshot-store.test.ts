// Stage 3A2: MarketSnapshotStore tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import type { Clock, MarketSnapshotStore } from '../../src/data/MarketSnapshot';
import type { WsTicker, WsKline } from '../../src/data/types';

// ── Fake Clock ──────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _now: number = 100_000;
  now(): number { return this._now; }
  advance(ms: number): void { this._now += ms; }
  setTime(ts: number): void { this._now = ts; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TICKER: WsTicker = {
  channel: 'ticker', exchange: 'bitget', instId: 'BTCUSDT',
  last: 67000, bestBid: 66990, bestAsk: 67010,
  volume24h: 10000, high24h: 68000, low24h: 66000, ts: 5000,
};

const KLINE_1M: WsKline = {
  channel: 'kline', exchange: 'bitget', instId: 'BTCUSDT', interval: '1m',
  open: 66900, high: 67100, low: 66800, close: 67000,
  volume: 100, ts: 5000, confirm: true,
};

const KLINE_5M: WsKline = {
  channel: 'kline', exchange: 'bitget', instId: 'BTCUSDT', interval: '5m',
  open: 66800, high: 67100, low: 66700, close: 67000,
  volume: 500, ts: 5000, confirm: true,
};

function makeStore(clock?: Clock): MarketSnapshotStore {
  return createMarketSnapshotStore({
    clock: clock ?? new FakeClock(),
    staleAfterMs: 60_000,
  });
}

// ── 1. Ticker-only partial snapshot ─────────────────────────────────────────

test('1. ticker-only partial snapshot', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  const snap = store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });

  assert.equal(snap.symbol, 'BTCUSDT');
  assert.ok(snap.ticker !== null);
  assert.equal(snap.ticker.ticker.last, 67000);
  assert.deepEqual(snap.klines, {});
  assert.equal(snap.snapshotVersion, 1);
});

// ── 2. Kline-only partial snapshot ─────────────────────────────────────────

test('2. kline-only partial snapshot', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  const snap = store.updateClosedKline({ kline: KLINE_1M, receivedAt: clock.now() });

  assert.equal(snap.symbol, 'BTCUSDT');
  assert.equal(snap.ticker, null);
  assert.equal(snap.klines['1m']?.kline.close, 67000);
  assert.equal(snap.snapshotVersion, 1);
});

// ── 3. Multi-interval klines ────────────────────────────────────────────────

test('3. multi-interval klines (1m + 5m)', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  store.updateClosedKline({ kline: KLINE_1M, receivedAt: clock.now() });
  const snap = store.updateClosedKline({ kline: KLINE_5M, receivedAt: clock.now() });

  assert.ok(snap.klines['1m'] !== undefined);
  assert.ok(snap.klines['5m'] !== undefined);
  assert.equal(snap.klines['5m'].kline.interval, '5m');
  assert.equal(snap.snapshotVersion, 2);
});

// ── 4. Ticker older source ts rejected, version unchanged ───────────────────

test('4. ticker older source ts rejected', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  const snap1 = store.updateTicker({ ticker: { ...TICKER, ts: 100 }, receivedAt: clock.now() });
  assert.equal(snap1.snapshotVersion, 1);

  clock.advance(10);
  const snap2 = store.updateTicker({ ticker: { ...TICKER, ts: 99 }, receivedAt: clock.now() });
  assert.equal(snap2.snapshotVersion, 1, 'version must not increase on older ts');
  assert.equal(snap2.ticker!.ticker.ts, 100, 'must retain newer ticker');
});

// ── 5. Ticker same source ts + older receivedAt rejected ────────────────────

test('5. ticker same ts + older receivedAt rejected', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  clock.setTime(100);
  store.updateTicker({ ticker: { ...TICKER, ts: 50 }, receivedAt: clock.now() }); // ver1

  clock.advance(1000);
  const snap = store.updateTicker({ ticker: { ...TICKER, ts: 50 }, receivedAt: clock.now() });
  // same ts, newer receivedAt → should accept (ver2)
  assert.equal(snap.snapshotVersion, 2);

  // Now try same ts but older receivedAt
  clock.advance(1000);
  const snap3 = store.updateTicker({ ticker: { ...TICKER, ts: 50 }, receivedAt: 100 }); // older than 1100
  assert.equal(snap3.snapshotVersion, 2, 'version must not increase');
});

// ── 6. Ticker same ts + newer receivedAt accepted ───────────────────────────

test('6. ticker same ts + newer receivedAt accepted', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  clock.setTime(100);
  store.updateTicker({ ticker: { ...TICKER, ts: 50 }, receivedAt: clock.now() }); // ver1

  clock.advance(500);
  const snap2 = store.updateTicker({ ticker: { ...TICKER, ts: 50 }, receivedAt: clock.now() });
  assert.equal(snap2.snapshotVersion, 2);
});

// ── 7. Kline per-interval independent out-of-order rejection ────────────────

test('7. kline per-interval independent rejection', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  clock.setTime(1000);
  store.updateClosedKline({ kline: { ...KLINE_1M, ts: 100 }, receivedAt: clock.now() }); // 1m ver1

  clock.setTime(2000);
  // 5m should not interfere with 1m
  store.updateClosedKline({ kline: { ...KLINE_5M, ts: 200 }, receivedAt: clock.now() }); // 5m ver2

  clock.setTime(3000);
  // Try old 1m kline
  const snap = store.updateClosedKline({ kline: { ...KLINE_1M, ts: 50 }, receivedAt: clock.now() });
  assert.equal(snap.snapshotVersion, 2, 'version must not increase');

  // But old 5m with ts=50 should also be rejected
  const snap3 = store.updateClosedKline({ kline: { ...KLINE_5M, ts: 50 }, receivedAt: clock.now() });
  assert.equal(snap3.snapshotVersion, 2, '5m older ts also rejected');
});

// ── 8. confirm=false throws and no state created ─────────────────────────────

test('8. confirm=false throws, no state created', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  assert.throws(
    () => store.updateClosedKline({ kline: { ...KLINE_1M, confirm: false }, receivedAt: clock.now() }),
    /confirm must be true/,
  );

  // No state should exist
  assert.equal(store.getSnapshot('bitget', 'BTCUSDT'), undefined);
});

// ── 9. Only accepted updates increment snapshotVersion ──────────────────────

test('9. only accepted updates increment version', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  store.updateTicker({ ticker: { ...TICKER, ts: 100 }, receivedAt: clock.now() }); // ver1
  store.updateTicker({ ticker: { ...TICKER, ts: 101 }, receivedAt: clock.now() }); // ver2
  store.updateTicker({ ticker: { ...TICKER, ts: 99 }, receivedAt: clock.now() }); // rejected
  store.updateTicker({ ticker: { ...TICKER, ts: 102 }, receivedAt: clock.now() }); // ver3

  assert.equal(store.getSnapshot('bitget', 'BTCUSDT')!.snapshotVersion, 3);
});

// ── 10. Clock controls generatedAt / ageMs / isStale ────────────────────────

test('10. Clock controls generatedAt / ageMs / isStale', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  clock.setTime(1000);
  store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });

  // Snapshot at 1000
  let snap = store.getSnapshot('bitget', 'BTCUSDT')!;
  assert.equal(snap.generatedAt, 1000);
  assert.equal(snap.ageMs, 0);
  assert.equal(snap.isStale, false);

  clock.advance(61_000); // total 62000
  snap = store.getSnapshot('bitget', 'BTCUSDT')!;
  assert.equal(snap.generatedAt, 62000);
  assert.equal(snap.ageMs, 61000);
  assert.equal(snap.isStale, true);
});

// ── 11. Multi-symbol isolation ──────────────────────────────────────────────

test('11. multi-symbol isolation', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });
  store.updateTicker({ ticker: { ...TICKER, instId: 'ETHUSDT', last: 3500 }, receivedAt: clock.now() });

  const btc = store.getSnapshot('bitget', 'BTCUSDT')!;
  const eth = store.getSnapshot('bitget', 'ETHUSDT')!;
  assert.equal(btc.ticker!.ticker.last, 67000);
  assert.equal(eth.ticker!.ticker.last, 3500);

  const all = store.getAllSnapshots();
  assert.equal(all.length, 2);
});

// ── 12. Modify original input does NOT affect store ─────────────────────────

test('12. modify original input does not affect store', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  const input = { ticker: { ...TICKER }, receivedAt: clock.now() };
  store.updateTicker(input);
  input.ticker.last = 99999; // mutate after

  const snap = store.getSnapshot('bitget', 'BTCUSDT')!;
  assert.equal(snap.ticker!.ticker.last, 67000, 'must not be mutated');
});

// ── 13. Modify returned snapshot does NOT affect store ──────────────────────

test('13. modify returned snapshot does not affect store', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });
  const snap1 = store.getSnapshot('bitget', 'BTCUSDT')!;
  (snap1 as any).ticker.ticker.last = 99999;

  const snap2 = store.getSnapshot('bitget', 'BTCUSDT')!;
  assert.equal(snap2.ticker!.ticker.last, 67000, 'must not be mutated via returned copy');
});

// ── 14. getAllSnapshots defensive copy ──────────────────────────────────────

test('14. getAllSnapshots defensive copy', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });
  const all = store.getAllSnapshots();
  (all[0] as any).ticker.ticker.last = 88888;

  const snap = store.getSnapshot('bitget', 'BTCUSDT')!;
  assert.equal(snap.ticker!.ticker.last, 67000);
});

// ── 15. removeSymbol + re-add ──────────────────────────────────────────────

test('15. removeSymbol deletes and returns true; re-add starts fresh', () => {
  const clock = new FakeClock();
  const store = makeStore(clock);

  store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });
  assert.equal(store.getSnapshot('bitget', 'BTCUSDT') !== undefined, true);

  const removed = store.removeSymbol('bitget', 'BTCUSDT');
  assert.equal(removed, true);

  // Now gone
  assert.equal(store.getSnapshot('bitget', 'BTCUSDT'), undefined);

  // Remove again returns false
  assert.equal(store.removeSymbol('bitget', 'BTCUSDT'), false);

  // Re-add starts fresh (version 1)
  const snap = store.updateTicker({ ticker: TICKER, receivedAt: clock.now() });
  assert.equal(snap.snapshotVersion, 1);
});

// ── 16. Two store instances independent ─────────────────────────────────────

test('16. two store instances independent', () => {
  const clock = new FakeClock();
  const s1 = makeStore(clock);
  const s2 = makeStore(clock);

  s1.updateTicker({ ticker: TICKER, receivedAt: clock.now() });
  assert.equal(s1.getSnapshot('bitget', 'BTCUSDT') !== undefined, true);
  assert.equal(s2.getSnapshot('bitget', 'BTCUSDT'), undefined);
});

// ── 17. Invalid staleAfterMs rejected ───────────────────────────────────────

test('17. invalid staleAfterMs rejected', () => {
  assert.throws(() => createMarketSnapshotStore({ staleAfterMs: -1 }), /finite positive/);
  assert.throws(() => createMarketSnapshotStore({ staleAfterMs: 0 }), /finite positive/);
  assert.throws(() => createMarketSnapshotStore({ staleAfterMs: Infinity }), /finite positive/);
  assert.throws(() => createMarketSnapshotStore({ staleAfterMs: NaN }), /finite positive/);
});

// ── 18. Invalid timestamp rejected ──────────────────────────────────────────

test('18. invalid ts / receivedAt rejected', () => {
  const store = makeStore();
  assert.throws(() => store.updateTicker({ ticker: { ...TICKER, ts: NaN }, receivedAt: 100 }), /ticker.ts must be finite/);
  assert.throws(() => store.updateTicker({ ticker: { ...TICKER, ts: Infinity }, receivedAt: 100 }), /ticker.ts must be finite/);
  assert.throws(() => store.updateTicker({ ticker: TICKER, receivedAt: NaN }), /receivedAt must be finite/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C2-R1 — Dual-exchange source isolation (additive)
// ═══════════════════════════════════════════════════════════════════════════
//
// One shared Store, two sources writing the same canonical symbol — the Store
// must keep two independent snapshots. Removing one exchange's snapshot must
// NOT affect the other. getAllSnapshots must return both as separate structured
// entries. Stale one side; the other side stays fresh. Illegal exchange writes
// must be rejected at the source-key boundary (audit trail provenance).

const BTICKER: WsTicker = { ...TICKER, exchange: 'bitget' };
const NTICKER: WsTicker = { ...TICKER, exchange: 'binance' };
const BKLINE_1M: WsKline = { ...KLINE_1M, exchange: 'bitget' };
const NKLINE_1M: WsKline = { ...KLINE_1M, exchange: 'binance' };

test('19. dual-exchange same symbol: two independent snapshots', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  const bSnap = store.getSnapshot('bitget', 'BTCUSDT');
  const nSnap = store.getSnapshot('binance', 'BTCUSDT');
  assert.ok(bSnap, 'bitget snapshot exists');
  assert.ok(nSnap, 'binance snapshot exists');
  assert.notEqual(bSnap, nSnap, 'snapshots must be different objects');
  assert.equal(bSnap!.ticker!.ticker.exchange, 'bitget');
  assert.equal(nSnap!.ticker!.ticker.exchange, 'binance');
});

test('20. dual-exchange same symbol: ticker update is isolated', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  // Update only bitget
  const bTicker2 = { ...BTICKER, last: 70000, ts: 6000 };
  store.updateTicker({ ticker: bTicker2, receivedAt: 200 });
  const bSnap = store.getSnapshot('bitget', 'BTCUSDT');
  const nSnap = store.getSnapshot('binance', 'BTCUSDT');
  assert.equal(bSnap!.ticker!.ticker.last, 70000, 'bitget updated');
  assert.equal(nSnap!.ticker!.ticker.last, 67000, 'binance UNCHANGED — no cross-source leak');
  assert.equal(nSnap!.ticker!.ticker.ts, 5000, 'binance ts UNCHANGED');
});

test('21. dual-exchange same symbol: kline update is isolated', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  store.updateClosedKline({ kline: BKLINE_1M, receivedAt: 200 });
  store.updateClosedKline({ kline: NKLINE_1M, receivedAt: 200 });
  const bSnap = store.getSnapshot('bitget', 'BTCUSDT');
  const nSnap = store.getSnapshot('binance', 'BTCUSDT');
  assert.equal(bSnap!.klines['1m'].kline.exchange, 'bitget');
  assert.equal(nSnap!.klines['1m'].kline.exchange, 'binance');
});

test('22. dual-exchange: ticker version independent per source', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  assert.equal(store.getSnapshot('bitget', 'BTCUSDT')!.snapshotVersion, 1);
  assert.equal(store.getSnapshot('binance', 'BTCUSDT')!.snapshotVersion, 1);
  // Update only bitget → bitget v2, binance stays v1
  store.updateTicker({ ticker: { ...BTICKER, ts: 6000 }, receivedAt: 200 });
  assert.equal(store.getSnapshot('bitget', 'BTCUSDT')!.snapshotVersion, 2);
  assert.equal(store.getSnapshot('binance', 'BTCUSDT')!.snapshotVersion, 1, 'binance version unchanged');
});

test('23. dual-exchange: lastUpdatedAt independent', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  // Update only bitget at later time
  store.updateTicker({ ticker: { ...BTICKER, ts: 6000 }, receivedAt: 999 });
  const bSnap = store.getSnapshot('bitget', 'BTCUSDT');
  const nSnap = store.getSnapshot('binance', 'BTCUSDT');
  assert.equal(bSnap!.lastUpdatedAt, 999, 'bitget advanced');
  assert.equal(nSnap!.lastUpdatedAt, 100, 'binance UNCHANGED');
});

test('24. dual-exchange: stale on one side does not affect other', () => {
  // Two separate stores with different staleAfterMs windows; verify each
  // computes staleness from its OWN most-recent update — let one side go stale
  // and assert the other side remains fresh.
  const clock = new FakeClock();
  const store = makeStore(clock);
  store.updateTicker({ ticker: BTICKER, receivedAt: clock.now() });
  store.updateTicker({ ticker: NTICKER, receivedAt: clock.now() });
  // Move time forward 70s → bitget was last touched at t=0; binance also at t=0.
  // Update ONLY bitget at t=70s, so bitget fresh (age 0) but binance stale (age 70000).
  clock.advance(70_000);
  store.updateTicker({ ticker: { ...BTICKER, ts: 9999 }, receivedAt: clock.now() });
  const bSnap = store.getSnapshot('bitget', 'BTCUSDT');
  const nSnap = store.getSnapshot('binance', 'BTCUSDT');
  assert.equal(bSnap!.isStale, false, 'bitget NOT stale — updated just now');
  assert.equal(nSnap!.isStale, true, 'binance stale — old timestamp retained');
});

test('25. dual-exchange: removeSymbol(bitget) does NOT touch binance', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  store.updateClosedKline({ kline: BKLINE_1M, receivedAt: 200 });
  store.updateClosedKline({ kline: NKLINE_1M, receivedAt: 200 });
  const ok = store.removeSymbol('bitget', 'BTCUSDT');
  assert.equal(ok, true, 'removeSymbol(bitget) reports success');
  assert.equal(store.getSnapshot('bitget', 'BTCUSDT'), undefined, 'bitget gone');
  const nSnap = store.getSnapshot('binance', 'BTCUSDT');
  assert.ok(nSnap, 'binance snapshot PRESERVED');
  assert.equal(nSnap!.ticker!.ticker.exchange, 'binance', 'binance ticker preserved');
  assert.equal(nSnap!.klines['1m'].kline.exchange, 'binance', 'binance kline preserved');
});

test('26. dual-exchange: getAllSnapshots returns both sources as separate entries', () => {
  const store = makeStore();
  store.updateTicker({ ticker: BTICKER, receivedAt: 100 });
  store.updateTicker({ ticker: NTICKER, receivedAt: 100 });
  const all = store.getAllSnapshots();
  assert.equal(all.length, 2, 'must contain two separate snapshots');
  const exchanges = all.map(s => s.ticker!.ticker.exchange).sort();
  assert.deepEqual(exchanges, ['binance', 'bitget']);
});

test('27. illegal exchange write rejected (snapshot provenance)', () => {
  const store = makeStore();
  const badTicker = { ...TICKER, exchange: 'coinbase' as any } as WsTicker;
  assert.throws(
    () => store.updateTicker({ ticker: badTicker, receivedAt: 100 }),
    /invalid.*exchange/i,
  );
  // And nothing was created
  assert.equal(store.getAllSnapshots().length, 0);
});
