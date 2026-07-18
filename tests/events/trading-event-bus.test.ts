// Stage 3A1-R2 + 3B4C2-R1: TradingEventBus tests — real WsTicker/WsKline/MarketBiasReportFull
//
// Stage 3B4C2-R1 changes:
//   - All legal ticker/kline fixtures now carry exchange: 'bitget' (WsTicker/WsKline
//     gained a required `exchange: ExchangeId` field; bus validates provenance).
//   - Confirm=false rejection path retained, but keeps legal exchange — the guard
//     must reject on confirm only, not on provenance.
//   - Adds new tests for exchange provenance enforcement:
//       * missing exchange on ticker/kline
//       * unknown exchanges ('coinbase', '', 'BITGET', undefined)
//       * valid exchange + confirm=false still rejects via KlineClosedEventRejectedError
//       * InvalidExchangeProvenanceError class identity + Error inheritance
//       * subscriber NOT called when provenance is invalid
//       * sequence NOT consumed on provenance rejection
//       * event payload exposes NO standalone `source` field (only via kline.exchange)
//
// All baseline 13 tests preserved (titles unchanged from 12bb334).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTradingEventBus,
  KlineClosedEventRejectedError,
  InvalidExchangeProvenanceError,
} from '../../src/events/index';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { MarketBiasReportFull } from '../../src/types/market-bias';

// ── Legal fixtures — Stage 3B4C2: provenance required ────────────────────────

const ticker: WsTicker = {
  channel: 'ticker', exchange: 'bitget', instId: 'BTCUSDT', last: 67000,
  bestBid: 66990, bestAsk: 67010, volume24h: 10_000, high24h: 68000, low24h: 66000, ts: 1000,
};
const kline: WsKline = {
  channel: 'kline', exchange: 'bitget', instId: 'BTCUSDT', interval: '1m',
  open: 66900, high: 67100, low: 66800, close: 67000, volume: 100, ts: 2000, confirm: true,
};
const unconfirmed: WsKline = { ...kline, confirm: false };
const report = {
  timestamp: 1000,
  meta: { source: 'hermes_cron' as const, modelVersion: '1.0', generationTimeMs: 100, inputSummary: '' },
} as MarketBiasReportFull;

// ── 1. ticker event routing ──────────────────────────────────────────────────

test('1. ticker event routing', () => {
  const bus = createTradingEventBus();
  let captured: unknown = null;
  bus.subscribe('market.ticker.updated', (e) => { captured = e; });
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
  assert.ok(captured !== null);
  assert.equal((captured as any).type, 'market.ticker.updated');
  assert.equal((captured as any).sequence, 1);
  assert.equal((captured as any).ticker, ticker);
  assert.equal(r.delivered, 1);
  assert.equal(r.sequence, 1);
});

// ── 2. kline event routing ───────────────────────────────────────────────────

test('2. kline event routing', () => {
  const bus = createTradingEventBus();
  let captured: unknown = null;
  bus.subscribe('market.kline.closed', (e) => { captured = e; });
  bus.publish('market.kline.closed', { kline, receivedAt: 2 });
  assert.ok(captured !== null);
  assert.equal((captured as any).type, 'market.kline.closed');
  assert.equal((captured as any).kline, kline);
});

// ── 3. bias event routing ────────────────────────────────────────────────────

test('3. bias event routing', () => {
  const bus = createTradingEventBus();
  let captured: unknown = null;
  bus.subscribe('research.bias.updated', (e) => { captured = e; });
  bus.publish('research.bias.updated', { report, receivedAt: 3 });
  assert.ok(captured !== null);
  assert.equal((captured as any).type, 'research.bias.updated');
  assert.equal((captured as any).report, report);
});

// ── 4. type isolation ────────────────────────────────────────────────────────

test('4. type isolation', () => {
  const bus = createTradingEventBus();
  let calls = 0;
  bus.subscribe('market.ticker.updated', () => { calls++; });
  bus.publish('market.kline.closed', { kline, receivedAt: 0 });
  assert.equal(calls, 0);
});

// ── 5. sequence monotonic ────────────────────────────────────────────────────

test('5. sequence monotonic', () => {
  const bus = createTradingEventBus();
  const r1 = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  const r2 = bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
});

// ── 6. zero subscribers still increments sequence ─────────────────────────────

test('6. zero subscribers still increments sequence', () => {
  const bus = createTradingEventBus();
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(r.sequence, 1);
});

// ── 7. kline confirm=false throws and does not increment sequence ────────────

test('7. kline confirm=false throws and does not increment sequence', () => {
  const bus = createTradingEventBus();
  let called = false;
  bus.subscribe('market.kline.closed', () => { called = true; });
  assert.throws(
    () => bus.publish('market.kline.closed', { kline: unconfirmed, receivedAt: 0 }),
    KlineClosedEventRejectedError,
  );
  assert.equal(called, false);
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(r.sequence, 1, 'kline guard did not consume sequence');
});

// ── 8. handler throw isolation ───────────────────────────────────────────────

test('8. handler throw isolation', () => {
  const bus = createTradingEventBus();
  const calls: number[] = [];
  bus.subscribe('market.ticker.updated', () => { calls.push(1); });
  bus.subscribe('market.ticker.updated', () => { calls.push(2); throw new Error(); });
  bus.subscribe('market.ticker.updated', () => { calls.push(3); });
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(r.delivered, 2);
  assert.equal(r.failures, 1);
});

// ── 9. async handler counted as failure ──────────────────────────────────────

test('9. async handler counted as failure', async () => {
  const bus = createTradingEventBus();
  let second = false;
  bus.subscribe('market.ticker.updated', async () => { /* thenable */ });
  bus.subscribe('market.ticker.updated', () => { second = true; });
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(r.failures, 1);
  assert.equal(r.delivered, 1);
  await new Promise(r => setTimeout(r, 10));
});

// ── 10. unsubscribe idempotent ───────────────────────────────────────────────

test('10. unsubscribe idempotent', () => {
  const bus = createTradingEventBus();
  let count = 0;
  const unsub = bus.subscribe('market.ticker.updated', () => { count++; });
  bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(count, 1);
  unsub(); unsub(); unsub(); // triple safe
  bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
  assert.equal(count, 1);
});

// ── 11. mid-publish unsubscribe uses snapshot ────────────────────────────────

test('11. mid-publish unsubscribe uses snapshot', () => {
  const bus = createTradingEventBus();
  const calls: string[] = [];
  let unsubB: () => void = () => {};
  bus.subscribe('market.ticker.updated', () => { calls.push('A'); unsubB(); });
  unsubB = bus.subscribe('market.ticker.updated', () => { calls.push('B'); });
  bus.subscribe('market.ticker.updated', () => { calls.push('C'); });
  bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.deepEqual(calls, ['A', 'B', 'C'], 'snapshot freeze');
  calls.length = 0;
  bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
  assert.deepEqual(calls, ['A', 'C'], 'B removed');
});

// ── 12. two bus instances independent ─────────────────────────────────────────

test('12. two bus instances independent', () => {
  const b1 = createTradingEventBus();
  const b2 = createTradingEventBus();
  const c1: number[] = [], c2: number[] = [];
  b1.subscribe('market.ticker.updated', () => c1.push(1));
  b2.subscribe('market.ticker.updated', () => c2.push(2));
  b1.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.deepEqual(c1, [1]);
  assert.deepEqual(c2, []);
});

// ── 13. PublishResult precise semantics ──────────────────────────────────────

test('13. PublishResult precise semantics', () => {
  const bus = createTradingEventBus();
  bus.subscribe('research.bias.updated', () => {});
  bus.subscribe('research.bias.updated', () => { throw new Error(); });
  bus.subscribe('research.bias.updated', async () => {});
  bus.subscribe('research.bias.updated', () => {});
  const r = bus.publish('research.bias.updated', { report, receivedAt: 0 });
  assert.equal(r.delivered, 2);
  assert.equal(r.failures, 2);
  assert.equal(r.sequence, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C2-R1 — Exchange provenance enforcement (new tests, additive)
// ═══════════════════════════════════════════════════════════════════════════

// Helper: a partial ticker with mutable exchange (for negative tests).
// The `as any` cast is local to the negative-test scope — positive tests always
// use the `ticker`/`kline` constants above, never this helper.
function tickerWithExchange(ex: unknown): WsTicker {
  return {
    channel: 'ticker',
    exchange: ex as any,
    instId: 'BTCUSDT', last: 67000,
    bestBid: 66990, bestAsk: 67010, volume24h: 10000, high24h: 68000, low24h: 66000, ts: 1000,
  } as any;
}
function klineWithExchange(ex: unknown): WsKline {
  return {
    channel: 'kline',
    exchange: ex as any,
    instId: 'BTCUSDT', interval: '1m',
    open: 66900, high: 67100, low: 66800, close: 67000, volume: 100, ts: 2000, confirm: true,
  } as any;
}

// ── 14. ticker missing exchange rejected ─────────────────────────────────────

test('14. ticker missing exchange rejected with InvalidExchangeProvenanceError', () => {
  const bus = createTradingEventBus();
  let called = false;
  bus.subscribe('market.ticker.updated', () => { called = true; });
  // Delete the exchange field entirely to simulate "missing"
  const badTicker = { ...ticker } as any;
  delete badTicker.exchange;
  assert.throws(
    () => bus.publish('market.ticker.updated', { ticker: badTicker as any, receivedAt: 0 }),
    InvalidExchangeProvenanceError,
  );
  assert.equal(called, false, 'subscriber must NOT be called on provenance rejection');
});

// ── 15. ticker unknown exchange rejected (coinbase / '' / BITGET / undefined) ─

test('15. ticker unknown exchange variants all rejected', () => {
  const bus = createTradingEventBus();
  for (const ex of ['coinbase', '', 'BITGET', undefined, null]) {
    let called = false;
    bus.subscribe('market.ticker.updated', () => { called = true; });
    assert.throws(
      () => bus.publish('market.ticker.updated', { ticker: tickerWithExchange(ex), receivedAt: 0 }),
      InvalidExchangeProvenanceError,
      `expected rejection for exchange=${JSON.stringify(ex)}`,
    );
    assert.equal(called, false, `subscriber must NOT be called for exchange=${JSON.stringify(ex)}`);
    // Re-create bus to clear subscribers between iterations.
    bus.subscribe('market.ticker.updated', () => {});
  }
});

// ── 16. kline missing exchange rejected ──────────────────────────────────────

test('16. kline missing exchange rejected with InvalidExchangeProvenanceError', () => {
  const bus = createTradingEventBus();
  let called = false;
  bus.subscribe('market.kline.closed', () => { called = true; });
  const badKline = { ...kline } as any;
  delete badKline.exchange;
  assert.throws(
    () => bus.publish('market.kline.closed', { kline: badKline as any, receivedAt: 0 }),
    InvalidExchangeProvenanceError,
  );
  assert.equal(called, false);
});

// ── 17. kline unknown exchange (coinbase) rejected ────────────────────────────

test('17. kline unknown exchange coinbase rejected', () => {
  const bus = createTradingEventBus();
  let called = false;
  bus.subscribe('market.kline.closed', () => { called = true; });
  assert.throws(
    () => bus.publish('market.kline.closed', { kline: klineWithExchange('coinbase') as any, receivedAt: 0 }),
    InvalidExchangeProvenanceError,
  );
  assert.equal(called, false);
});

// ── 18. valid exchange + confirm=false still rejects via KlineClosedEventRejectedError ──

test('18. valid exchange + confirm=false rejects via KlineClosedEventRejectedError, not provenance', () => {
  const bus = createTradingEventBus();
  let called = false;
  bus.subscribe('market.kline.closed', () => { called = true; });
  // unconfirmed has exchange: 'bitget' + confirm: false — must fail on confirm, NOT on provenance
  assert.throws(
    () => bus.publish('market.kline.closed', { kline: unconfirmed, receivedAt: 0 }),
    KlineClosedEventRejectedError,
  );
  assert.equal(called, false);
  // And it must NOT be an InvalidExchangeProvenanceError
  try {
    bus.publish('market.kline.closed', { kline: unconfirmed, receivedAt: 0 });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err instanceof KlineClosedEventRejectedError, true);
    assert.equal(err instanceof InvalidExchangeProvenanceError, false, 'confirm=false must not be reported as provenance error');
  }
});

// ── 19. InvalidExchangeProvenanceError is also an Error ──────────────────────

test('19. InvalidExchangeProvenanceError is an Error subclass', () => {
  const err = new InvalidExchangeProvenanceError('test');
  assert.ok(err instanceof Error, 'must extend Error');
  assert.ok(err instanceof InvalidExchangeProvenanceError);
  assert.equal(err.name, 'InvalidExchangeProvenanceError');
  assert.equal(err.message, 'test');
});

// ── 20. provenance rejection does NOT consume sequence ───────────────────────

test('20. provenance rejection does not consume sequence number', () => {
  const bus = createTradingEventBus();
  const badTicker = { ...ticker } as any;
  delete badTicker.exchange;
  assert.throws(() => bus.publish('market.ticker.updated', { ticker: badTicker as any, receivedAt: 0 }));
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(r.sequence, 1, 'first valid publish must be sequence 1 — provenance rejection did not consume');
});

// ── 21. event payload exposes NO standalone `source` field ────────────────────

test('21. event payload exposes no standalone `source` field — provenance is on kline.exchange', () => {
  const bus = createTradingEventBus();
  let captured: any = null;
  bus.subscribe('market.kline.closed', (e) => { captured = e; });
  bus.publish('market.kline.closed', { kline, receivedAt: 0 });
  assert.ok(captured, 'event delivered');
  assert.equal('source' in captured, false, 'event payload must not surface a top-level `source` field');
  assert.equal(captured.kline.exchange, 'bitget', 'provenance accessible via kline.exchange only');
});
