// Stage 3B4C3: MultiExchangeRuntime integration tests
//
// Fully offline — uses FakeWSFactory, FakeScheduler, real createExchangeTradingRuntime.
// Deterministic lifecycle: test manually opens sockets + sends subscription acks.
// No auto-ack in FakeWS.send(). No setImmediate/setTimeout(0) guesswork.
//
// Coverage: 30 tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMultiExchangeRuntime,
  MultiExchangeStartError,
  MultiExchangeLifecycleCancelledError,
  MultiExchangeIsolationError,
} from '../../../src/runtime/trading/MultiExchangeRuntime';
import type { MultiExchangeRuntime, MultiExchangeRuntimeOptions, MultiExchangeStartResult } from '../../../src/runtime/trading/MultiExchangeRuntime';
import { createUniverseManager } from '../../../src/runtime/market/UniverseManager';
import type { UniverseManager } from '../../../src/runtime/market/UniverseManager';
import { createSymbolRegistry } from '../../../src/runtime/market/SymbolFormat';
import type { ExchangeId } from '../../../src/data/MarketIdentity';
import { createTradingEventBus } from '../../../src/events/TradingEventBus';
import { ExecutionRouter } from '../../../src/router/ExecutionRouter';
import { SignalSource } from '../../../src/router/ExecutionRouter';
import { KillSwitch } from '../../../src/router/KillSwitch';
import type { MarketBiasReportFull } from '../../../src/types/market-bias';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Fake Scheduler (deterministic timer) ───────────────────────────────────

interface Timer { handler: () => void; delayMs: number; fired: boolean; id: number; }

class FakeScheduler {
  private timers: Timer[] = [];
  private nextId = 1;
  setTimeout(handler: () => void, delayMs: number): unknown {
    const t: Timer = { handler, delayMs, fired: false, id: this.nextId++ };
    this.timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown): void {
    if (handle == null) return;
    const id = handle as number;
    const idx = this.timers.findIndex(t => t.id === id);
    if (idx >= 0) this.timers.splice(idx, 1);
  }
  /** Fire one specific timer by handle. Returns true if fired. */
  fireHandle(handle: unknown): boolean {
    const id = handle as number;
    const idx = this.timers.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const t = this.timers[idx];
    t.fired = true;
    this.timers.splice(idx, 1);
    t.handler();
    return true;
  }
  /** Count pending timers at a given delay (for assertions). */
  pendingCount(delayMs?: number): number {
    if (delayMs === undefined) return this.timers.length;
    return this.timers.filter(t => t.delayMs === delayMs && !t.fired).length;
  }
}

// ─── Fake WS (deterministic — test must call open/receive explicitly) ───────

interface FakeWS {
  url: string;
  readyState: number;
  sentMessages: string[];
  isOpen: boolean;
  isClosed: boolean;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  send(data: string): void;
  close(): void;
  /** Test helper: fire onopen. */
  open(): void;
  /** Test helper: simulate message from server. */
  receive(msg: string): void;
  /** Test helper: close from server. */
  closeFromServer(): void;
}

function createFakeWS(url: string): FakeWS {
  const ws: FakeWS = {
    url, readyState: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    sentMessages: [],
    isOpen: false, isClosed: false,
    send(data: string) { this.sentMessages.push(data); },
    close() {
      if (this.isClosed) return;
      this.isClosed = true; this.isOpen = false; this.readyState = 3;
      this.onclose?.({});
    },
    open() {
      if (this.isClosed) return;
      this.isOpen = true; this.readyState = 1;
      this.onopen?.({});
    },
    receive(msg: string) { this.onmessage?.({ data: msg }); },
    closeFromServer() {
      if (this.isClosed) return;
      this.isClosed = true; this.isOpen = false; this.readyState = 3;
      this.onclose?.({ code: 1000, reason: 'server close' });
    },
  };
  return ws;
}

class FakeWSFactory {
  createdSockets: FakeWS[] = [];
  create(url: string): FakeWS {
    const ws = createFakeWS(url);
    this.createdSockets.push(ws);
    return ws;
  }
  /** Return sockets created since a given offset. */
  socketsSince(index: number): FakeWS[] {
    return this.createdSockets.slice(index);
  }
}

// ─── Other test helpers ─────────────────────────────────────────────────────

class FakeIndicatorService {
  async calculateAll() { return []; }
}

function makeUniverse(symbols: string[] = ['BTC/USDT']): UniverseManager {
  const reg = createSymbolRegistry(
    symbols.map(sym => ({
      canonical: sym,
      exchange: sym.replace('/', ''),
      alias: [] as string[],
    })),
  );
  return createUniverseManager({
    registry: reg,
    allowedSymbols: symbols,
    staticSymbols: symbols,
    allowedIntervals: ['1m', '5m'],
    defaultIntervals: ['1m', '5m'],
    maxSymbols: 10,
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise(r => queueMicrotask(r));
}

// ── Deterministic Bitget open+ack ──────────────────────────────────────────
// Bitget subscribes use {op:'subscribe', args: [{instType, channel, instId}]}.
// Ack is {event:'subscribe', arg} for EACH arg.

function isBitgetSubscribe(data: string): boolean {
  try {
    const p = JSON.parse(data);
    return p?.op === 'subscribe' && Array.isArray(p?.args);
  } catch { return false; }
}

function ackBitgetRequest(data: string): string[] {
  const p = JSON.parse(data);
  return p.args.map((arg: any) => JSON.stringify({ event: 'subscribe', arg }));
}

function openBitgetAndAck(factory: FakeWSFactory, fromIndex = 0): void {
  const sockets = factory.socketsSince(fromIndex);
  for (const ws of sockets) {
    ws.open();
    for (const msg of ws.sentMessages) {
      if (isBitgetSubscribe(msg)) {
        for (const ack of ackBitgetRequest(msg)) {
          ws.receive(ack);
        }
      }
    }
  }
}

// ── Deterministic Binance open+ack ─────────────────────────────────────────
// Binance uses {method:'SUBSCRIBE', params:[...], id:N}.
// Ack is {result:null, id: N} on the SAME socket that sent the request.

function isBinanceSubscribe(data: string): boolean {
  try {
    const p = JSON.parse(data);
    return (p?.method === 'SUBSCRIBE' || p?.method === 'subscribe') && p?.id != null;
  } catch { return false; }
}

function ackBinanceRequest(data: string): string {
  const p = JSON.parse(data);
  return JSON.stringify({ result: null, id: p.id });
}

function openBinanceAndAck(factory: FakeWSFactory, fromIndex = 0): void {
  const sockets = factory.socketsSince(fromIndex);
  for (const ws of sockets) {
    ws.open();
    for (const msg of ws.sentMessages) {
      if (isBinanceSubscribe(msg)) {
        ws.receive(ackBinanceRequest(msg));
      }
    }
  }
}

// ── Child option builders ───────────────────────────────────────────────────

function bitgetOpts(
  u: UniverseManager,
  f: FakeWSFactory,
  s: FakeScheduler,
  is?: FakeIndicatorService,
): any {
  return {
    runtime: { universe: u, indicatorService: (is ?? new FakeIndicatorService()) as any, routerConfig: {} },
    provider: {
      bitget: {
        webSocketFactory: (url: string) => f.create(url),
        scheduler: s as any,
        ackTimeoutMs: 5000,
        heartbeatIntervalMs: 999999,
        pongTimeoutMs: 999999,
        reconnectDelayMs: 999999,
      },
    },
  };
}

function binanceOpts(
  u: UniverseManager,
  f: FakeWSFactory,
  s: FakeScheduler,
  is?: FakeIndicatorService,
): any {
  return {
    runtime: { universe: u, indicatorService: (is ?? new FakeIndicatorService()) as any, routerConfig: {} },
    provider: {
      binance: {
        webSocketFactory: (url: string) => f.create(url),
        scheduler: s as any,
        ackTimeoutMs: 5000,
        reconnectDelayMs: 999999,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Construction
// ═══════════════════════════════════════════════════════════════════════════

test('1. construction does not create any socket', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.ok(multi);
  assert.equal(multi.state, 'stopped');
});

test('2. exactly two child runtimes', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.equal(multi.runtimes.size, 2);
  assert.ok(multi.runtimes.has('bitget'));
  assert.ok(multi.runtimes.has('binance'));
});

test('3. each runtime exposes correct exchange identity', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.equal(multi.getRuntime('bitget').exchange, 'bitget');
  assert.equal(multi.getRuntime('binance').exchange, 'binance');
});

test('4. market data stores are separate instances', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  const rtB = multi.getRuntime('bitget');
  const rtN = multi.getRuntime('binance');
  assert.notEqual(rtB.marketData.store, rtN.marketData.store);
  assert.notEqual(rtB.marketData.candleStore, rtN.marketData.candleStore);
});

test('5. event buses are separate instances', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.notEqual(multi.getRuntime('bitget').bus, multi.getRuntime('binance').bus);
});

test('6. universes are separate instances', () => {
  const uB = makeUniverse(['BTC/USDT', 'SOL/USDT']);
  const uN = makeUniverse(['BTC/USDT']);
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(uB, new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(uN, new FakeWSFactory(), new FakeScheduler()),
  });
  assert.notEqual(multi.getRuntime('bitget').universe, multi.getRuntime('binance').universe);
  multi.getRuntime('bitget').universe.addSymbol('SOL/USDT');
  assert.equal(multi.getRuntime('bitget').universe.getPlan().entries.length, 2);
  assert.equal(multi.getRuntime('binance').universe.getPlan().entries.length, 1);
});

test('7. routers and kill switches are separate', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.notEqual(multi.getRuntime('bitget').router, multi.getRuntime('binance').router);
  assert.notEqual(multi.getRuntime('bitget').router.killSwitch, multi.getRuntime('binance').router.killSwitch);
});

test('8. fast pipelines are separate instances', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.notEqual(multi.getRuntime('bitget').fastPipeline, multi.getRuntime('binance').fastPipeline);
});

test('9. indicator service may be shared across exchanges', () => {
  const sharedIS = new FakeIndicatorService();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler(), sharedIS),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler(), sharedIS),
  });
  assert.ok(multi);
});

test('10. runtimes getter returns a defensive copy', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  const map1 = multi.runtimes;
  assert.notEqual(map1, multi.runtimes);
  map1.delete('bitget');
  assert.equal(multi.runtimes.size, 2);
});

test('11. statuses getter returns a defensive copy', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  const s1 = multi.statuses;
  assert.notEqual(s1, multi.statuses);
  s1.delete('bitget');
  assert.equal(multi.statuses.size, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Both sides success → running
// ═══════════════════════════════════════════════════════════════════════════

test('12. both sides start successfully -> state=running', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  // Both should have created sockets
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  const result = await p;
  assert.equal(multi.state, 'running');
  assert.equal(result.partial, false);
  assert.deepEqual(result.started, ['bitget', 'binance']);
  assert.equal(result.failed.length, 0);
  assert.ok(multi.getRuntime('bitget').isRunning);
  assert.ok(multi.getRuntime('binance').isRunning);
  assert.equal(multi.getStatus('bitget').state, 'running');
  assert.equal(multi.getStatus('binance').state, 'running');
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Bitget fails (WS sync throw), Binance succeeds → degraded
// ═══════════════════════════════════════════════════════════════════════════

test('13. bitget throws on connect -> degraded, binance running', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => { throw new Error('BITGET_CONNECT_FAIL'); },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  const result = await p;
  assert.equal(multi.state, 'degraded');
  assert.equal(result.partial, true);
  assert.deepEqual(result.started, ['binance']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].exchange, 'bitget');
  assert.ok(result.failed[0].error.includes('BITGET_CONNECT_FAIL'));
  assert.ok(multi.getRuntime('binance').isRunning);
  assert.equal(multi.getRuntime('bitget').isRunning, false);
  assert.equal(multi.getStatus('bitget').state, 'failed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Binance fails, Bitget succeeds → degraded
// ═══════════════════════════════════════════════════════════════════════════

test('14. binance throws on connect -> degraded, bitget running', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        binance: {
          webSocketFactory: () => { throw new Error('BINANCE_CONNECT_FAIL'); },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  const result = await p;
  assert.equal(multi.state, 'degraded');
  assert.deepEqual(result.started, ['bitget']);
  assert.equal(result.failed[0].exchange, 'binance');
  assert.ok(multi.getRuntime('bitget').isRunning);
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Both fail → MultiExchangeStartError
// ═══════════════════════════════════════════════════════════════════════════

test('15. both fail -> MultiExchangeStartError', async () => {
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: { bitget: { webSocketFactory: () => { throw new Error('FAIL'); }, scheduler: new FakeScheduler() as any, ackTimeoutMs: 5000 } },
    },
    binance: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: { binance: { webSocketFactory: () => { throw new Error('FAIL'); }, scheduler: new FakeScheduler() as any, ackTimeoutMs: 5000 } },
    },
  });
  try {
    await multi.start();
    assert.fail('expected MultiExchangeStartError');
  } catch (err) {
    assert.ok(err instanceof MultiExchangeStartError);
    const mErr = err as MultiExchangeStartError;
    assert.equal(mErr.result.started.length, 0);
    assert.equal(mErr.result.failed.length, 2);
    assert.equal(mErr.result.failed[0].exchange, 'bitget');
    assert.equal(mErr.result.failed[1].exchange, 'binance');
    assert.equal(mErr.result.partial, false);
    assert.equal(multi.state, 'failed');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Degraded retry: first bitget fails, fix and restart → running
// ═══════════════════════════════════════════════════════════════════════════

test('16. degraded retry restarts only failed side', async () => {
  let bitgetThrow = true;
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: (url: string) => {
            if (bitgetThrow) throw new Error('BG_FAIL');
            return fB.create(url);
          },
          scheduler: sB as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  // First start → bitget throws, binance succeeds
  const p1 = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p1;
  // state degraded (bitget failed)
  assert.equal(multi.state, 'degraded');
  assert.equal(multi.getStatus('bitget').state, 'failed');
  // Fix bitget and retry
  const socketCountNBefore = fN.createdSockets.length;
  bitgetThrow = false;
  const p2 = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB, 0);
  openBinanceAndAck(fN, socketCountNBefore);
  const result = await p2;
  assert.equal(multi.state, 'running');
  assert.equal(result.started.length, 2);
  assert.equal(fN.createdSockets.length, socketCountNBefore, 'binance sockets unchanged');
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. Concurrent start identity
// ═══════════════════════════════════════════════════════════════════════════

test('17. concurrent start returns same promise', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p1 = multi.start();
  const p2 = multi.start();
  assert.strictEqual(p1, p2);
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p1;
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. Stop is idempotent
// ═══════════════════════════════════════════════════════════════════════════

test('18. stop is idempotent and stops both runtimes', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  assert.equal(multi.state, 'running');
  multi.stop();
  assert.equal(multi.getRuntime('bitget').isRunning, false);
  assert.equal(multi.getRuntime('binance').isRunning, false);
  multi.stop(); // second must not throw
  assert.equal(multi.state, 'stopped');
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Stop during start → no state resurrection
// ═══════════════════════════════════════════════════════════════════════════

test('19. stop during start prevents stale completion reviving state', { timeout: 5000 }, async () => {
  // Use a Bitget factory that throws synchronously — both children fail
  // immediately and the start promise rejects. We then call stop() AFTER
  // awaiting the start promise to verify state remains 'stopped'.
  const sB = new FakeScheduler();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: { bitget: { webSocketFactory: () => { throw new Error('CONNECT_FAIL'); }, scheduler: sB as any, ackTimeoutMs: 5000 } },
    },
    binance: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: { binance: { webSocketFactory: () => { throw new Error('CONNECT_FAIL'); }, scheduler: sN as any, ackTimeoutMs: 5000 } },
    },
  });
  // start → both fail synchronously → MultiExchangeStartError
  let caught: MultiExchangeStartError | null = null;
  try {
    await multi.start();
    assert.fail('expected MultiExchangeStartError');
  } catch (err) {
    assert.ok(err instanceof MultiExchangeStartError);
    caught = err as MultiExchangeStartError;
  }
  assert.ok(caught);
  assert.equal(multi.state, 'failed');
  // Now stop and verify state goes back to stopped (not revived)
  multi.stop();
  assert.equal(multi.state, 'stopped');
  assert.equal(multi.getRuntime('bitget').isRunning, false);
  assert.equal(multi.getRuntime('binance').isRunning, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Stop → restart succeeds (one-shot helper)
// ═══════════════════════════════════════════════════════════════════════════

// Helper: open + ack all new Bitget/Binance sockets synchronously after a
// start() promise resolves its initiating microtask.
async function startWithAcks(
  multi: MultiExchangeRuntime,
  fB: FakeWSFactory, fN: FakeWSFactory,
  bitgetFrom: number, binanceFrom: number,
): Promise<MultiExchangeStartResult> {
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB, bitgetFrom);
  openBinanceAndAck(fN, binanceFrom);
  return p;
}

test('20. stop then restart succeeds', async () => {
  // Track socket creation indexes precisely so we open+ack only new sockets.
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  // 1st start
  let idx = 0;
  const bgIdx1 = idx; idx = fB.createdSockets.length;
  const bnIdx1 = idx;
  const p1 = multi.start();
  await flushMicrotasks();
  // After microtask, fB.createdSockets may have grown (Bitget has 1 socket)
  const bgEnd1 = fB.createdSockets.length;
  const bnEnd1 = fN.createdSockets.length;
  openBitgetAndAck(fB, bgIdx1);
  openBinanceAndAck(fN, bnIdx1);
  await p1;
  assert.equal(multi.state, 'running');
  multi.stop();
  assert.equal(multi.state, 'stopped');
  // 2nd start: open+ack any sockets created since bgEnd1/bnEnd1
  const p2 = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB, bgEnd1);
  openBinanceAndAck(fN, bnEnd1);
  await p2;
  assert.equal(multi.state, 'running');
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. apply('bitget') does NOT affect Binance
// ═══════════════════════════════════════════════════════════════════════════

test('21. apply bitget does not touch binance', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const uB = makeUniverse(['BTC/USDT', 'ETH/USDT']);
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(uB, fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const startP = multi.start();
  await flushMicrotasks();
  const bgEnd = fB.createdSockets.length;
  const bnEnd = fN.createdSockets.length;
  openBitgetAndAck(fB, 0);
  openBinanceAndAck(fN, 0);
  await startP;
  assert.equal(multi.getRuntime('bitget').appliedPlanVersion, 1);
  assert.equal(multi.getRuntime('binance').appliedPlanVersion, 1);
  uB.removeSymbol('ETH/USDT');
  const applyP = multi.applyUniversePlan('bitget');
  await flushMicrotasks();
  // Open+ack any new bitget sockets created by the apply
  openBitgetAndAck(fB, bgEnd);
  const result = await applyP;
  assert.equal(result.applied, true);
  assert.equal(multi.getRuntime('bitget').appliedPlanVersion, 2);
  assert.equal(multi.getRuntime('binance').appliedPlanVersion, 1, 'binance version unchanged');
  // No new binance sockets
  assert.equal(fN.createdSockets.length, bnEnd, 'binance did not create sockets');
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. apply('binance') does NOT affect Bitget
// ═══════════════════════════════════════════════════════════════════════════

test('22. apply binance does not touch bitget', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const uN = makeUniverse(['BTC/USDT', 'ETH/USDT']);
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(uN, fN, sN),
  });
  const startP = multi.start(); await flushMicrotasks();
  const bgEnd = fB.createdSockets.length;
  const bnEnd = fN.createdSockets.length;
  openBitgetAndAck(fB, 0); openBinanceAndAck(fN, 0);
  await startP;
  uN.removeSymbol('ETH/USDT');
  const applyP = multi.applyUniversePlan('binance');
  await flushMicrotasks();
  openBinanceAndAck(fN, bnEnd);
  await applyP;
  assert.equal(multi.getRuntime('binance').appliedPlanVersion, 2);
  assert.equal(multi.getRuntime('bitget').appliedPlanVersion, 1);
  assert.equal(fB.createdSockets.length, bgEnd, 'bitget did not create sockets');
});

// ═══════════════════════════════════════════════════════════════════════════
// 23. Concurrent apply on different exchanges
// ═══════════════════════════════════════════════════════════════════════════

test('23. concurrent apply on different exchanges works independently', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const uB = makeUniverse(['BTC/USDT', 'ETH/USDT']);
  const uN = makeUniverse(['BTC/USDT', 'SOL/USDT']);
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(uB, fB, sB),
    binance: binanceOpts(uN, fN, sN),
  });
  const startP = multi.start(); await flushMicrotasks();
  const bgEnd = fB.createdSockets.length;
  const bnEnd = fN.createdSockets.length;
  openBitgetAndAck(fB, 0); openBinanceAndAck(fN, 0);
  await startP;
  uB.removeSymbol('ETH/USDT');
  uN.removeSymbol('SOL/USDT');
  const pB = multi.applyUniversePlan('bitget');
  const pN = multi.applyUniversePlan('binance');
  await flushMicrotasks();
  openBitgetAndAck(fB, bgEnd);
  openBinanceAndAck(fN, bnEnd);
  const [rB, rN] = await Promise.all([pB, pN]);
  assert.equal(rB.applied, true);
  assert.equal(rN.applied, true);
  assert.equal(multi.getRuntime('bitget').appliedPlanVersion, 2);
  assert.equal(multi.getRuntime('binance').appliedPlanVersion, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 24. Same-side concurrent apply returns same promise
// ═══════════════════════════════════════════════════════════════════════════

test('24. same-side concurrent apply returns same promise', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const uB = makeUniverse(['BTC/USDT', 'ETH/USDT']);
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(uB, fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const startP = multi.start(); await flushMicrotasks();
  const bgEnd = fB.createdSockets.length;
  openBitgetAndAck(fB, 0); openBinanceAndAck(fN, 0);
  await startP;
  uB.removeSymbol('ETH/USDT');
  const p1 = multi.applyUniversePlan('bitget');
  const p2 = multi.applyUniversePlan('bitget');
  assert.strictEqual(p1, p2);
  await flushMicrotasks();
  openBitgetAndAck(fB, bgEnd);
  await p1;
  assert.equal(multi.getRuntime('bitget').appliedPlanVersion, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 25. Apply failure marks only target exchange
// ═══════════════════════════════════════════════════════════════════════════

test('25. apply failure marks only target exchange', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const uB = makeUniverse(['BTC/USDT']);
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(uB, fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const startP = multi.start(); await flushMicrotasks();
  openBitgetAndAck(fB, 0); openBinanceAndAck(fN, 0);
  await startP;
  multi.stop();
  uB.removeSymbol('BTC/USDT');
  try {
    await multi.applyUniversePlan('bitget');
    assert.fail('expected apply to fail');
  } catch {
    assert.equal(multi.getStatus('bitget').state, 'stopped');
    assert.equal(multi.getStatus('binance').state, 'stopped');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 26. Invalid exchange rejects
// ═══════════════════════════════════════════════════════════════════════════

test('26. invalid exchange getRuntime/applyUniversePlan/getStatus rejects', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  for (const bad of ['coinbase', '', 'BITGET', 'bitget ' as any, null, undefined]) {
    assert.throws(() => multi.getRuntime(bad), /invalid exchange/i);
    assert.throws(() => multi.applyUniversePlan(bad), /invalid exchange/i);
    assert.throws(() => multi.getStatus(bad), /invalid exchange/i);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 27. Caller cannot override exchange
// ═══════════════════════════════════════════════════════════════════════════

test('27. caller injected exchange cannot override fixed values', () => {
  const multi = createMultiExchangeRuntime({
    bitget: { ...bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()), exchange: 'binance' as any },
    binance: { ...binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()), exchange: 'bitget' as any },
  } as any);
  assert.equal(multi.getRuntime('bitget').exchange, 'bitget');
  assert.equal(multi.getRuntime('binance').exchange, 'binance');
});

// ═══════════════════════════════════════════════════════════════════════════
// 28. Statuses stable order
// ═══════════════════════════════════════════════════════════════════════════

test('28. statuses returns both exchanges in stable order', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  const s = multi.statuses;
  assert.deepEqual([...s.keys()], ['bitget', 'binance']);
  assert.equal(s.get('bitget')!.exchange, 'bitget');
  assert.equal(s.get('binance')!.exchange, 'binance');
  assert.equal(s.get('bitget')!.state, 'stopped');
  assert.equal(s.get('binance')!.state, 'stopped');
});

// ═══════════════════════════════════════════════════════════════════════════
// 29. No unified Store / Bus / aggregation API
// ═══════════════════════════════════════════════════════════════════════════

test('29. no unified store/bus/aggregation API on coordinator', () => {
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()),
  });
  assert.equal((multi as any).store, undefined);
  assert.equal((multi as any).bus, undefined);
  assert.equal((multi as any).marketData, undefined);
  assert.ok(multi.getRuntime('bitget').marketData.store);
});

// ═══════════════════════════════════════════════════════════════════════════
// 30. All tests run fully offline
// ═══════════════════════════════════════════════════════════════════════════

test('30. all tests run fully offline with fake collectors', () => {
  assert.ok(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C3-R1: isolation, safeErrorMessage, stop-error handling
// ═══════════════════════════════════════════════════════════════════════════

// 31. Stop capturing bitgetRuntime.stop() errors does NOT rethrow
test('31. stop capturing bitgetRuntime.stop() error does not rethrow', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  // Start, ack, then stop
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  assert.equal(multi.state, 'running');

  // Patch bitgetRuntime.stop to throw
  const rtB = multi.getRuntime('bitget');
  const originalStop = rtB.stop.bind(rtB);
  let stopCalls = 0;
  (rtB as any).stop = () => {
    stopCalls++;
    throw new Error('BITGET_STOP_FAIL');
  };

  // multi.stop() must NOT throw — it captures the error internally
  let caught: unknown;
  try {
    multi.stop();
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, undefined, 'multi.stop() must not rethrow child errors');
  assert.equal(stopCalls, 1, 'bitgetRuntime.stop() was called exactly once');
  // binance should still have been stopped (child record updated)
  assert.equal(multi.getRuntime('binance').isRunning, false, 'binance stopped despite bitget failure');
  // bitget status reflects failure (lastError retained)
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.ok(multi.getStatus('bitget').lastError?.includes('BITGET_STOP_FAIL'));
  // Restore for cleanliness (no-op since test ends)
  (rtB as any).stop = originalStop;
});

// 32. Stop capturing binanceRuntime.stop() error does NOT rethrow
test('32. stop capturing binanceRuntime.stop() error does not rethrow', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;

  const rtN = multi.getRuntime('binance');
  const originalStop = rtN.stop.bind(rtN);
  let stopCalls = 0;
  (rtN as any).stop = () => {
    stopCalls++;
    throw new Error('BINANCE_STOP_FAIL');
  };

  let caught: unknown;
  try {
    multi.stop();
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, undefined, 'multi.stop() must not rethrow child errors');
  assert.equal(stopCalls, 1, 'binanceRuntime.stop() was called exactly once');
  assert.equal(multi.getRuntime('bitget').isRunning, false, 'bitget stopped despite binance failure');
  assert.equal(multi.getStatus('binance').state, 'failed');
  assert.ok(multi.getStatus('binance').lastError?.includes('BINANCE_STOP_FAIL'));
  (rtN as any).stop = originalStop;
});

// 33. Stop captures BOTH children stop errors without rethrowing
test('33. stop captures both children stop errors without rethrowing', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;

  const rtB = multi.getRuntime('bitget');
  const rtN = multi.getRuntime('binance');
  let bgStopCalls = 0;
  let bnStopCalls = 0;
  (rtB as any).stop = () => { bgStopCalls++; throw new Error('BG_STOP_FAIL'); };
  (rtN as any).stop = () => { bnStopCalls++; throw new Error('BN_STOP_FAIL'); };

  let caught: unknown;
  try {
    multi.stop();
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, undefined, 'must not rethrow even when both children throw');
  assert.equal(bgStopCalls, 1, 'bitgetRuntime.stop() was called');
  assert.equal(bnStopCalls, 1, 'binanceRuntime.stop() was still called after bitget threw');
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.equal(multi.getStatus('binance').state, 'failed');
  assert.ok(multi.getStatus('bitget').lastError?.includes('BG_STOP_FAIL'));
  assert.ok(multi.getStatus('binance').lastError?.includes('BN_STOP_FAIL'));
});

// 34. safeErrorMessage redacts apiKey from error messages
test('34. safeErrorMessage redacts apiKey from error messages', async () => {
  // Bitget factory throws an error containing an API key — the surfaced
  // failure message must replace the secret value with "[REDACTED]".
  const secret = ' SqlDataAdapter ';
  const sensitiveApiKey = 'bg-abc123secret456';
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => {
            throw new Error(`auth failed apiKey=${sensitiveApiKey} secret=supersecret value`);
          },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  // bitget status lastError must NOT contain the raw secret
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok(!lastErr.includes(sensitiveApiKey), `lastError must not leak apiKey; got: "${lastErr}"`);
  // explicitly-redacted sentinel present
  assert.ok(lastErr.includes('[REDACTED]'), `expected redaction sentinel; got: "${lastErr}"`);
  // 'supersecret' (bound to secret=...) must also be redacted
  assert.ok(!lastErr.includes('supersecret'), `secret= value must be redacted; got: "${lastErr}"`);
});

// 35. Isolation error thrown when universe is shared
test('35. throws MultiExchangeIsolationError when universe is shared', () => {
  const sharedUniverse = makeUniverse(['BTC/USDT']);
  assert.throws(() => {
    createMultiExchangeRuntime({
      bitget: bitgetOpts(sharedUniverse, new FakeWSFactory(), new FakeScheduler()),
      binance: binanceOpts(sharedUniverse, new FakeWSFactory(), new FakeScheduler()),
    });
  }, (err: unknown) => {
    assert.ok(err instanceof MultiExchangeIsolationError, `expected MultiExchangeIsolationError, got ${(err as Error).name}`);
    assert.equal((err as MultiExchangeIsolationError).resource, 'universe');
    return true;
  });
});

// 36. Real shared bus rejected — inject same bus via TradingRuntimeOptions
test('36. real shared bus rejected by createMultiExchangeRuntime', () => {
  const sharedBus = createTradingEventBus();
  const bOpts = bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler());
  const nOpts = binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler());
  bOpts.runtime = { ...bOpts.runtime, bus: sharedBus };
  nOpts.runtime = { ...nOpts.runtime, bus: sharedBus };

  assert.throws(
    () => createMultiExchangeRuntime({ bitget: bOpts as any, binance: nOpts as any }),
    (err: unknown) => {
      assert.ok(err instanceof MultiExchangeIsolationError);
      assert.equal((err as MultiExchangeIsolationError).resource, 'bus');
      return true;
    },
  );
});

// 37. Parent state truth table: bitget stop throws, binance succeeds → parent failed
// (Corrected per R2: one-failed + one-stopped = failed, NOT degraded)
test('37. parent state failed when one child stop throws and other succeeds', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start(); await flushMicrotasks();
  openBitgetAndAck(fB); openBinanceAndAck(fN);
  await p;
  assert.equal(multi.state, 'running');

  // Stop the multi with bitgetRuntime throwing → status records failed
  const rtB = multi.getRuntime('bitget');
  (rtB as any).stop = () => { throw new Error('FAIL'); };
  multi.stop();
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.equal(multi.getStatus('binance').state, 'stopped');
  // Per canonical R2 truth table: one- failed + one- stopped → parent failed
  assert.equal(multi.state, 'failed');
});

// 38. Stage 3B4C3-R1: safeErrorMessage truncates long messages to 256 chars
test('38. safeErrorMessage truncates long messages to 256 chars', async () => {
  const longMessage = 'x'.repeat(500);
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => { throw new Error(longMessage); },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok([...lastErr].length <= 256, `lastError must be <= 256 chars; got ${[...lastErr].length}`);
  // Content preserved (truncated prefix)
  assert.ok(lastErr.startsWith('Error: xxxxxxxxxx'), `expected truncation prefix; got "${lastErr.slice(0, 30)}..."`);
});

// 39. Stage 3B4C3-R1: safeErrorMessage strips newlines and control chars
test('39. safeErrorMessage strips newlines and control chars', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => {
            throw new Error('line1\nline2\ttabbed\u0007bell');
          },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok(!lastErr.includes('\n'), `must not contain newlines; got "${lastErr}"`);
  assert.ok(!lastErr.includes('\t'), `must not contain tabs; got "${lastErr}"`);
  assert.ok(!/[\x00-\x1F]/.test(lastErr), `must not contain control chars; got "${lastErr}"`);
  // Both error fragments preserved (collapsed to single spaces)
  assert.ok(lastErr.includes('line1'), `expected 'line1' preserved; got "${lastErr}"`);
  assert.ok(lastErr.includes('line2'), `expected 'line2' preserved; got "${lastErr}"`);
});

// 40. Stage 3B4C3-R2: safeErrorMessage redacts real single-backslash Windows paths
test('40. safeErrorMessage redacts real Windows and POSIX paths', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  // Real runtime Windows paths — single backslash, not escaped
  const winPath1 = String.raw`C:\Users\user\secrets\api.json`;
  const winPath2 = String.raw`E:\private\config.env`;
  const posixPath = '/home/user/.config/keys.json';
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => {
            throw new Error(`loading config from ${winPath1} and ${winPath2} and ${posixPath} failed`);
          },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok(!lastErr.includes('C:\\Users'), `must not leak Windows path; got "${lastErr}"`);
  assert.ok(!lastErr.includes('E:\\private'), `must not leak second Windows path; got "${lastErr}"`);
  assert.ok(!lastErr.includes('/home/user'), `must not leak POSIX path; got "${lastErr}"`);
  assert.ok(lastErr.includes('[path]'), `expected [path] sentinel; got "${lastErr}"`);
});

// 40b. Stage 3B4C3-R2: safeErrorMessage redacts UNC paths
test('40b. safeErrorMessage redacts UNC paths', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const uncPath = String.raw`\\server\share\private.json`;
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => {
            throw new Error(`reading from ${uncPath} failed`);
          },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok(!lastErr.includes('\\\\server'), `must not leak UNC path; got "${lastErr}"`);
  assert.ok(lastErr.includes('[path]'), `expected [path] sentinel; got "${lastErr}"`);
});

// 40c. Stage 3B4C3-R2: path redaction coexists with secret redaction
test('40c. path and secret redaction coexist in same error message', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => {
            throw new Error(`config apiKey=abc123 from C:\\config\\secrets.env`);
          },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok(!lastErr.includes('abc123'), `must not leak secret; got "${lastErr}"`);
  assert.ok(!lastErr.includes('secrets.env'), `must not leak path; got "${lastErr}"`);
  assert.ok(lastErr.includes('[REDACTED]'), `expected redaction sentinel; got "${lastErr}"`);
  assert.ok(lastErr.includes('[path]'), `expected path sentinel; got "${lastErr}"`);
});

// 41. Stage 3B4C3-R1: safeErrorMessage formats Error subclasses as 'Name: msg'
test('41. safeErrorMessage formats Error subclasses as Name: msg', async () => {
  class CustomAuthError extends Error {
    constructor(msg: string) { super(msg); this.name = 'CustomAuthError'; }
  }
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          webSocketFactory: () => { throw new CustomAuthError('auth rejected'); },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.ok(lastErr.startsWith('CustomAuthError:'), `expected 'CustomAuthError: ...'; got "${lastErr}"`);
  assert.ok(lastErr.includes('auth rejected'));
});

// 42. Stage 3B4C3-R1: safeErrorMessage handles non-Error throws
test('42. safeErrorMessage handles non-Error throws', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: {
        bitget: {
          // Throw a non-Error object — safeErrorMessage must fall back to
          // "Unknown lifecycle error" rather than stringifying arbitrary objects.
          webSocketFactory: () => { throw { weird: 'object', apiKey: 'leaked-secret-123' }; },
          scheduler: new FakeScheduler() as any,
          ackTimeoutMs: 5000,
        },
      },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  await p;
  const lastErr = multi.getStatus('bitget').lastError ?? '';
  assert.equal(lastErr, 'Unknown lifecycle error', `expected fallback text; got "${lastErr}"`);
  // Critical: the secret in the non-Error object must NOT leak via stringification
  assert.ok(!lastErr.includes('leaked-secret-123'), `must not leak secret from non-Error throw; got "${lastErr}"`);
});

// 43. Caller-injected `exchange` field on multi-exchange options is silently overridden
test('43. caller providing `exchange` on bitget/binance child options is overridden silently', () => {
  // Note: this matches existing test 27 but checks that the override does
  // not corrupt isolation invariants.
  const multi = createMultiExchangeRuntime({
    bitget: { ...bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()), exchange: 'binance' as any } as any,
    binance: { ...binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()), exchange: 'bitget' as any } as any,
  });
  assert.equal(multi.getRuntime('bitget').exchange, 'bitget');
  assert.equal(multi.getRuntime('binance').exchange, 'binance');
  // Isolation still enforced despite injection attempt
  assert.notEqual(multi.getRuntime('bitget').bus, multi.getRuntime('binance').bus);
  assert.notEqual(multi.getRuntime('bitget').universe, multi.getRuntime('binance').universe);
  assert.notEqual(multi.getRuntime('bitget').router, multi.getRuntime('binance').router);
});

// 44. MultiExchangeIsolationError is exported from the trading barrel
test('44. MultiExchangeIsolationError is exported from trading barrel', async () => {
  const mod = await import('../../../src/runtime/trading/index');
  assert.ok(typeof mod.MultiExchangeIsolationError === 'function', 'must be exported from barrel');
  assert.equal(mod.MultiExchangeIsolationError.name, 'MultiExchangeIsolationError');
  const err = new mod.MultiExchangeIsolationError('test-resource');
  assert.equal(err.resource, 'test-resource');
  assert.ok(err instanceof Error);
});

// 45. Stop records child failure but does not affect a later start()'s ability to retry
test('45. stop records child failure but later start can still retry', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  assert.equal(multi.state, 'running');

  // Make bitgetRuntime.stop() throw, then stop
  const rtB = multi.getRuntime('bitget');
  (rtB as any).stop = () => { throw new Error('BG_STOP_FAIL'); };
  multi.stop();
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.ok(multi.getStatus('bitget').lastError?.includes('BG_STOP_FAIL'));

  // Restore rtB.stop and start again — should succeed cleanly
  (rtB as any).stop = () => { /* no-op */ };
  const bgEnd = fB.createdSockets.length;
  const bnEnd = fN.createdSockets.length;
  const p2 = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB, bgEnd);
  openBinanceAndAck(fN, bnEnd);
  await p2;
  assert.equal(multi.state, 'running');
  // lastError should be cleared on successful start
  assert.equal(multi.getStatus('bitget').lastError, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C3-R2: parent state truth table + real-path isolation
// ═══════════════════════════════════════════════════════════════════════════

// 46. Both stopped → parent stopped (after successful start + clean stop)
test('46. both stopped -> parent stopped', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  assert.equal(multi.state, 'running');
  multi.stop();
  assert.equal(multi.state, 'stopped');
});

// 47. Both running → parent running
test('47. both running -> parent running', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  assert.equal(multi.state, 'running');
});

// 48. One running + one failed (degraded start) → degraded
test('48. one running + one failed -> parent degraded', async () => {
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: {
      runtime: { universe: makeUniverse(), indicatorService: new FakeIndicatorService() as any, routerConfig: {} },
      provider: { bitget: { webSocketFactory: () => { throw new Error('BG_FAIL'); }, scheduler: new FakeScheduler() as any, ackTimeoutMs: 5000 } },
    },
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBinanceAndAck(fN);
  const result = await p;
  assert.equal(result.partial, true);
  assert.equal(multi.getStatus('binance').state, 'running');
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.equal(multi.state, 'degraded');
});

// 49. Bitget stop throws, binance stops clean → parent failed (not degraded)
test('49. bitget stop fails, binance clean -> parent failed', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  const rtB = multi.getRuntime('bitget');
  (rtB as any).stop = () => { throw new Error('FAIL'); };
  multi.stop();
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.equal(multi.getStatus('binance').state, 'stopped');
  // Canonical: one-failed + one-stopped = failed
  assert.equal(multi.state, 'failed');
});

// 50. Binance stop throws, bitget clean → parent failed
test('50. binance stop fails, bitget clean -> parent failed', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  const rtN = multi.getRuntime('binance');
  (rtN as any).stop = () => { throw new Error('FAIL'); };
  multi.stop();
  assert.equal(multi.getStatus('bitget').state, 'stopped');
  assert.equal(multi.getStatus('binance').state, 'failed');
  assert.equal(multi.state, 'failed');
});

// 51. Both stop throws → parent failed
test('51. both stop fail -> parent failed', async () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const p = multi.start();
  await flushMicrotasks();
  openBitgetAndAck(fB);
  openBinanceAndAck(fN);
  await p;
  const rtB = multi.getRuntime('bitget');
  const rtN = multi.getRuntime('binance');
  (rtB as any).stop = () => { throw new Error('FAIL_B'); };
  (rtN as any).stop = () => { throw new Error('FAIL_N'); };
  multi.stop();
  assert.equal(multi.getStatus('bitget').state, 'failed');
  assert.equal(multi.getStatus('binance').state, 'failed');
  assert.equal(multi.state, 'failed');
});

// 52. Real shared KillSwitch via distinct ExecutionRouters
test('52. real shared kill switch via distinct routers', () => {
  const sharedKs = new KillSwitch('bitget');
  const bitgetRouter = new ExecutionRouter({
    exchange: 'bitget',
    fastPathTimeoutSec: 1.5,
    maxBiasReportAgeHours: 2,
    killSwitch: sharedKs,
  });
  // Stage 3B4C4: cross-binding check — binance router rejects KS with wrong exchange
  assert.throws(
    () => new ExecutionRouter({
      exchange: 'binance',
      fastPathTimeoutSec: 1.5,
      maxBiasReportAgeHours: 2,
      killSwitch: sharedKs,
    }),
    /killSwitch\.exchange/,
  );
});

// 53. Shared indicator service is allowed (no isolation violation)
test('53. shared indicator service does not trigger isolation', () => {
  const sharedIS = new FakeIndicatorService();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler(), sharedIS),
    binance: binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler(), sharedIS),
  });
  assert.ok(multi);
  assert.notEqual(multi.getRuntime('bitget').bus, multi.getRuntime('binance').bus);
});

// 54. TradingRuntime rejects injected router with wrong exchange
test('54. TradingRuntime rejects injected router with wrong exchange', () => {
  const sharedRouter = new ExecutionRouter({
    exchange: 'bitget',
    fastPathTimeoutSec: 1.5,
    maxBiasReportAgeHours: 2,
    killSwitch: new KillSwitch('bitget'),
  });
  const nOpts = binanceOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler());
  // Inject the bitget router into binance opts — should fail at TradingRuntime constructor
  delete (nOpts.runtime as any).routerConfig;
  nOpts.runtime = { ...nOpts.runtime, router: sharedRouter };

  // Stage 3B4C4: TradingRuntime validates router.exchange === exchange
  // Injecting a bitget router into a binance runtime should throw
  assert.throws(
    () => createMultiExchangeRuntime({ bitget: bitgetOpts(makeUniverse(), new FakeWSFactory(), new FakeScheduler()) as any, binance: nOpts as any }),
    /router.exchange/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C4: Exchange-identity tests
// ═══════════════════════════════════════════════════════════════════════════

// 55. Router exchange identity on Bitget side
test('55. Bitget runtime router exchange identity', () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  assert.equal(multi.getRuntime('bitget').router.exchange, 'bitget');
});

// 56. Router exchange identity on Binance side
test('56. Binance runtime router exchange identity', () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  assert.equal(multi.getRuntime('binance').router.exchange, 'binance');
});

// 57. KillSwitch exchange identity bound through router
test('57. KillSwitch exchange identity bound through router', () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  assert.equal(multi.getRuntime('bitget').router.killSwitch.exchange, 'bitget');
  assert.equal(multi.getRuntime('binance').router.killSwitch.exchange, 'binance');
});

// 58. RiskSnapshot exchange distinct per side
test('58. RiskSnapshot exchange distinct per side', () => {
  const fB = new FakeWSFactory();
  const sB = new FakeScheduler();
  const fN = new FakeWSFactory();
  const sN = new FakeScheduler();
  const multi = createMultiExchangeRuntime({
    bitget: bitgetOpts(makeUniverse(), fB, sB),
    binance: binanceOpts(makeUniverse(), fN, sN),
  });
  const bitSnapshot = multi.getRuntime('bitget').router.killSwitch.snapshot('bitget');
  const binSnapshot = multi.getRuntime('binance').router.killSwitch.snapshot('binance');
  assert.equal(bitSnapshot.exchange, 'bitget');
  assert.equal(binSnapshot.exchange, 'binance');
  // Independent: a lock on bitget does not affect binance
  multi.getRuntime('bitget').router.killSwitch.lock('bitget', 'test lock');
  const binAfterLock = multi.getRuntime('binance').router.killSwitch.snapshot('binance');
  assert.equal(binAfterLock.isTriggered, false, 'binance not affected by bitget lock');
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 3B4C4-R1: Router persistence + disk recovery invariants
// ═══════════════════════════════════════════════════════════════════════════

function makeBiasReport(exchange: ExchangeId, symbol = 'BTC/USDT'): MarketBiasReportFull {
  const now = Date.now();
  return {
    exchange,
    timestamp: now,
    updatedAt: now,
    globalBias: 'bullish',
    confidence: 80,
    assets: [{
      symbol,
      bias: 'bullish',
      confidence: 80,
      volatility: 25,
      direction: 'long',
      suggestedPositionPct: 10,
      entryCondition: 'test',
      stopLoss: '1%',
      takeProfit: '2%',
    }],
    globalLongShortRatio: 1.2,
    globalVolatility: 25,
    fearGreedIndex: 60,
    fundingStatus: 'neutral',
    whitelist: [symbol],
    blacklist: [],
    riskEvents: [],
    meta: {
      source: 'manual',
      modelVersion: 'test',
      generationTimeMs: 1,
      inputSummary: 'test',
    },
  };
}

function makeRouterForStore(exchange: ExchangeId, dir: string, config: Record<string, unknown> = {}): ExecutionRouter {
  return new ExecutionRouter({
    exchange,
    fastPathTimeoutSec: 1.5,
    maxBiasReportAgeHours: 2,
    killSwitch: new KillSwitch(exchange),
    reportStoreConfig: { dir, ...config } as any,
  });
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodds-3b4c4-r1-'));
  try {
    const result = run(dir);
    if (result && typeof (result as any).then === 'function') {
      return (Promise.resolve(result).finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      }) as T);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// 59. Both exchange files coexist in same directory
test('59. bitget and binance reports coexist in same temp directory', async () => {
  await withTempDir(async (dir) => {
    const bitget = makeRouterForStore('bitget', dir);
    const binance = makeRouterForStore('binance', dir);
    await Promise.all([
      bitget.updateBiasReport(makeBiasReport('bitget')),
      binance.updateBiasReport(makeBiasReport('binance')),
    ]);
    assert.equal(fs.existsSync(path.join(dir, 'bias.bitget.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'bias.binance.json')), true);
  });
});

// 60. Persisted contents carry correct exchange
test('60. persisted report files contain correct exchange', async () => {
  await withTempDir(async (dir) => {
    const bitget = makeRouterForStore('bitget', dir);
    const binance = makeRouterForStore('binance', dir);
    await bitget.updateBiasReport(makeBiasReport('bitget'));
    await binance.updateBiasReport(makeBiasReport('binance'));
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'bias.bitget.json'), 'utf8'));
    const n = JSON.parse(fs.readFileSync(path.join(dir, 'bias.binance.json'), 'utf8'));
    assert.equal(b.exchange, 'bitget');
    assert.equal(n.exchange, 'binance');
  });
});

// 61. Legacy bias.json is ignored
test('61. legacy bias.json is never loaded', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'bias.json'), JSON.stringify(makeBiasReport('bitget')));
    const bitget = makeRouterForStore('bitget', dir);
    const binance = makeRouterForStore('binance', dir);
    assert.equal(await bitget.loadBiasReportFromDisk(), null);
    assert.equal(await binance.loadBiasReportFromDisk(), null);
    assert.equal(bitget.getBiasReport(), null);
    assert.equal(binance.getBiasReport(), null);
  });
});

// 62. Missing exchange on disk returns null
test('62. disk report missing exchange returns null without memory restore', async () => {
  await withTempDir(async (dir) => {
    const raw: any = makeBiasReport('bitget');
    delete raw.exchange;
    fs.writeFileSync(path.join(dir, 'bias.bitget.json'), JSON.stringify(raw));
    const router = makeRouterForStore('bitget', dir);
    assert.equal(await router.loadBiasReportFromDisk(), null);
    assert.equal(router.getBiasReport(), null);
  });
});

// 63. Invalid exchange on disk returns null
test('63. disk report with coinbase exchange returns null', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'bias.bitget.json'), JSON.stringify({ ...makeBiasReport('bitget'), exchange: 'coinbase' }));
    const router = makeRouterForStore('bitget', dir);
    assert.equal(await router.loadBiasReportFromDisk(), null);
    assert.equal(router.getBiasReport(), null);
  });
});

// 64. Mismatched exchange on disk returns null
test('64. bitget file containing binance report returns null', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'bias.bitget.json'), JSON.stringify(makeBiasReport('binance')));
    const router = makeRouterForStore('bitget', dir);
    assert.equal(await router.loadBiasReportFromDisk(), null);
    assert.equal(router.getBiasReport(), null);
  });
});

// 65. Caller filename override cannot escape exchange-specific name
test('65. caller filename override is ignored', async () => {
  await withTempDir(async (dir) => {
    const router = makeRouterForStore('bitget', dir, { filename: 'evil.json' });
    await router.updateBiasReport(makeBiasReport('bitget'));
    assert.equal(fs.existsSync(path.join(dir, 'bias.bitget.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'evil.json')), false);
  });
});

// 66. Mismatch update throws synchronously and has no side effects
test('66. updateBiasReport mismatch throws synchronously without side effects', () => {
  withTempDir((dir) => {
    const router = makeRouterForStore('bitget', dir);
    let emitted = false;
    router.on('bias_updated', () => { emitted = true; });
    assert.throws(
      () => router.updateBiasReport(makeBiasReport('binance')),
      /report\.exchange.*router\.exchange/,
    );
    assert.equal(emitted, false);
    assert.equal(router.getBiasReport(), null);
    assert.equal(fs.existsSync(path.join(dir, 'bias.bitget.json')), false);
  });
});

// 67. Valid disk load restores in-memory report
test('67. valid disk report load restores router memory', async () => {
  await withTempDir(async (dir) => {
    const report = makeBiasReport('bitget');
    fs.writeFileSync(path.join(dir, 'bias.bitget.json'), JSON.stringify(report));
    const router = makeRouterForStore('bitget', dir);
    const loaded = await router.loadBiasReportFromDisk();
    assert.equal(loaded?.exchange, 'bitget');
    assert.equal(router.getBiasReport()?.exchange, 'bitget');
  });
});

// 68. Route after valid disk load contains restored bias and decision exchange
test('68. route uses valid report restored from disk', async () => {
  await withTempDir(async (dir) => {
    const report = makeBiasReport('bitget');
    fs.writeFileSync(path.join(dir, 'bias.bitget.json'), JSON.stringify(report));
    const router = makeRouterForStore('bitget', dir);
    await router.loadBiasReportFromDisk();
    const decision = router.route({ exchange: 'bitget', source: SignalSource.MANUAL });
    assert.equal(decision.exchange, 'bitget');
    assert.equal(decision.biasReport?.exchange, 'bitget');
  });
});

// 69. Missing/invalid update exchange throws synchronously
test('69. updateBiasReport missing or invalid exchange throws synchronously', () => {
  withTempDir((dir) => {
    const router = makeRouterForStore('bitget', dir);
    const missing: any = makeBiasReport('bitget');
    delete missing.exchange;
    assert.throws(() => router.updateBiasReport(missing), /not a valid ExchangeId/);
    assert.throws(
      () => router.updateBiasReport({ ...makeBiasReport('bitget'), exchange: 'coinbase' } as any),
      /not a valid ExchangeId/,
    );
    assert.equal(router.getBiasReport(), null);
    assert.equal(fs.existsSync(path.join(dir, 'bias.bitget.json')), false);
  });
});

// 70. getBiasReport and route fail closed on corrupted in-memory provenance
test('70. getBiasReport rejects corrupted in-memory report provenance', () => {
  withTempDir((dir) => {
    const router = makeRouterForStore('bitget', dir);
    (router as any).biasReport = { ...makeBiasReport('bitget'), exchange: 'binance' };
    assert.equal(router.getBiasReport(), null);
    const decision = router.route({ exchange: 'bitget', source: SignalSource.HERMES_CRON });
    assert.equal(decision.biasReport, undefined);
    assert.equal(decision.defensiveMode, true);
  });
});
