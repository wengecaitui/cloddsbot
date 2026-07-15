// Stage 3A1-R2: TradingEventBus tests — real WsTicker/WsKline/MarketBiasReportFull
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTradingEventBus, KlineClosedEventRejectedError } from '../../src/events/index';
import type { WsTicker, WsKline } from '../../src/data/types';
import type { MarketBiasReportFull } from '../../src/types/market-bias';

const ticker: WsTicker = {
  channel: 'ticker', instId: 'BTCUSDT', last: 67000,
  bestBid: 66990, bestAsk: 67010, volume24h: 10000, high24h: 68000, low24h: 66000, ts: 1000,
};
const kline: WsKline = {
  channel: 'kline', instId: 'BTCUSDT', interval: '1m',
  open: 66900, high: 67100, low: 66800, close: 67000, volume: 100, ts: 2000, confirm: true,
};
const unconfirmed: WsKline = { ...kline, confirm: false };
const report = { timestamp: 1000, meta: { source: 'hermes_cron' as const, modelVersion: '1.0', generationTimeMs: 100, inputSummary: '' } } as MarketBiasReportFull;

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

test('2. kline event routing', () => {
  const bus = createTradingEventBus();
  let captured: unknown = null;
  bus.subscribe('market.kline.closed', (e) => { captured = e; });
  bus.publish('market.kline.closed', { kline, receivedAt: 2 });
  assert.ok(captured !== null);
  assert.equal((captured as any).type, 'market.kline.closed');
  assert.equal((captured as any).kline, kline);
});

test('3. bias event routing', () => {
  const bus = createTradingEventBus();
  let captured: unknown = null;
  bus.subscribe('research.bias.updated', (e) => { captured = e; });
  bus.publish('research.bias.updated', { report, receivedAt: 3 });
  assert.ok(captured !== null);
  assert.equal((captured as any).type, 'research.bias.updated');
  assert.equal((captured as any).report, report);
});

test('4. type isolation', () => {
  const bus = createTradingEventBus();
  let calls = 0;
  bus.subscribe('market.ticker.updated', () => { calls++; });
  bus.publish('market.kline.closed', { kline, receivedAt: 0 });
  assert.equal(calls, 0);
});

test('5. sequence monotonic', () => {
  const bus = createTradingEventBus();
  const r1 = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  const r2 = bus.publish('market.ticker.updated', { ticker, receivedAt: 1 });
  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
});

test('6. zero subscribers still increments sequence', () => {
  const bus = createTradingEventBus();
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(r.sequence, 1);
});

test('7. kline confirm=false throws and does not increment sequence', () => {
  const bus = createTradingEventBus();
  let called = false;
  bus.subscribe('market.kline.closed', () => { called = true; });
  assert.throws(() => bus.publish('market.kline.closed', { kline: unconfirmed, receivedAt: 0 }), KlineClosedEventRejectedError);
  assert.equal(called, false);
  const r = bus.publish('market.ticker.updated', { ticker, receivedAt: 0 });
  assert.equal(r.sequence, 1, 'kline guard did not consume sequence');
});

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
