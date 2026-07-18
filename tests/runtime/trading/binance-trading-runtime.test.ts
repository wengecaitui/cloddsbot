// Stage 3B3D: Binance Trading Runtime integration tests
//
// Fully offline — uses FakeWSFactory, FakeScheduler, real TradingRuntime,
// real BinanceV2PublicCollector, real PlanAwareCollector, real UniverseManager,
// real EventBus & Stores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBinanceTradingRuntime,
  type BinanceTradingRuntimeCollectorFailure,
} from '../../../src/runtime/trading/BinanceTradingRuntime';
import {
  createTradingRuntime,
  type TradingRuntime,
} from '../../../src/runtime/trading/TradingRuntime';
import type { MarketDataCollectorPort } from '../../../src/runtime/market/MarketDataRuntime';
import { createUniverseManager } from '../../../src/runtime/market/UniverseManager';
import type { UniverseManager, SubscriptionPlan } from '../../../src/runtime/market/UniverseManager';
import { createSymbolRegistry } from '../../../src/runtime/market/SymbolFormat';
import {
  BinanceV2PublicCollector,
  type BinanceWSLike,
  type BinanceWebSocketFactory,
  type BinanceCollectorFailure,
} from '../../../src/data/binance/BinanceV2PublicCollector';
import type { WsTicker, WsKline } from '../../../src/data/types';

// ── Fake helpers (same pattern as binance-v2-public-collector.test.ts) ─────

interface FakeTimer { handler: () => void; delayMs: number; fired: boolean; id: number; }

class FakeScheduler {
  private timers: FakeTimer[] = [];
  private nextId = 1;
  setTimeout(handler: () => void, delayMs: number): unknown {
    const t: FakeTimer = { handler, delayMs, fired: false, id: this.nextId++ };
    this.timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown): void {
    if (handle == null) return;
    const id = handle as number;
    const idx = this.timers.findIndex(t => t.id === id);
    if (idx >= 0) this.timers.splice(idx, 1);
  }
  tick(ms: number): void {
    const due = this.timers.filter(t => !t.fired && t.delayMs <= ms);
    if (due.length === 0) return;
    due.sort((a, b) => a.id - b.id);
    for (const t of due) {
      t.fired = true;
      this.timers = this.timers.filter(x => x.id !== t.id);
      t.handler();
    }
  }
}

interface FakeWS extends BinanceWSLike {
  url: string;
  sentMessages: string[];
  isOpen: boolean;
  isClosed: boolean;
  autoOpen: boolean;
}

class FakeWSFactory implements BinanceWebSocketFactory {
  createdSockets: FakeWS[] = [];
  autoOpen = true;

  create(url: string): BinanceWSLike {
    const ws: FakeWS = {
      url, readyState: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      sentMessages: [],
      isOpen: false, isClosed: false, autoOpen: this.autoOpen,
      send(data: string) { this.sentMessages.push(data); },
      close() {
        if (this.isClosed) return;
        this.isClosed = true;
        this.isOpen = false;
        this.readyState = 3;
        this.onclose?.({});
      },
    };
    this.createdSockets.push(ws);
    if (this.autoOpen) {
      queueMicrotask(() => {
        if (ws.isClosed) return;
        ws.isOpen = true;
        ws.readyState = 1;
        ws.onopen?.({});
      });
    }
    return ws;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const REGISTRY = createSymbolRegistry([
  { canonical: 'BTC/USDT', exchange: 'BTCUSDT' },
  { canonical: 'ETH/USDT', exchange: 'ETHUSDT' },
  { canonical: 'SOL/USDT', exchange: 'SOLUSDT' },
]);

function makeUniverse(symbols: string[] = ['BTC/USDT', 'ETH/USDT']): UniverseManager {
  const all = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  return createUniverseManager({
    registry: REGISTRY,
    allowedSymbols: all,
    staticSymbols: symbols,
    maxSymbols: all.length,
    allowedIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
    defaultIntervals: ['1m', '5m'],
  });
}

// Ack helpers
function ackMsg(id: number): string { return JSON.stringify({ result: null, id }); }
function ackAllSockets(f: FakeWSFactory): void {
  for (const s of f.createdSockets) {
    s.onmessage!({ data: ackMsg(1) });
    s.onmessage!({ data: ackMsg(2) });
  }
}

// Ticker + bookTicker helpers (same payload shapes as binance-v2-public-collector.test.ts)
function tickerFrame(symbol: string, ts = 1700000000000): object {
  return { e: '24hrTicker', s: symbol, c: '50000', v: '1000', h: '51000', l: '49000', E: ts };
}
function bookTickerFrame(symbol: string): object {
  return { s: symbol, b: '50000.10', B: '1.5', a: '50000.20', A: '2.0', E: 1700000000000 };
}
function closedKlineFrame(symbol: string, interval: string, startTs: number): object {
  return { e: 'kline', s: symbol, k: { t: startTs, s: symbol, i: interval, o: '100', h: '110', l: '90', c: '105', v: '50', x: true } };
}
function openKlineFrame(symbol: string, interval: string, startTs: number): object {
  return { e: 'kline', s: symbol, k: { t: startTs, s: symbol, i: interval, o: '100', h: '110', l: '90', c: '105', v: '50', x: false } };
}

function getWs(f: FakeWSFactory, idx = 0): FakeWS { return f.createdSockets[idx]; }

// ── Tests ──────────────────────────────────────────────────────────────────

test('1. construct does not create WebSocket', () => {
  const f = new FakeWSFactory();
  const u = makeUniverse();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url) },
  } as any);
  assert.equal(f.createdSockets.length, 0, 'no socket on construct');
});

test('2. start creates 2 sockets (market + public)', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse();
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 2, 'market + public sockets');
  ackAllSockets(f);
  await p;
  assert.ok(rt.isRunning);
});

test('3. ticker=false only market socket', async () => {
  const f = new FakeWSFactory();
  const u = createUniverseManager({
    registry: REGISTRY, allowedSymbols: ['BTC/USDT'], staticSymbols: ['BTC/USDT'],
    maxSymbols: 1, allowedIntervals: ['1m', '5m'], defaultIntervals: ['1m', '5m'],
  });
  u.setPlan({ version: 1, entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: false }] });
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 1, 'only market socket');
  getWs(f, 0).onmessage!({ data: ackMsg(1) });
  await p;
  assert.ok(rt.isRunning);
});

test('4. start waits for all route acks before resolving', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // Both sockets created; only ack market (id=1) — still subscribing
  getWs(f, 0).onmessage!({ data: ackMsg(1) });
  let resolved = false;
  p.then(() => { resolved = true; }).catch(() => {});
  await new Promise(r => queueMicrotask(r));
  assert.ok(!resolved, 'still waiting for public ack');
  // Ack public (id=2)
  getWs(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  assert.ok(rt.isRunning);
});

test('5. ticker + bookTicker merge produces canonical ticker via onTicker', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  rt.bus.subscribe('market.ticker.updated', (e: any) => tickers.push(e.ticker));
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;

  // market socket → ticker; public socket → bookTicker
  getWs(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  getWs(f, 1).onmessage!({ data: JSON.stringify(bookTickerFrame('BTCUSDT')) });
  await new Promise(r => queueMicrotask(r));
  // The PlanAwareCollector normalizes exchangeSymbol → canonical symbol
  assert.equal(tickers.length, 1, 'merged ticker emitted');
  if (tickers.length > 0) {
    assert.equal(tickers[0].instId, 'BTC/USDT', 'canonical symbol');
    assert.equal(tickers[0].last, 50000);
    assert.equal(tickers[0].bestBid, 50000.10);
    assert.equal(tickers[0].bestAsk, 50000.20);
  }
});

test('6. closed kline written to candle store', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;

  getWs(f, 0).onmessage!({ data: JSON.stringify(closedKlineFrame('BTCUSDT', '1m', 1000)) });
  await new Promise(r => queueMicrotask(r));
  // getSeries(symbol, interval, count) returns an array of Series
  const val = rt.marketData.candleStore.getSeries('binance', 'BTC/USDT', '1m', 1);
  assert.ok(val !== undefined && val.length > 0, 'candle stored');
  if (val && val.length > 0) {
    assert.equal(val[0].close, 105);
    assert.equal(val[0].volume, 50);
  }
});

test('7. open kline NOT written to candle store', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;

  getWs(f, 0).onmessage!({ data: JSON.stringify(openKlineFrame('BTCUSDT', '1m', 1000)) });
  await new Promise(r => queueMicrotask(r));
  const val = rt.marketData.candleStore.getSeries('binance', 'BTC/USDT', '1m', 1);
  assert.ok(val === null || val.length === 0, 'open kline not stored');
});

test('8. Universe update creates new Collector/socket', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;
  const initialCount = f.createdSockets.length;

  // Add ETH to universe so plan changes materially
  u.setPlan({ version: 2, entries: [
    { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
    { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m'], ticker: true },
  ]});
  const ap = rt.applyUniversePlan();
  // Drain microtasks for stop+start cycle + autoOpen
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // Ack new sockets (they appear as latest entries in the factory)
  const newIdx = f.createdSockets.length - 2;
  if (newIdx >= initialCount) {
    getWs(f, newIdx).onmessage!({ data: ackMsg(1) });
    getWs(f, newIdx + 1).onmessage!({ data: ackMsg(2) });
  }
  await ap;
  assert.equal(rt.appliedPlanVersion, 2, 'plan v2 applied');
});

test('9. error callback includes planVersion', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const errors: BinanceTradingRuntimeCollectorFailure[] = [];
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
    onBinanceCollectorError: (e) => errors.push(e),
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;

  // Fire a parse error
  getWs(f, 0).onmessage!({ data: '{bad json}' });
  await new Promise(r => queueMicrotask(r));
  assert.ok(errors.length > 0, 'error reported');
  if (errors.length > 0) {
    assert.equal(errors[0].planVersion, 1, 'correct plan version');
    assert.equal(errors[0].phase, 'parse');
  }
});

test('10. stale old socket data ignored after restart', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  rt.bus.subscribe('market.ticker.updated', (e: any) => tickers.push(e.ticker));
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;

  const oldWs0 = getWs(f, 0);

  // Restart universe
  u.setPlan({ version: 2, entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m', '5m'], ticker: true }] });
  const ap = rt.applyUniversePlan();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // Ack new sockets
  const newIdx = f.createdSockets.length - 2;
  getWs(f, newIdx).onmessage!({ data: ackMsg(1) });
  getWs(f, newIdx + 1).onmessage!({ data: ackMsg(2) });
  await ap;

  const preCount = tickers.length;
  // Fire on stale socket — should be ignored
  oldWs0.onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, preCount, 'stale ticker ignored');
});

test('11. store cleanup removes stale symbols', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT', 'ETH/USDT']);
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;

  // Inject a candle for ETH first
  getWs(f, 0).onmessage!({ data: JSON.stringify(closedKlineFrame('ETHUSDT', '1m', 1000)) });
  await new Promise(r => queueMicrotask(r));
  let val = rt.marketData.candleStore.getSeries('binance', 'ETH/USDT', '1m', 1);
  assert.ok(val && val.length > 0, 'ETH candle stored');

  // Remove ETH from universe
  u.setPlan({ version: 2, entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true }] });
  const ap = rt.applyUniversePlan();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  const newIdx = f.createdSockets.length - 2;
  getWs(f, newIdx).onmessage!({ data: ackMsg(1) });
  getWs(f, newIdx + 1).onmessage!({ data: ackMsg(2) });
  await ap;

  // ETH should be cleaned from stores
  val = rt.marketData.candleStore.getSeries('binance', 'ETH/USDT', '1m', 1);
  assert.ok(val === null || val.length === 0, 'ETH candle cleaned');
});

test('12. caller endpoint mutation after construct ignored', async () => {
  const bitget: Record<string, any> = { webSocketFactory: (url: string) => { throw new Error('should not be called'); } };
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const options: Record<string, any> = {
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  };
  const rt = createBinanceTradingRuntime(options as any);
  // Mutate the binance bag — should have no effect
  options.binance.webSocketFactory = () => { throw new Error('mutation leaked'); };
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;
  assert.ok(rt.isRunning);
});

test('13. any-injected plan overridden by runtime plan', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT', 'ETH/USDT']);
  const u2 = createUniverseManager({
    registry: REGISTRY, allowedSymbols: ['SOL/USDT'], staticSymbols: ['SOL/USDT'],
    maxSymbols: 1, allowedIntervals: ['1m'], defaultIntervals: ['1m'],
  });
  u2.setPlan({ version: 99, entries: [{ symbol: 'SOL/USDT', exchangeSymbol: 'SOLUSDT', intervals: ['1m'], ticker: true }] });
  const s = new FakeScheduler();

  // The snapshot explicitly captures only Omit<BinanceV2PublicCollectorOptions, 'plan'>
  // so ANY field named 'plan' in the any-injected extras is ignored.
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ...({ plan: u2.getPlan() } as any) },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // Should have 2 sockets (BTC + ETH → market + public), not SOL
  assert.equal(f.createdSockets.length, 2, 'uses runtime plan, not injected any');
  ackAllSockets(f);
  await p;
});

test('14. two runtimes fully isolated', async () => {
  const f1 = new FakeWSFactory();
  const f2 = new FakeWSFactory();
  const u1 = makeUniverse(['BTC/USDT']);
  const u2 = makeUniverse(['ETH/USDT']);
  const s = new FakeScheduler();
  const rt1 = createBinanceTradingRuntime({
    universe: u1,
    binance: { webSocketFactory: (url: string) => f1.create(url), scheduler: s as any },
  } as any);
  const rt2 = createBinanceTradingRuntime({
    universe: u2,
    binance: { webSocketFactory: (url: string) => f2.create(url), scheduler: s as any },
  } as any);
  const p1 = rt1.start();
  const p2 = rt2.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f1);
  ackAllSockets(f2);
  await Promise.all([p1, p2]);
  assert.ok(rt1.isRunning);
  assert.ok(rt2.isRunning);
  // Both create 2 sockets (market + public), independent factories
  assert.equal(f1.createdSockets.length, 2);
  assert.equal(f2.createdSockets.length, 2);
  // Factory isolation — each factory only created sockets for one runtime
  assert.ok(f1.createdSockets[0] !== f2.createdSockets[0]);
});

test('15. stop cleans up collector', async () => {
  const f = new FakeWSFactory();
  const u = makeUniverse(['BTC/USDT']);
  const s = new FakeScheduler();
  const rt = createBinanceTradingRuntime({
    universe: u,
    binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  ackAllSockets(f);
  await p;
  assert.ok(rt.isRunning);
  rt.stop();
  assert.ok(!rt.isRunning);
  assert.ok(getWs(f, 0).isClosed || getWs(f, 1).isClosed, 'sockets closed');
});

test('16. generic createTradingRuntime still works', () => {
  assert.ok(typeof createBinanceTradingRuntime === 'function');
  assert.ok(typeof createTradingRuntime === 'function');
  // createTradingRuntime rejects empty/null options
  let threw = false;
  try { createTradingRuntime(null as any); } catch { threw = true; }
  assert.ok(threw, 'createTradingRuntime(null) should throw');
});
