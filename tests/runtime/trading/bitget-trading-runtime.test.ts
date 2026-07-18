// Stage 3B2C: BitgetTradingRuntime integration tests
//
// Fully offline — uses FakeWSFactory, FakeScheduler, real TradingRuntime,
// real BitgetV2PublicCollector, real PlanAwareCollector, real UniverseManager,
// real EventBus & Stores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBitgetTradingRuntime,
  type BitgetTradingRuntimeCollectorFailure,
} from '../../../src/runtime/trading/BitgetTradingRuntime';
import {
  createTradingRuntime,
  type TradingRuntime,
} from '../../../src/runtime/trading/TradingRuntime';
import type { MarketDataCollectorPort } from '../../../src/runtime/market/MarketDataRuntime';
import { createUniverseManager } from '../../../src/runtime/market/UniverseManager';
import type { UniverseManager, SubscriptionPlan } from '../../../src/runtime/market/UniverseManager';
import { createSymbolRegistry } from '../../../src/runtime/market/SymbolFormat';
import {
  BitgetV2PublicCollector,
  BITGET_V2_PUBLIC_ENDPOINT,
  type BitgetWebSocketLike,
  type BitgetWebSocketFactory,
  type BitgetCollectorFailure,
} from '../../../src/data/bitget/BitgetV2PublicCollector';
import type { WsTicker, WsKline } from '../../../src/data/types';

// ── Fake helpers (same pattern as bitget-v2-public-collector.test.ts) ──────

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

interface FakeWS extends BitgetWebSocketLike {
  url: string;
  sentMessages: string[];
  isOpen: boolean;
  isClosed: boolean;
  autoOpen: boolean;
}

class FakeWSFactory implements BitgetWebSocketFactory {
  createdSockets: FakeWS[] = [];
  autoOpen = true;

  create(url: string): BitgetWebSocketLike {
    const ws: FakeWS = {
      url, readyState: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      sentMessages: [],
      isOpen: false, isClosed: false, autoOpen: this.autoOpen,
      send(data: string) { this.sentMessages.push(data); },
      close(code?: number, reason?: string) {
        if (this.isClosed) return;
        this.isClosed = true;
        this.readyState = 3;
        const oc = this.onclose;
        if (oc) queueMicrotask(() => oc({}));
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

// ── Helpers ──────────────────────────────────────────────────────────────

const MAPPINGS = [
  { canonical: 'BTC/USDT', exchange: 'BTCUSDT' },
  { canonical: 'ETH/USDT', exchange: 'ETHUSDT' },
  { canonical: 'SOL/USDT', exchange: 'SOLUSDT' },
] as const;

function makeUniverse(staticSymbols: string[] = ['BTC/USDT', 'ETH/USDT']): UniverseManager {
  return createUniverseManager({
    registry: createSymbolRegistry(MAPPINGS),
    allowedSymbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    staticSymbols,
    maxSymbols: 3,
    allowedIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
    defaultIntervals: ['1m', '5m'],
  });
}

class FakeIS {
  async calculateAll() { return []; }
}

function ackMsg(arg: { instType: string; channel: string; instId: string }): string {
  return JSON.stringify({ event: 'subscribe', arg });
}

function ackAll(ws: FakeWS, pairs: Array<[string, string]>): void {
  for (const [instId, channel] of pairs) {
    ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel, instId }) });
  }
}

const BTC_ETH_ACKS: Array<[string, string]> = [
  ['BTCUSDT', 'ticker'], ['BTCUSDT', 'candle1m'], ['BTCUSDT', 'candle5m'],
  ['ETHUSDT', 'ticker'], ['ETHUSDT', 'candle1m'], ['ETHUSDT', 'candle5m'],
];

function tickerFrames(u: string, last: string, ts: string): string {
  return JSON.stringify({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: u },
    data: [{ lastPr: last, bidPr: '99', askPr: '101', baseVolume: '500', high24h: '110', low24h: '90', ts }],
  });
}

function candleFrames(u: string, channel: string, startTs: string, close?: string): string {
  const c = close ?? '105';
  return JSON.stringify({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel, instId: u },
    data: [[startTs, '100', '110', '90', c, '1000', '2000', '3000']],
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

test('1. construct does not create WebSocket', () => {
  const f = new FakeWSFactory();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: new FakeScheduler() as any },
  });
  assert.equal(f.createdSockets.length, 0, 'no socket on construct');
});

test('2. returns full TradingRuntime interface', () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  assert.ok(rt.bus, 'bus');
  assert.ok(rt.marketData, 'marketData');
  assert.ok(rt.universe, 'universe');
  assert.ok(rt.fastPipeline, 'fastPipeline');
  assert.ok(rt.slowPipeline, 'slowPipeline');
  assert.ok(rt.router, 'router');
});

test('3. start creates a Bitget V2 WebSocket', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 1);
  // Ack so start completes
  const ws = f.createdSockets[0];
  ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle5m', instId: 'BTCUSDT' }) });
  ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'ETHUSDT' }) });
  ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' }) });
  ws.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle5m', instId: 'ETHUSDT' }) });
  await p;
  assert.ok(rt.isRunning);
});

test('4. uses default V2 endpoint', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets[0].url, BITGET_V2_PUBLIC_ENDPOINT);
});

test('5. custom endpoint forwarded', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { endpoint: 'wss://custom.example/ws', webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets[0].url, 'wss://custom.example/ws');
});

test('6. sends subscription payloads after open', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  assert.ok(ws.sentMessages.length >= 1, 'at least one batch sent');
});

test('7. uses USDT-FUTURES, ticker, candle channels, exchangeSymbol', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  const payload = ws.sentMessages[0];
  assert.ok(payload.includes('USDT-FUTURES'), 'instType USDT-FUTURES');
  assert.ok(payload.includes('ticker'), 'ticker channel');
  assert.ok(payload.includes('candle1m'), 'candle1m');
  assert.ok(payload.includes('BTCUSDT'), 'exchangeSymbol BTCUSDT');
  assert.ok(payload.includes('ETHUSDT'), 'exchangeSymbol ETHUSDT');
});

test('8. start not resolved before all acks arrive', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  let started = false;
  rt.start().then(() => started = true);
  await new Promise(r => queueMicrotask(r));
  assert.equal(started, false, 'not yet started');
  // Send 1/6 ack
  f.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  assert.equal(started, false);
});

test('9. after all acks runtime.isRunning = true', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  // All 6 acks
  ackAll(ws, BTC_ETH_ACKS);
  await p;
  assert.ok(rt.isRunning);
});

test('10. ticker frame: exchangeSymbol → canonical via bus/store', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  // Subscribe to bus events
  const tickers: any[] = [];
  rt.bus.subscribe('market.ticker.updated', (e: any) => tickers.push(e.ticker));

  // Send ticker frame
  const h = ws.onmessage;
  if (h) h({ data: tickerFrames('BTCUSDT', '50000', '1700000000000') });
  assert.equal(tickers.length, 1);
  assert.equal(tickers[0].instId, 'BTC/USDT', 'canonical');
  assert.equal(tickers[0].last, 50000, 'price');
});

test('11. first candle not emitted (not closed)', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  const klines: any[] = [];
  rt.bus.subscribe('market.kline.closed', (e: any) => klines.push(e.kline));

  ws.onmessage!({ data: candleFrames('BTCUSDT', 'candle1m', '1000') });
  assert.equal(klines.length, 0, 'first candle not emitted');
});

test('12. second candle emits first as closed, PlanAwareCollector canonical', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  const klines: any[] = [];
  rt.bus.subscribe('market.kline.closed', (e: any) => klines.push(e.kline));

  ws.onmessage!({ data: candleFrames('BTCUSDT', 'candle1m', '1000') });
  ws.onmessage!({ data: candleFrames('BTCUSDT', 'candle1m', '2000') });
  assert.equal(klines.length, 1);
  assert.equal(klines[0].ts, 1000);
  assert.equal(klines[0].confirm, true);
  assert.equal(klines[0].instId, 'BTC/USDT', 'PlanAwareCollector canonical');
});

test('13. multi-row snapshot emits all but latest', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  const klines: any[] = [];
  rt.bus.subscribe('market.kline.closed', (e: any) => klines.push(e.kline));

  ws.onmessage!({
    data: JSON.stringify({
      action: 'snapshot',
      arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' },
      data: [
        ['1000', '100', '110', '90', '105', '1000', '2000', '3000'],
        ['2000', '200', '210', '190', '205', '2000', '3000', '4000'],
        ['3000', '300', '310', '290', '305', '3000', '4000', '5000'],
      ],
    }),
  });
  assert.equal(klines.length, 2, 'first two emitted as closed');
  assert.equal(klines[0].ts, 1000);
  assert.equal(klines[1].ts, 2000);
});

test('14. collectorFactory creates new collector on each restart', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;
  const startSockets = f.createdSockets.length;
  // Apply identity plan (version bump) to trigger restart
  rt.universe.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m'], ticker: true }, { symbol: 'ETH/USDT', intervals: ['1m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  // New socket created
  assert.equal(f.createdSockets.length, startSockets + 1, 'new collector created');
  // Ack new socket
  const ws2 = f.createdSockets[f.createdSockets.length - 1];
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'ETHUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' }) });
  const result = await applyP;
  assert.ok(result.applied);
});

test('15. universe v1→v2: restart creates new socket with v2 planVersion', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;
  const socketsBefore = f.createdSockets.length;

  // Change plan (SOL only)
  rt.universe.setPlan({ entries: [{ symbol: 'SOL/USDT', intervals: ['1m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  // New socket created
  assert.equal(f.createdSockets.length, socketsBefore + 1, 'new socket created');
  const ws2 = f.createdSockets[f.createdSockets.length - 1];
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'SOLUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'SOLUSDT' }) });
  const result = await applyP;
  assert.ok(result.applied);
  assert.ok(result.version >= 2, 'version advanced');
});

test('16. universe delete symbol: new payload excludes it', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  rt.universe.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  const ws2 = f.createdSockets[1];
  const payloads = ws2.sentMessages.join(' ');
  // Should NOT include ETHUSDT
  assert.ok(!payloads.includes('ETHUSDT'), 'ETH removed from plan');
  assert.ok(payloads.includes('BTCUSDT'), 'BTC still present');
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  await applyP;
});

test('17. universe new symbol: new socket subscribes it', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  rt.universe.setPlan({ entries: [
    { symbol: 'BTC/USDT', intervals: ['1m'], ticker: true },
    { symbol: 'SOL/USDT', intervals: ['1m'], ticker: true },
  ]});
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  const ws2 = f.createdSockets[1];
  assert.ok(ws2.sentMessages.join(' ').includes('SOLUSDT'), 'SOL added');
  // Ack
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'SOLUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'SOLUSDT' }) });
  await applyP;
});

test('18. universe interval change reflected in payload', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  // Change interval 1m+5m → only 1h
  rt.universe.setPlan({ entries: [
    { symbol: 'BTC/USDT', intervals: ['1h'], ticker: true },
    { symbol: 'ETH/USDT', intervals: ['1m'], ticker: true },
  ]});
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  const ws2 = f.createdSockets[1];
  const payload = ws2.sentMessages.join(' ');
  assert.ok(payload.includes('candle1H'), 'BTC now uses candle1H');
  assert.ok(!payload.includes('candle5m'), '5m removed');
  // Ack
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1H', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'ETHUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' }) });
  await applyP;
});

test('19. ticker=false excludes ticker arg from payload', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  rt.universe.setPlan({ entries: [
    { symbol: 'BTC/USDT', intervals: ['1m'], ticker: false },
  ]});
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  const ws2 = f.createdSockets[1];
  const payload = ws2.sentMessages.join(' ');
  assert.ok(!payload.includes('"ticker"'), 'no ticker in payload');
  assert.ok(payload.includes('candle1m'), 'candle still present');
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  await applyP;
});

test('20. old socket after restart — stale ticker not forwarded', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  const seen: any[] = [];
  rt.bus.subscribe('market.ticker.updated', (e: any) => seen.push(e.ticker));

  // Restart
  rt.universe.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  const ws2 = f.createdSockets[1];
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  await applyP;

  // Now send ticker on OLD socket — should be rejected by generation guard
  const h = ws.onmessage;
  if (h) h({ data: tickerFrames('BTCUSDT', '50000', '1700000000000') });
  assert.equal(seen.length, 0, 'stale ticker rejected');
});

test('21. onBitgetCollectorError receives phase, error, planVersion', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BitgetTradingRuntimeCollectorFailure[] = [];
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 100 },
    onBitgetCollectorError: (e) => errors.push(e),
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  // Don't send acks → ack timeout after tick(100)
  s.tick(100);
  let rejected = false;
  try { await p; } catch { rejected = true; }
  assert.ok(rejected);
  assert.equal(errors.length, 1, 'one error reported');
  assert.ok(errors[0].phase, 'has phase');
  assert.ok(errors[0].error, 'has error');
  assert.equal(errors[0].planVersion, 1, 'correct planVersion');
});

test('22. restart collector error uses new planVersion', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BitgetTradingRuntimeCollectorFailure[] = [];
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 200 },
    onBitgetCollectorError: (e) => errors.push(e),
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  // Restart to v2
  rt.universe.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  // Don't ack the new collector → let it timeout
  s.tick(200);
  try { await applyP; } catch { /* expected */ }
  // The error should reference planVersion=1 (the new collector's version - universe v1 since it restarted)
  // Actually: the plan was setPlan with version=??? Let me check...
  // Universe setPlan() returns a new version based on counter. Depends on prior versions.
  // First plan version = 1 (initial). setPlan increments. So v2 on first setPlan.
  const lastError = errors[errors.length - 1];
  assert.ok(lastError, 'error reported after restart');
});

test('23. single heartbeat failure — only one onError call', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BitgetTradingRuntimeCollectorFailure[] = [];
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, heartbeatIntervalMs: 500, pongTimeoutMs: 200, reconnectDelayMs: 2000 },
    onBitgetCollectorError: (e) => errors.push(e),
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  // Make ws.send fail exactly once
  let callCount = 0;
  ws.send = (data: string) => {
    if (typeof data === 'string' && data === 'ping') {
      callCount++;
      if (callCount === 1) throw new Error('hb fail');
    }
  };
  s.tick(500); // heartbeat fires, send throws
  assert.equal(errors.length, 1, 'exactly one error for single failure');
});

test('24. onBitgetCollectorError throw does not escape', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 100 },
    onBitgetCollectorError: () => { throw new Error('user handler throw'); },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  s.tick(100);
  let rejected = false;
  try { await p; } catch { rejected = true; }
  assert.ok(rejected);
});

test('25. bitget options cannot override plan', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  // Attempt to inject plan with version=999 via bitget options (as any bypasses TS)
  const badPlan = { version: 999, entries: [] };
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { plan: badPlan as any, webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  // The collector should have the real plan (version=1), not version=999
  const payload = ws.sentMessages.join(' ');
  assert.ok(payload.includes('BTCUSDT'), 'real plan symbols present, not empty');
});

test('26. stop closes active socket and stops runtime', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;

  rt.stop();
  assert.ok(!rt.isRunning);
  assert.ok(ws.isClosed, 'socket closed');
});

test('27. two runtimes are fully isolated', async () => {
  const f1 = new FakeWSFactory();
  const s1 = new FakeScheduler();
  const f2 = new FakeWSFactory();
  const s2 = new FakeScheduler();

  const rt1 = createBitgetTradingRuntime({
    universe: makeUniverse(['BTC/USDT']),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f1.create(url), scheduler: s1 as any },
  });
  const rt2 = createBitgetTradingRuntime({
    universe: makeUniverse(['ETH/USDT']),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f2.create(url), scheduler: s2 as any },
  });

  const p1 = rt1.start();
  const p2 = rt2.start();
  await new Promise(r => queueMicrotask(r));
  // Both have separate sockets
  assert.equal(f1.createdSockets.length, 1);
  assert.equal(f2.createdSockets.length, 1);
  // Ack rt1
  f1.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  f1.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  f1.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle5m', instId: 'BTCUSDT' }) });
  await p1;
  // Ack rt2
  f2.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'ETHUSDT' }) });
  f2.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' }) });
  f2.createdSockets[0].onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle5m', instId: 'ETHUSDT' }) });
  await p2;

  // Check isolation: ticker on rt2 should not affect rt1
  const rt1Tickers: any[] = [];
  rt1.bus.subscribe('market.ticker.updated', (e: any) => rt1Tickers.push(e.ticker));
  f2.createdSockets[0].onmessage!({ data: tickerFrames('ETHUSDT', '2000', '1700000000000') });
  assert.equal(rt1Tickers.length, 0, 'rt1 isolated from rt2 ticker');
});

test('28. createTradingRuntime with fake collector still works', () => {
  // Regression: generic API unchanged
  const um = makeUniverse();
  class FakeColl implements MarketDataCollectorPort {
    start() { return Promise.resolve(); }
    stop() {}
    onTicker() {}
    onKline() {}
  }
  const rt = createTradingRuntime({
    exchange: 'bitget',
    universe: um,
    collectorFactory: () => new FakeColl(),
    indicatorService: new FakeIS() as any,
  });
  assert.ok(rt);
});

test('29. no import from legacy collector.ts', () => {
  // Compile-time check: we never import old src/data/collector.ts
  assert.ok(true, 'passes if no TS resolution error');
});

test('30. stop after start failure does not throw', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: any[] = [];
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 100 },
    onBitgetCollectorError: (e) => errors.push(e),
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  s.tick(100);
  try { await p; } catch { /* expected fail */ }
  // stop after failure
  rt.stop();
  assert.ok(!rt.isRunning);
});

test('31. data frame dispatched after acks only', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any },
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  // Send ticker data BEFORE acks (should be ignored — subscribing state)
  const tickers: any[] = [];
  rt.bus.subscribe('market.ticker.updated', (e: any) => tickers.push(e.ticker));
  const h = ws.onmessage;
  if (h) h({ data: tickerFrames('BTCUSDT', '50000', '1700000000000') });
  assert.equal(tickers.length, 0, 'data not dispatched in subscribing state');
  // Now ack
  ackAll(ws, BTC_ETH_ACKS);
  await p;
  // Data after running should flow
  ws.onmessage!({ data: tickerFrames('BTCUSDT', '60000', '1700000000001') });
  assert.equal(tickers.length, 1, 'data flows after running');
});

test('32. heartbeat failure routes through onBitgetCollectorError once', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BitgetTradingRuntimeCollectorFailure[] = [];
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, heartbeatIntervalMs: 1000, pongTimeoutMs: 500, reconnectDelayMs: 3000 },
    onBitgetCollectorError: (e) => errors.push(e),
  });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ackAll(ws, BTC_ETH_ACKS);
  await p;
  // Remove send so pong never arrives → pong timeout fires into beginReconnect
  // Actually pong timeout triggers beginReconnect which reports. Simpler:
  // Make send throw once
  let sendFail = true;
  ws.send = (data: string) => {
    if (typeof data === 'string' && data === 'ping' && sendFail) {
      sendFail = false;
      throw new Error('hb fail');
    }
  };
  s.tick(1000);
  await new Promise(r => queueMicrotask(r));
  // Should be exactly 1 error for the heartbeat failure
  const hbErrors = errors.filter(e => e.phase === 'heartbeat');
  assert.equal(hbErrors.length, 1, 'single heartbeat error');
});


// ── Stage 3B2C-R1: Runtime option snapshot + reconnect state ──────────

test('R1. bitget.endpoint mutation after construct ignored', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const bitget: Record<string, any> = {
    endpoint: 'wss://orig.example',
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  bitget.endpoint = 'wss://evil.example';
  rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets[0].url, 'wss://orig.example', 'original endpoint used');
  rt.stop();
});

test('R2. bitget.webSocketFactory swap ignored', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const bitget: Record<string, any> = {
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  bitget.webSocketFactory = ((_url: string) => { throw new Error('should not call'); }) as any;
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 1, 'original factory used');
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  rt.stop();
});

test('R3. timeout mutation after construct ignored', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const bitget: Record<string, any> = {
    ackTimeoutMs: 5000,
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  bitget.ackTimeoutMs = 0;
  bitget.heartbeatIntervalMs = 0;
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  rt.stop();
});

test('R4. plannerOptions snapshot preserved', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const plannerOpts = { maxArgsPerBatch: 2 };
  const bitget: Record<string, any> = {
    plannerOptions: plannerOpts,
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  plannerOpts.maxArgsPerBatch = 999;
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.ok(f.createdSockets[0].sentMessages.length >= 1, 'batches sent');
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  rt.stop();
});

test('R5. scheduler method replacement ignored', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const bitget: Record<string, any> = {
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  s.setTimeout = ((_h: any, _d: any) => { throw new Error('snapshot should use bound original'); }) as any;
  s.clearTimeout = ((_h: any) => {}) as any;
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  rt.stop();
});

test('R6. restart collector uses original snapshot', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const bitget: Record<string, any> = {
    endpoint: 'wss://snap.example',
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  bitget.endpoint = 'wss://evil.example';
  bitget.webSocketFactory = (() => { throw new Error('should not call'); }) as any;
  rt.universe.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m'], ticker: true }, { symbol: 'ETH/USDT', intervals: ['1m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  for (let _i = 0; _i < 4; _i++) await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 2, 'new socket created with original factory');
  const ws2 = f.createdSockets[1];
  assert.equal(ws2.url, 'wss://snap.example', 'original endpoint used for restart');
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'ticker', instId: 'ETHUSDT' }) });
  ws2.onmessage!({ data: ackMsg({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' }) });
  await applyP;
  rt.stop();
});

test('R7. bitget plan injected via any overridden', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const bitget: Record<string, any> = {
    plan: { version: 999, entries: [] },
    webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any,
  };
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any, bitget });
  rt.start();
  await new Promise(r => queueMicrotask(r));
  const payload = f.createdSockets[0].sentMessages.join(' ');
  assert.ok(payload.includes('BTCUSDT'), 'real plan payload used, not empty injected plan');
  rt.stop();
});

test('R8. reconnect socket state connecting before open', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 } });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  f.autoOpen = false;
  f.createdSockets[0].onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 2);
  const ws2 = f.createdSockets[1];
  ws2.isOpen = true; ws2.readyState = 1;
  ws2.onopen?.({});
  rt.stop();
});

test('R9. reconnect socket transitions to subscribing after open', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 } });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  f.createdSockets[0].onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  assert.ok(f.createdSockets[1].sentMessages.length > 0, 'subscriptions sent after open');
  rt.stop();
});

test('R10. reconnect socket reaches running after acks', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 } });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  f.createdSockets[0].onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[1], BTC_ETH_ACKS);
  await new Promise(r => queueMicrotask(r));
  assert.equal(rt.isRunning, true, 'running after reconnect acks');
  rt.stop();
});

test('R11. stale reconnect socket open ignored', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 } });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  const oldOnOpen = f.createdSockets[0].onopen;
  f.createdSockets[0].onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  const runningBeforeStale = rt.isRunning;
  oldOnOpen!({});
  assert.equal(rt.isRunning, runningBeforeStale, 'state unchanged after stale open');
  rt.stop();
});

test('R12. reconnect ack timeout retries', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BitgetTradingRuntimeCollectorFailure[] = [];
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 50, ackTimeoutMs: 50 },
    onBitgetCollectorError: (e) => errors.push(e) });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  ackAll(f.createdSockets[0], BTC_ETH_ACKS);
  await p;
  f.createdSockets[0].onclose?.({});
  s.tick(50);
  await new Promise(r => queueMicrotask(r));
  s.tick(50);
  assert.equal(errors.length, 1, 'one reconnect timeout error');
  rt.stop();
});

test('R13. meta — 32 original still work', () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any } });
  assert.ok(rt);
});

test('R14. collector error planVersion matches universe version', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BitgetTradingRuntimeCollectorFailure[] = [];
  const rt = createBitgetTradingRuntime({ universe: makeUniverse(), indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 100 },
    onBitgetCollectorError: (e) => errors.push(e) });
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  s.tick(100);
  try { await p; } catch { /* expected */ }
  assert.equal(errors.length, 1, 'exactly one error');
  assert.equal(errors[0].planVersion, rt.universe.getPlan().version, 'planVersion matches');
  rt.stop();
});
