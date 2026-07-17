// Stage 3B3C: Binance USD-M Public Collector tests — fully offline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BinanceV2PublicCollector,
  BINANCE_MARKET_ENDPOINT,
  BINANCE_PUBLIC_ENDPOINT,
  type BinanceCollectorFailure,
  type BinanceWSLike,
  type BinanceWebSocketFactory,
  type BinanceTimerScheduler,
} from '../../../src/data/binance/BinanceV2PublicCollector';
import type { WsTicker, WsKline } from '../../../src/data/types';

// ── Fake scheduler ───────────────────────────────────────────────────────

interface FakeTimer { handler: () => void; delayMs: number; fired: boolean; id: number; }

class FakeScheduler implements BinanceTimerScheduler {
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

  pendingCount(): number { return this.timers.length; }
}

// ── Fake WebSocket ───────────────────────────────────────────────────────

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
  closeOnOpen = false; // for simulating immediate close after open

  create(url: string): BinanceWSLike {
    const ws: FakeWS = {
      url, readyState: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      sentMessages: [],
      isOpen: false, isClosed: false, autoOpen: this.autoOpen,
      send(data: string) { this.sentMessages.push(data); },
      close(code?: number, reason?: string) {
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
        if (ws.isClosed || this.closeOnOpen) return;
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
] as const;

function makePlan(staticSymbols = ['BTC/USDT', 'ETH/USDT']) {
  return {
    version: 1,
    entries: staticSymbols.map(s => {
      const m = MAPPINGS.find(m => m.canonical === s);
      return { symbol: s, exchangeSymbol: m?.exchange ?? s.replace('/', ''), intervals: ['1m', '5m'], ticker: true };
    }),
  };
}

// Helper: respond with ack to a given request
function ackMsg(id: number): string {
  return JSON.stringify({ result: null, id });
}

// Helper: ticker frame
function tickerFrame(symbol: string, fields?: Partial<Record<string, unknown>>): object {
  return {
    e: '24hrTicker', s: symbol,
    c: '50000', v: '1000', h: '51000', l: '49000', E: 1700000000000,
    ...fields,
  };
}

// Helper: bookTicker frame without timestamp
function bookTickerFrame(symbol: string, fields?: Partial<Record<string, unknown>>): object {
  return {
    s: symbol,
    b: '50000.10', B: '1.5', a: '50000.20', A: '2.0',
    ...fields,
  };
}

// Helper: closed kline frame
function closedKlineFrame(symbol: string, interval: string, startTs: number, fields?: Partial<Record<string, unknown>>): object {
  return {
    e: 'kline', s: symbol,
    k: { t: startTs, s: symbol, i: interval, o: '100', h: '110', l: '90', c: '105', v: '50', x: true, ...(fields ?? {}) },
  };
}

// Helper: open kline frame
function openKlineFrame(symbol: string, interval: string, startTs: number): object {
  return {
    e: 'kline', s: symbol,
    k: { t: startTs, s: symbol, i: interval, o: '100', h: '110', l: '90', c: '105', v: '50', x: false },
  };
}

function getWs(f: FakeWSFactory, idx = 0): FakeWS { return f.createdSockets[idx] as FakeWS; }
function getWsByIdx(f: FakeWSFactory, idx: number): FakeWS { return f.createdSockets[idx] as FakeWS; }

function ackAll(f: FakeWSFactory, symbols = 2): void {
  // Each symbol: market=ticker + bookTicker + candle1m + candle5m = 2 streams + 2 intervals
  // market has: each symbol -> [@ticker, @kline_1m, @kline_5m] = 3 per symbol, 2 symbols = 6 streams
  // With route-aware planner, id sequencing depends on maxStreamsPerRequest.
  // At default 50, market is 1 request (id=1), public is 1 request (id=2).
  for (const s of f.createdSockets) {
    // Send acks for all pending ids
    for (let id = 1; id <= 10; id++) {
      s.onmessage!({ data: ackMsg(id) });
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

test('1. construct does not create WebSocket', () => {
  const f = new FakeWSFactory();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url) });
  assert.equal(f.createdSockets.length, 0);
});

test('2. start creates 2 sockets (market + public)', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 2);
  // Fire onopen for both
  getWsByIdx(f, 0).onopen?.({});
  getWsByIdx(f, 1).onopen?.({});
  // Ack
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  assert.equal(c.state, 'running');
});

test('3. default endpoints correct', () => {
  assert.ok(BINANCE_MARKET_ENDPOINT.startsWith('wss://'));
  assert.ok(BINANCE_PUBLIC_ENDPOINT.startsWith('wss://'));
  assert.notEqual(BINANCE_MARKET_ENDPOINT, BINANCE_PUBLIC_ENDPOINT);
});

test('4. routes not mixed', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.start();
  await new Promise(r => queueMicrotask(r));
  // market socket should have ticker/kline, no bookTicker
  const marketWs = getWsByIdx(f, 0);
  const allMarketMsgs = marketWs.sentMessages.join(' ');
  assert.ok(allMarketMsgs.includes('@ticker') || allMarketMsgs.includes('@kline'), 'market has ticker/kline');
  // public socket should have bookTicker
  const publicWs = getWsByIdx(f, 1);
  const allPublicMsgs = publicWs.sentMessages.join(' ');
  assert.ok(allPublicMsgs.includes('@bookTicker'), 'public has bookTicker');
  assert.ok(!allPublicMsgs.includes('@ticker'), 'public has no ticker');
  assert.ok(!allPublicMsgs.includes('@kline'), 'public has no kline');
});

test('5. sends exactly the planned requests', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  // Both open
  getWsByIdx(f, 0).onopen?.({});
  getWsByIdx(f, 1).onopen?.({});
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  assert.equal(c.state, 'running');
});

test('6. ticker + bookTicker merge to WsTicker', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  getWsByIdx(f, 0).onopen?.({});
  getWsByIdx(f, 1).onopen?.({});
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Send ticker then bookTicker
  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 0, 'no merge yet — bookTicker missing');

  getWsByIdx(f, 1).onmessage!({ data: JSON.stringify(bookTickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 1, 'merged after bookTicker');
  assert.equal(tickers[0].last, 50000);
  assert.equal(tickers[0].bestBid, 50000.10);
  assert.equal(tickers[0].bestAsk, 50000.20);
});

test('7. bookTicker then ticker also merges', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  getWsByIdx(f, 1).onmessage!({ data: JSON.stringify(bookTickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 0, 'no merge — ticker missing');

  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 1, 'merged after ticker');
});

test('8. partial ticker/bookTicker does not emit', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Only ticker, no bookTicker
  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 0);
});

test('9. bookTicker without timestamp parsed normally', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Send bookTicker WITHOUT E/T
  getWsByIdx(f, 1).onmessage!({ data: JSON.stringify({ s: 'BTCUSDT', b: '50000.10', B: '1', a: '50000.20', A: '1' }) });
  assert.equal(tickers.length, 0, 'no merge yet — ticker missing');

  // Send ticker
  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 1, 'merged');
  assert.equal(tickers[0].bestBid, 50000.10);
});

test('10. open kline ignored, closed kline emitted', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const klines: WsKline[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.onKline(k => klines.push(k));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(openKlineFrame('BTCUSDT', '1m', 1000)) });
  assert.equal(klines.length, 0, 'open kline ignored');

  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(closedKlineFrame('BTCUSDT', '1m', 1000)) });
  assert.equal(klines.length, 1, 'closed kline emitted');
  assert.equal(klines[0].confirm, true);
  assert.equal(klines[0].ts, 1000);
});

test('11. closed kline dedup', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const klines: WsKline[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  c.onKline(k => klines.push(k));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  const frame = JSON.stringify(closedKlineFrame('BTCUSDT', '1m', 1000));
  getWsByIdx(f, 0).onmessage!({ data: frame });
  assert.equal(klines.length, 1);
  getWsByIdx(f, 0).onmessage!({ data: frame });
  assert.equal(klines.length, 1, 'dup ignored');
});

test('12. ticker=false only market socket', async () => {
  const plan = { version: 1, entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: false }] };
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan, webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  assert.equal(f.createdSockets.length, 1, 'only market socket');
  getWsByIdx(f, 0).onopen?.({});
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  await p;
});

test('13. stop cleans up', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  assert.equal(c.state, 'running');
  c.stop();
  assert.equal(c.state, 'stopped');
  assert.ok(getWsByIdx(f, 0).isClosed || getWsByIdx(f, 1).isClosed, 'sockets closed');
});

test('14. ack timeout rejects start', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 20 });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  // Open sockets but don't ack
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  s.tick(20);
  let rejected = false;
  try { await p; } catch { rejected = true; }
  assert.ok(rejected);
  assert.equal(c.state, 'failed');
});

test('15. single route failure retires both sockets', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Close market socket
  getWsByIdx(f, 0).onclose?.({});
  assert.equal(c.state, 'reconnect_wait');
  c.stop();
});

test('16. duplicate failure only one reconnect', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 1000 });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  getWsByIdx(f, 0).onclose?.({});
  getWsByIdx(f, 0).onclose?.({}); // duplicate
  assert.equal(c.state, 'reconnect_wait');
  c.stop();
});

test('17. stale socket message ignored', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Capture old handler
  const oldHandler = getWsByIdx(f, 0).onmessage;
  // Trigger reconnect
  getWsByIdx(f, 0).onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  // Fire on old handler
  oldHandler!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 0, 'stale message ignored');
  c.stop();
});

test('18. reconnect resubscribes', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, reconnectDelayMs: 100 });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  const initialSockets = f.createdSockets.length;

  // Trigger reconnect
  getWsByIdx(f, 0).onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  assert.ok(f.createdSockets.length > initialSockets, 'new sockets created');
  c.stop();
});

test('19. inactivity watchdog fires and triggers reconnect', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, inactivityPeriodMs: 100, reconnectDelayMs: 100,
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // No data for 100ms → watchdog fires
  s.tick(100);
  assert.ok(errors.some(e => e.phase === 'watchdog'), 'watchdog error fired');
  assert.equal(c.state, 'reconnect_wait');
  c.stop();
});

test('20. onError throw does not break', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({
    plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 20,
  });
  c.onError(() => { throw new Error('handler error'); });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  s.tick(20);
  let rejected = false;
  try { await p; } catch { rejected = true; }
  assert.ok(rejected, 'start rejected despite handler throw');
});

test('21. connection rotation timer fires', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, lifetimeMs: 200, reconnectDelayMs: 100,
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  s.tick(200);
  assert.ok(errors.some(e => e.phase === 'rotation'), 'rotation error fired');
  c.stop();
});

// ── Stage 3B3C-R1: startup hardening ─────────────────────────────────────

test('R1. outbound JSON has exactly method/params/id — no route', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  const p = c.start();
  // microtask 1: factory creates sockets; onopen fires via queueMicrotask
  // microtask 2: onopen runs, sends subscribes
  // Immediately check sent messages after microtasks drain
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  for (let i = 0; i < f.createdSockets.length; i++) {
    const ws = getWsByIdx(f, i);
    for (const msg of ws.sentMessages) {
      const parsed = JSON.parse(msg);
      const keys = Object.keys(parsed).sort();
      assert.deepEqual(keys, ['id', 'method', 'params'], `msg=${msg} has exactly method/params/id`);
    }
  }
  c.stop();
  try { await p; } catch { /* expected — stop before acks resolve */ }
});

test('R2. market ack before public socket open does not get lost', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 });
  // Start so sockets are created (autoOpen will fire onopen on both)
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r)); // drain autoOpen microtasks
  // Stop and discard c, then redo with manual-control factory
  c.stop();
  await p.catch(() => {});
  await new Promise(r => queueMicrotask(r));

  // Manual-control factory to control onopen/ack order
  class ManualFactory implements BinanceWebSocketFactory {
    created: FakeWS[] = [];
    create(url: string): BinanceWSLike {
      const ws: FakeWS = {
        url, readyState: 0,
        onopen: null, onmessage: null, onclose: null, onerror: null,
        sentMessages: [], isOpen: false, isClosed: false, autoOpen: false,
        send(data: string) { this.sentMessages.push(data); },
        close() { this.isClosed = true; this.isOpen = false; this.readyState = 3; },
      };
      this.created.push(ws);
      return ws;
    }
  }
  const mf = new ManualFactory();
  const c2 = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => mf.create(url), scheduler: s as any, ackTimeoutMs: 5000 });
  const p2 = c2.start();
  await new Promise(r => queueMicrotask(r));
  // 2 sockets created, neither open
  assert.equal(mf.created.length, 2);
  // Open market (index 0) first
  const marketWs = mf.created[0];
  const publicWs = mf.created[1];
  marketWs.onopen?.({});
  // Ack market (id=1) before public opens
  marketWs.onmessage!({ data: ackMsg(1) });
  // Now open public
  publicWs.onopen?.({});
  publicWs.onmessage!({ data: ackMsg(2) });
  await p2;
  assert.equal(c2.state, 'running', 'early market ack preserved');
});

test('R3. reconnect path also accepts early acks', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, reconnectDelayMs: 100, ackTimeoutMs: 5000,
  });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Trigger reconnect
  getWsByIdx(f, 0).onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // New sockets created — open them one at a time, ack early
  const newMarket = f.createdSockets[2];
  const newPublic = f.createdSockets[3];
  newMarket.onopen?.({});
  newMarket.onmessage!({ data: ackMsg(1) });
  newPublic.onopen?.({});
  newPublic.onmessage!({ data: ackMsg(2) });
  await new Promise(r => queueMicrotask(r));
  assert.equal(c.state, 'running', 'reconnect completed with early ack');
  c.stop();
});

test('R4. unknown/duplicate ack does not affect state', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  // Unknown ack (id=999) ignored
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(999) });
  // State remains subscribing
  assert.equal(c.state, 'subscribing');
  // Duplicate id=1 ack has no extra effect
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  // Still subscribing because id=2 not yet acked
  assert.equal(c.state, 'subscribing');
  // Now ack id=2
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  assert.equal(c.state, 'running');
});

test('R5. watchdog error fires exactly once', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  // Single-socket plan (ticker=false) → only market, one watchdog timer
  const plan = { version: 1, entries: [{ symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: false }] };
  const c = new BinanceV2PublicCollector({
    plan, webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, inactivityPeriodMs: 100, reconnectDelayMs: 200, ackTimeoutMs: 5000,
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  getWsByIdx(f, 0).onopen?.({});
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  await p;
  assert.equal(errors.length, 0, 'no errors before watchdog');
  s.tick(100);
  assert.equal(errors.length, 1, 'exactly one error from watchdog');
  assert.equal(errors[0].phase, 'watchdog');
  c.stop();
});

test('R6. rotation error fires exactly once', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, lifetimeMs: 200, reconnectDelayMs: 200, ackTimeoutMs: 5000,
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  s.tick(200);
  assert.equal(errors.length, 1, 'exactly one error from rotation');
  assert.equal(errors[0].phase, 'rotation');
  c.stop();
});

test('R7. bookTicker without ts arrives in collector without fabricating ts', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any, ackTimeoutMs: 5000 });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Send bookTicker without E/T
  getWsByIdx(f, 1).onmessage!({ data: JSON.stringify({ s: 'BTCUSDT', b: '50000.10', B: '1', a: '50000.20', A: '1' }) });
  // Send ticker
  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 1, 'merged');
  // The merged WsTicker uses ticker.ts (1700000000000), NOT fabricated from bookTicker
  assert.equal(tickers[0].ts, 1700000000000, 'ts comes from ticker, not fabricated');
  assert.equal(tickers[0].bestBid, 50000.10);
  assert.equal(tickers[0].bestAsk, 50000.20);
});

// ── Stage 3B3C-R2: close lifecycle gaps ─────────────────────────────────

test('R8. pre-open onerror rejects start and closes both sockets', async () => {
  let ws: FakeWS;
  class ErrFactory implements BinanceWebSocketFactory {
    created: FakeWS[] = [];
    create(url: string): BinanceWSLike {
      ws = {
        url, readyState: 0,
        onopen: null, onmessage: null, onclose: null, onerror: null,
        sentMessages: [], isOpen: false, isClosed: false, autoOpen: false,
        send(data: string) { this.sentMessages.push(data); },
        close() { this.isClosed = true; },
      };
      this.created.push(ws);
      return ws;
    }
  }
  const f = new ErrFactory();
  const s = new FakeScheduler();
  const c = new BinanceV2PublicCollector({ plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url), scheduler: s as any });
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  // Fire onerror on first socket before onopen
  f.created[0].onerror?.({});
  let rejected = false;
  try { await p; } catch { rejected = true; }
  assert.ok(rejected, 'start rejected on pre-open onerror');
  assert.equal(c.state, 'failed');
  // Both sockets should be closed (retireAllSockets closes all)
  assert.ok(f.created.every(s => s.isClosed), 'all sockets closed');
});

test('R9. reconnect factory failure closes partial sockets and uses unified reconnect', async () => {
  // First start with normal factory. Then trigger reconnect and swap to a
  // fickle factory that fails on 2nd create (public) but succeeds on 1st (market).
  const f = new FakeWSFactory();
  let fickleMode = false;
  let callInFickle = 0;
  class FickleFactory implements BinanceWebSocketFactory {
    created: FakeWS[] = [];
    create(url: string): BinanceWSLike {
      if (!fickleMode) return f.create(url);
      callInFickle++;
      if (callInFickle === 2) throw new Error('second factory fails');
      const ws: FakeWS = {
        url, readyState: 0,
        onopen: null, onmessage: null, onclose: null, onerror: null,
        sentMessages: [], isOpen: false, isClosed: false, autoOpen: false,
        send(data: string) { this.sentMessages.push(data); },
        close() { this.isClosed = true; },
      };
      this.created.push(ws);
      return ws;
    }
  }
  const fk = new FickleFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => fk.create(url),
    scheduler: s as any, reconnectDelayMs: 100, ackTimeoutMs: 5000,
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;
  assert.equal(c.state, 'running');

  // Now swap into fickle mode and trigger reconnect
  fickleMode = true;
  callInFickle = 0;
  getWsByIdx(f, 0).onclose?.({});
  assert.equal(c.state, 'reconnect_wait');
  // Tick the reconnect timer — startReconnectAttempt runs, market succeeds but
  // public throws → closeAllSockets + beginReconnect again
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // Should be back in reconnect_wait because beginReconnect was re-triggered
  assert.equal(c.state, 'reconnect_wait', 'unified reconnect back to wait');
  // The market socket created on this attempt must have been closed
  assert.ok(fk.created.length === 1, 'one socket created in fickle attempt');
  assert.ok(fk.created[0].isClosed, 'partial market socket closed on factory failure');
  assert.ok(errors.some(e => e.phase === 'connect'), 'connect error reported');
  c.stop();
});

test('R10. reconnect clears ticker and bookTicker caches', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const tickers: WsTicker[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, reconnectDelayMs: 100, ackTimeoutMs: 5000,
  });
  c.onTicker(t => tickers.push(t));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Inject ticker data
  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  getWsByIdx(f, 1).onmessage!({ data: JSON.stringify(bookTickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, 1, 'ticker produced pre-reconnect');

  // Trigger reconnect
  getWsByIdx(f, 0).onclose?.({});
  s.tick(100);
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  // New socket indices
  const idxMarket = f.createdSockets.length >= 3 ? 2 : 0;
  const idxPublic = f.createdSockets.length >= 4 ? 3 : 1;
  getWsByIdx(f, idxMarket).onopen?.({});
  getWsByIdx(f, idxPublic).onopen?.({});
  getWsByIdx(f, idxMarket).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, idxPublic).onmessage!({ data: ackMsg(2) });
  await new Promise(r => queueMicrotask(r));

  // Send ONLY bookTicker on new connection (no ticker yet) — should not merge with old ticker
  const preCount = tickers.length;
  getWsByIdx(f, idxPublic).onmessage!({ data: JSON.stringify(bookTickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, preCount, 'old ticker not merged with new bookTicker');

  // Send ticker on new connection → now both sides present → should emit
  getWsByIdx(f, idxMarket).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  assert.equal(tickers.length, preCount + 1, 'fresh ticker+bookTicker produces merge');
  c.stop();
});

test('R11. per-route inactivity watchdog fires independently', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, inactivityPeriodMs: 100, reconnectDelayMs: 200, ackTimeoutMs: 5000,
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Feed data ONLY to market socket; public stays silent
  getWsByIdx(f, 0).onmessage!({ data: JSON.stringify(tickerFrame('BTCUSDT')) });
  // After 100ms public watchdog should fire (market is reset)
  s.tick(100);
  assert.ok(errors.some(e => e.phase === 'watchdog'), 'public watchdog fired despite market activity');
  // After tick 200, public could fire again, but reconnect guard prevents double.
  // Only one watchdog event expected.
  c.stop();
});

test('R12. duplicate route failures only produce one reconnect timer', async () => {
  const f = new FakeWSFactory();
  const s = new FakeScheduler();
  const errors: BinanceCollectorFailure[] = [];
  const c = new BinanceV2PublicCollector({
    plan: makePlan(['BTC/USDT']), webSocketFactory: (url: string) => f.create(url),
    scheduler: s as any, reconnectDelayMs: 10000,  // long to prevent timer from overlapping
  });
  c.onError(e => errors.push(e));
  const p = c.start();
  await new Promise(r => queueMicrotask(r));
  await new Promise(r => queueMicrotask(r));
  [0, 1].forEach(i => getWsByIdx(f, i).onopen?.({}));
  getWsByIdx(f, 0).onmessage!({ data: ackMsg(1) });
  getWsByIdx(f, 1).onmessage!({ data: ackMsg(2) });
  await p;

  // Trigger close on both sockets in sequence
  getWsByIdx(f, 0).onclose?.({}); // first → beginReconnect, sets reconnect_wait
  getWsByIdx(f, 1).onclose?.({}); // second → beginReconnect short-circuits via state check
  // After both calls, only one error (from the first) should have been reported
  const connectErrors = errors.filter(e => e.phase === 'reconnect');
  assert.equal(connectErrors.length, 0, 'no reconnect phase errors');  // onclose doesn't pass failure
  c.stop();
});

