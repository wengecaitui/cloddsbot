// Stage 3B4B-R1: ExchangeTradingRuntime selector tests (hardened)
//
// Uses exact proven pattern from bitget-trading-runtime.test.ts:
// - FakeWSFactory with autoOpen
// - Manually ack each expected subscription
// - Assert isRunning after start
// - Assert socket counts for construction/restart
// - No .catch(() => {})

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExchangeTradingRuntime,
  type ExchangeTradingRuntimeOptions,
} from '../../../src/runtime/trading/ExchangeTradingRuntime';
import {
  createBitgetTradingRuntime,
} from '../../../src/runtime/trading/BitgetTradingRuntime';
import {
  createBinanceTradingRuntime,
} from '../../../src/runtime/trading/BinanceTradingRuntime';
import { createUniverseManager } from '../../../src/runtime/market/UniverseManager';
import { createSymbolRegistry } from '../../../src/runtime/market/SymbolFormat';

// ── Fake timer ───────────────────────────────────────────────────────────

interface FT { handler: () => void; delayMs: number; id: number; }

class FakeScheduler {
  private timers: FT[] = [];
  private nextId = 1;
  setTimeout(handler: () => void, delayMs: number): unknown {
    const t: FT = { handler, delayMs, id: this.nextId++ };
    this.timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown): void {
    if (handle == null) return;
    const id = handle as number;
    const idx = this.timers.findIndex(t => t.id === id);
    if (idx >= 0) this.timers.splice(idx, 1);
  }
}

// ── Generic FakeWS / FakeWSFactory ──────────────────────────────────────

interface FakeWS {
  url: string;
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  sentMessages: string[];
  isOpen: boolean;
  isClosed: boolean;
}

class FakeWSFactory {
  createdSockets: FakeWS[] = [];
  autoOpen = true;

  create(url: string): FakeWS {
    const ws: FakeWS = {
      url, readyState: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      sentMessages: [],
      isOpen: false, isClosed: false,
      send(data: string) { this.sentMessages.push(data); },
      close() {
        if (this.isClosed) return;
        this.isClosed = true;
        this.isOpen = false;
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

// ── Helpers ────────────────────────────────────────────────────────────────

const BITGET_MAP = [{ canonical: 'BTC/USDT', exchange: 'BTCUSDT', alias: ['BTCUSDT'] }] as const;
const BINANCE_MAP = [{ canonical: 'BTC/USDT', exchange: 'BTCUSDT', alias: [] }] as const;

function makeUniverse(mappings: typeof BITGET_MAP) {
  return createUniverseManager({
    registry: createSymbolRegistry(mappings),
    allowedSymbols: ['BTC/USDT'],
    staticSymbols: ['BTC/USDT'],
    maxSymbols: 3,
    allowedIntervals: ['1m', '5m'],
    defaultIntervals: ['1m'],
  });
}

class FakeIS {
  async calculateAll() { return []; }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('1. Bitget selector — no socket at construction', () => {
  const f = new FakeWSFactory();
  const rt = createExchangeTradingRuntime({
    exchange: 'bitget',
    runtime: { universe: makeUniverse(BITGET_MAP), indicatorService: new FakeIS() as any },
    provider: { bitget: { webSocketFactory: (url: string) => f.create(url) } as any },
  } as any);
  assert.equal(f.createdSockets.length, 0, 'no socket');
});

test('2. Bitget selector — start completes with isRunning === true', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createExchangeTradingRuntime({
    exchange: 'bitget',
    runtime: { universe: makeUniverse(BITGET_MAP), indicatorService: new FakeIS() as any },
    provider: {
      bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any } as any,
      onBitgetCollectorError: () => {},
    },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 1, 'one socket');

  const ws = f.createdSockets[0];
  // Manually ack each expected subscription (Bitget V2 protocol)
  ws.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' } }) });
  ws.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' } }) });

  await p;
  assert.equal(rt.isRunning, true);
});

test('3. Bitget selector — universe restart closes old socket, creates new', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const u = makeUniverse(BITGET_MAP);
  const rt = createExchangeTradingRuntime({
    exchange: 'bitget',
    runtime: { universe: u, indicatorService: new FakeIS() as any },
    provider: {
      bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any } as any,
      onBitgetCollectorError: () => {},
    },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 1);
  const firstSocket = f.createdSockets[0];
  // Ack initial subscribes
  firstSocket.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' } }) });
  firstSocket.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' } }) });
  await p;
  assert.equal(rt.isRunning, true);

  // Restart with new plan
  u.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m', '5m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  await new Promise(r => queueMicrotask(r));
  assert.ok(firstSocket.isClosed, 'old socket closed');
  assert.equal(f.createdSockets.length, 2, 'new socket created');

  const newWs = f.createdSockets[1];
  newWs.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' } }) });
  newWs.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' } }) });
  newWs.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'candle5m', instId: 'BTCUSDT' } }) });

  const result = await applyP;
  assert.ok(result.restarted, 'restarted');
  assert.equal(rt.isRunning, true, 'still running');
});

// ── Binance selector ─────────────────────────────────────────────────────

test('4. Binance selector — no socket at construction', () => {
  const f = new FakeWSFactory();
  const rt = createExchangeTradingRuntime({
    exchange: 'binance',
    runtime: { universe: makeUniverse(BINANCE_MAP), indicatorService: new FakeIS() as any },
    provider: { binance: { webSocketFactory: (url: string) => f.create(url) } as any },
  } as any);
  assert.equal(f.createdSockets.length, 0, 'no socket');
});

test('5. Binance selector — start completes with isRunning === true', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createExchangeTradingRuntime({
    exchange: 'binance',
    runtime: { universe: makeUniverse(BINANCE_MAP), indicatorService: new FakeIS() as any },
    provider: {
      binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 } as any,
      onBinanceCollectorError: () => {},
    },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  // Binance creates 2 sockets (market + public)
  assert.equal(f.createdSockets.length, 2);
  // Both auto-open → send subscribes. Ack each by id (SUBSCRIBE protocol).
  for (const ws of f.createdSockets) {
    for (const msg of ws.sentMessages) {
      const parsed = JSON.parse(msg);
      if (parsed.method === 'SUBSCRIBE' && typeof parsed.id === 'number') {
        ws.onmessage!({ data: JSON.stringify({ result: null, id: parsed.id }) });
      }
    }
  }
  await p;
  assert.equal(rt.isRunning, true);
});

test('6. Binance selector — universe restart closes old, creates new', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const u = makeUniverse(BINANCE_MAP);
  const rt = createExchangeTradingRuntime({
    exchange: 'binance',
    runtime: { universe: u, indicatorService: new FakeIS() as any },
    provider: {
      binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 } as any,
      onBinanceCollectorError: () => {},
    },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 2);
  for (const ws of f.createdSockets) {
    for (const msg of ws.sentMessages) {
      const parsed = JSON.parse(msg);
      if (parsed.method === 'SUBSCRIBE' && typeof parsed.id === 'number') {
        ws.onmessage!({ data: JSON.stringify({ result: null, id: parsed.id }) });
      }
    }
  }
  await p;
  assert.equal(rt.isRunning, true);

  const oldSockets = [...f.createdSockets];

  u.setPlan({ entries: [{ symbol: 'BTC/USDT', intervals: ['1m', '5m'], ticker: true }] });
  const applyP = rt.applyUniversePlan();
  await new Promise(r => queueMicrotask(r));
  // Old sockets closed
  for (const os of oldSockets) {
    assert.ok(os.isClosed, 'old socket closed');
  }
  // New sockets created
  assert.ok(f.createdSockets.length >= 4, 'new sockets created');

  // Ack new sockets
  for (let i = oldSockets.length; i < f.createdSockets.length; i++) {
    const ws = f.createdSockets[i];
    for (const msg of ws.sentMessages) {
      const parsed = JSON.parse(msg);
      if (parsed.method === 'SUBSCRIBE' && typeof parsed.id === 'number') {
        ws.onmessage!({ data: JSON.stringify({ result: null, id: parsed.id }) });
      }
    }
  }

  const result = await applyP;
  assert.ok(result.restarted, 'restarted');
  assert.equal(rt.isRunning, true);
});

// ── Error paths ──────────────────────────────────────────────────────────

test('7. illegal exchange throws synchronously', () => {
  assert.throws(
    () => createExchangeTradingRuntime({ exchange: 'coinbase' } as any),
    /unsupported exchange/i,
  );
});

// ── Stop ─────────────────────────────────────────────────────────────────

test('8. Bitget selector — stop sets isRunning false, closes sockets', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createExchangeTradingRuntime({
    exchange: 'bitget',
    runtime: { universe: makeUniverse(BITGET_MAP), indicatorService: new FakeIS() as any },
    provider: {
      bitget: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any } as any,
      onBitgetCollectorError: () => {},
    },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  const ws = f.createdSockets[0];
  ws.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' } }) });
  ws.onmessage!({ data: JSON.stringify({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' } }) });
  await p;
  assert.equal(rt.isRunning, true);

  rt.stop();
  assert.equal(rt.isRunning, false);
  assert.ok(ws.isClosed, 'socket closed');
});

test('9. Binance selector — stop sets isRunning false, closes sockets', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const rt = createExchangeTradingRuntime({
    exchange: 'binance',
    runtime: { universe: makeUniverse(BINANCE_MAP), indicatorService: new FakeIS() as any },
    provider: {
      binance: { webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 } as any,
      onBinanceCollectorError: () => {},
    },
  } as any);
  const p = rt.start();
  await new Promise(r => queueMicrotask(r));
  for (const ws of f.createdSockets) {
    for (const msg of ws.sentMessages) {
      const parsed = JSON.parse(msg);
      if (parsed.method === 'SUBSCRIBE' && typeof parsed.id === 'number') {
        ws.onmessage!({ data: JSON.stringify({ result: null, id: parsed.id }) });
      }
    }
  }
  await p;
  assert.equal(rt.isRunning, true);

  const socks = [...f.createdSockets];
  rt.stop();
  assert.equal(rt.isRunning, false);
  for (const s of socks) {
    assert.ok(s.isClosed, 'socket closed');
  }
});

// ── Existing per-exchange wrappers still work ────────────────────────────

test('10. createBitgetTradingRuntime still works', () => {
  const f = new FakeWSFactory();
  const rt = createBitgetTradingRuntime({
    universe: makeUniverse(BITGET_MAP),
    indicatorService: new FakeIS() as any,
    bitget: { webSocketFactory: (url: string) => f.create(url) } as any,
  } as any);
  assert.ok(rt);
  assert.equal(typeof rt.start, 'function');
  assert.equal(typeof rt.stop, 'function');
  assert.equal(f.createdSockets.length, 0, 'no socket');
});

test('11. createBinanceTradingRuntime still works', () => {
  const f = new FakeWSFactory();
  const rt = createBinanceTradingRuntime({
    universe: makeUniverse(BINANCE_MAP),
    indicatorService: new FakeIS() as any,
    binance: { webSocketFactory: (url: string) => f.create(url) } as any,
  } as any);
  assert.ok(rt);
  assert.equal(typeof rt.start, 'function');
  assert.equal(f.createdSockets.length, 0, 'no socket');
});

// ── Provider options optional ────────────────────────────────────────────

test('12. provider options are optional (bitget)', () => {
  const rt = createExchangeTradingRuntime({
    exchange: 'bitget',
    runtime: { universe: makeUniverse(BITGET_MAP), indicatorService: new FakeIS() as any },
  } as any);
  assert.ok(rt);
});

test('13. provider options are optional (binance)', () => {
  const rt = createExchangeTradingRuntime({
    exchange: 'binance',
    runtime: { universe: makeUniverse(BINANCE_MAP), indicatorService: new FakeIS() as any },
  } as any);
  assert.ok(rt);
});

// ── Isolation & type ────────────────────────────────────────────────────

test('14. two selector runtimes are isolated', () => {
  const bg = createExchangeTradingRuntime({
    exchange: 'bitget',
    runtime: { universe: makeUniverse(BITGET_MAP), indicatorService: new FakeIS() as any },
  } as any);
  const bn = createExchangeTradingRuntime({
    exchange: 'binance',
    runtime: { universe: makeUniverse(BINANCE_MAP), indicatorService: new FakeIS() as any },
  } as any);
  assert.notEqual(bg, bn);
  assert.equal(typeof bg.start, 'function');
  assert.equal(typeof bn.start, 'function');
});

test('15. discriminant type: bitget vs binance', () => {
  const opts1: ExchangeTradingRuntimeOptions = {
    exchange: 'bitget',
    runtime: { universe: makeUniverse(BITGET_MAP), indicatorService: new FakeIS() as any },
    provider: { bitget: { ackTimeoutMs: 3000 } as any },
  };
  const opts2: ExchangeTradingRuntimeOptions = {
    exchange: 'binance',
    runtime: { universe: makeUniverse(BINANCE_MAP), indicatorService: new FakeIS() as any },
    provider: { binance: { ackTimeoutMs: 3000 } as any },
  };
  assert.equal(opts1.exchange, 'bitget');
  assert.equal(opts2.exchange, 'binance');
});
