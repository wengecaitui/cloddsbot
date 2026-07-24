// Stage 4A1: PaperRuntimeRegistry tests — ≥24 isolated multi-exchange tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperRuntimeRegistry } from '../../src/paper/PaperRuntimeRegistry';
import { PaperFastPathCoordinator } from '../../src/paper/PaperFastPathCoordinator';
import { PaperExecutionService } from '../../src/paper/PaperExecutionService';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { KillSwitch } from '../../src/router/KillSwitch';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const EXCH_BG: ExchangeId = 'bitget';
const EXCH_BN: ExchangeId = 'binance';
const anBg: PaperAccountConfig = { accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 };
const anBn: PaperAccountConfig = { accountId: 'a2', exchange: EXCH_BN, initialCashUsd: 200_000 };

const FUTURE = Date.now() + 120_000;

function mkTicker(ex: ExchangeId, sym: string, last: number, ts: number) {
  return { exchange: ex, instId: sym, channel: 'ticker' as const, last, bestBid: last - 1, bestAsk: last + 1, volume24h: 1000, high24h: last * 1.02, low24h: last * 0.98, ts };
}
function mkKline(ex: ExchangeId, sym: string, close: number, ts: number) {
  return { exchange: ex, instId: sym, channel: 'kline' as const, interval: '1m', open: close * 0.999, high: close * 1.001, low: close * 0.998, close, volume: 100, ts, confirm: true };
}
function momentumResult() {
  return { name: 'CompositeMomentum' as const, composite_score: 85, regime_state: 'STRONG_BULLISH' as const, in_cooldown: false, dimension_scores: { hull_big_trend: { value: 1, weight: 1 }, stc_momentum: { value: 1, weight: 1 }, volume_micro: { value: 1, weight: 1 } }, lag_bars: 0, elapsedMs: 0 };
}

function buildBinding(accountId: string, exchange: ExchangeId, initialCash: number, symbol: string, dir: string): Promise<{ binding: any; store: any; dir: string }> {
  // Returns a fully wired binding with a tmp dir
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's4a1-'));
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  store.updateTicker({ ticker: mkTicker(exchange, symbol, 50000, FUTURE), receivedAt: FUTURE });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 0; i < 200; i++) {
    const k = mkKline(exchange, symbol, 49000 + i * 10, FUTURE - (200 - i) * 60_000);
    store.updateClosedKline({ kline: k, receivedAt: k.ts });
    candle.appendClosedKline({ kline: k, receivedAt: k.ts });
  }
  const ac: PaperAccountConfig = { accountId, exchange, initialCashUsd: initialCash };
  const ks = new KillSwitch(exchange, { totalCapitalUsd: initialCash, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
  const fp = new FastPipeline({
    exchange,
    router: { exchange, getBiasReport: () => ({ exchange, updatedAt: Date.now(), assets: [{ symbol, direction: dir as 'long' | 'short', confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [symbol] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks },
    indicatorService: { calculateAll: async () => [momentumResult()] },
    marketData: { exchange, snapshotStore: store, candleStore: candle, interval: '1m', minimumSeries: 100, seriesLimit: 200 },
  });
  const svc = PaperExecutionService.openSync(ac, new PaperLedgerStore(anBg, { baseDir: d }));
  if (!svc) throw new Error('Failed to open service');
  const coord = new PaperFastPathCoordinator(fp, svc, exchange);
  return Promise.resolve({ binding: { accountId, exchange, pipeline: fp, service: svc, coordinator: coord }, store, dir: d });
}

// Helper to build a binding synchronously (openSync returns a promise in the real API)
async function buildBindingAsync(accountId: string, exchange: ExchangeId, initialCash: number, symbol: string, dir: 'long' | 'short') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's4a1-'));
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  store.updateTicker({ ticker: mkTicker(exchange, symbol, 50000, FUTURE), receivedAt: FUTURE });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 0; i < 200; i++) {
    const k = mkKline(exchange, symbol, 49000 + i * 10, FUTURE - (200 - i) * 60_000);
    store.updateClosedKline({ kline: k, receivedAt: k.ts });
    candle.appendClosedKline({ kline: k, receivedAt: k.ts });
  }
  const ac: PaperAccountConfig = { accountId, exchange, initialCashUsd: initialCash };
  const ks = new KillSwitch(exchange, { totalCapitalUsd: initialCash, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
  const fp = new FastPipeline({
    exchange,
    router: { exchange, getBiasReport: () => ({ exchange, updatedAt: Date.now(), assets: [{ symbol, direction: dir, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [symbol] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks },
    indicatorService: { calculateAll: async () => [momentumResult()] },
    marketData: { exchange, snapshotStore: store, candleStore: candle, interval: '1m', minimumSeries: 100, seriesLimit: 200 },
  });
  const svc = await PaperExecutionService.open(ac, new PaperLedgerStore(ac, { baseDir: d }));
  const coord = new PaperFastPathCoordinator(fp, svc, exchange);
  return { binding: { accountId, exchange, pipeline: fp, service: svc, coordinator: coord }, store, dir: d };
}

const SIG_BG = { exchange: EXCH_BG, symbol: 'BTCUSDT', source: 's' };
const SIG_BN = { exchange: EXCH_BN, symbol: 'ETHUSDT', source: 's' };
const P = { feeBps: 10, slippageBps: 5 };

// ═══ Basic Registry Tests ══════════════════════════════════════
test('1. register + has + list', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry();
    reg.register(binding);
    assert.ok(reg.has('a1', EXCH_BG));
    assert.equal(reg.list().length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('2. duplicate register rejected', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry();
    reg.register(binding);
    assert.throws(() => reg.register(binding), /duplicate/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('3. invalid exchange rejected', () => {
  const reg = new PaperRuntimeRegistry();
  assert.throws(() => reg.register({ accountId: 'x', exchange: 'bad' as any, pipeline: null as any, service: null as any, coordinator: null as any }), /exchange/);
});

test('4. unregister', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry();
    reg.register(binding);
    assert.ok(reg.unregister('a1', EXCH_BG));
    assert.ok(!reg.has('a1', EXCH_BG));
    assert.ok(!reg.unregister('a1', EXCH_BG));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('5. unknown route rejects', () => {
  const reg = new PaperRuntimeRegistry();
  assert.throws(() => reg.get('missing', EXCH_BG), /no binding/);
});

// ═══ Routing Tests ════════════════════════════════════════════
test('6. bitget trade applied via registry', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    const r = await reg.run('a1', SIG_BG, P);
    assert.equal(r.pipelineResult.decision, 'trade');
    assert.equal(r.paperEvent!.status, 'applied');
    assert.equal(reg.snapshot('a1', EXCH_BG).processedFills, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('7. binance trade applied via registry', async () => {
  const { binding, dir } = await buildBindingAsync('a2', EXCH_BN, 100_000, 'ETHUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    const r = await reg.run('a2', SIG_BN, P);
    assert.equal(r.pipelineResult.decision, 'trade');
    assert.equal(r.paperEvent!.status, 'applied');
    assert.equal(reg.snapshot('a2', EXCH_BN).processedFills, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('8. unknown route rejects', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    await assert.rejects(() => reg.run('a1', SIG_BN, P), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('9. symbol not in whitelist → skip, no paper', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    const r = await reg.run('a1', { exchange: EXCH_BG, symbol: 'ETHUSDT', source: 's' }, P);
    assert.equal(r.pipelineResult.decision, 'skip');
    assert.equal(r.paperEvent, undefined);
    assert.equal(reg.snapshot('a1', EXCH_BG).processedFills, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ═══ Cross-Exchange Isolation ═════════════════════════════════
test('10. dual exchange + independent balances', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding); reg.register(b2.binding);
    await reg.run('a1', SIG_BG, P); await reg.run('a1', SIG_BN, P);
    const s1 = reg.snapshot('a1', EXCH_BG); const s2 = reg.snapshot('a1', EXCH_BN);
    assert.equal(s1.processedFills, 1); assert.equal(s2.processedFills, 1);
    assert.ok(s1.cashUsd < 100_000); assert.ok(s2.cashUsd < 200_000);
    assert.notStrictEqual(s1, s2);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('11. duplicate local-only, not cross-exchange', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding); reg.register(b2.binding);
    // Two runs to same binding
    assert.equal((await reg.run('a1', SIG_BG, P)).paperEvent!.status, 'applied');
    assert.equal((await reg.run('a1', SIG_BG, P)).paperEvent!.status, 'applied');
    assert.equal(reg.snapshot('a1', EXCH_BG).processedFills, 2);
    // Binance untouched
    assert.equal(reg.snapshot('a1', EXCH_BN).processedFills, 0);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('12. cross-account isolation', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a2', EXCH_BG, 200_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding); reg.register(b2.binding);
    await reg.run('a1', SIG_BG, P); await reg.run('a2', SIG_BG, P);
    assert.equal(reg.snapshot('a1', EXCH_BG).processedFills, 1);
    assert.equal(reg.snapshot('a2', EXCH_BG).processedFills, 1);
    assert.notStrictEqual(reg.snapshot('a1', EXCH_BG), reg.snapshot('a2', EXCH_BG));
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('13. concurrent cross-exchange', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding); reg.register(b2.binding);
    const [r1, r2] = await Promise.all([reg.run('a1', SIG_BG, P), reg.run('a1', SIG_BN, P)]);
    assert.equal(r1.paperEvent!.status, 'applied'); assert.equal(r2.paperEvent!.status, 'applied');
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('14. deterministic list order', async () => {
  const b1 = await buildBindingAsync('b', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  const b3 = await buildBindingAsync('a', EXCH_BG, 150_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b3.binding); reg.register(b1.binding); reg.register(b2.binding);
    const xs = reg.list();
    assert.equal(xs.length, 3);
    assert.equal(xs[0].accountId, 'a'); assert.equal(xs[0].exchange, EXCH_BN);
    assert.equal(xs[1].accountId, 'a'); assert.equal(xs[1].exchange, EXCH_BG);
    assert.equal(xs[2].accountId, 'b'); assert.equal(xs[2].exchange, EXCH_BG);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); await fs.rm(b3.dir, { recursive: true, force: true }); }
});

test('15. unregister blocks routing', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    await reg.run('a1', SIG_BG, P);
    reg.unregister('a1', EXCH_BG);
    await assert.rejects(() => reg.run('a1', SIG_BG, P), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('16. restart isolation', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding);
    await reg.run('a1', SIG_BG, P);
    const svc2 = await PaperExecutionService.open({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, new PaperLedgerStore({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, { baseDir: b1.dir }));
    assert.equal(svc2.snapshot().processedFills, 1);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); }
});

test('17. snapshot exact routing', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding); reg.register(b2.binding);
    await reg.run('a1', SIG_BG, P);
    assert.equal(reg.snapshot('a1', EXCH_BG).processedFills, 1);
    assert.equal(reg.snapshot('a1', EXCH_BN).processedFills, 0);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('18. invalid exchange in reg rejects', () => {
  const reg = new PaperRuntimeRegistry();
  assert.throws(() => reg.register({ accountId: 'x', exchange: 'nope' as any, pipeline: null as any, service: null as any, coordinator: null as any }), /exchange/);
});

test('19. empty accountId rejects', () => {
  const reg = new PaperRuntimeRegistry();
  assert.throws(() => reg.register({ accountId: '', exchange: EXCH_BG, pipeline: null as any, service: null as any, coordinator: null as any }), /accountId/);
});

test('20. run missing accountId rejects', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    await assert.rejects(() => reg.run('ghost', SIG_BG, P), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('21. snapshot missing binding rejects', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    assert.throws(() => reg.snapshot('ghost', EXCH_BG), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('22. run wrong exchange rejects', async () => {
  const { binding, dir } = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(binding);
    await assert.rejects(() => reg.run('a1', { exchange: EXCH_BN, symbol: 'BTCUSDT', source: 's' }, P), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('23. empty list', () => {
  assert.equal(new PaperRuntimeRegistry().list().length, 0);
});

test('24. same exchange dual account isolated', async () => {
  const b1 = await buildBindingAsync('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await buildBindingAsync('a2', EXCH_BG, 50_000, 'BTCUSDT', 'long');
  try {
    const reg = new PaperRuntimeRegistry(); reg.register(b1.binding); reg.register(b2.binding);
    await reg.run('a1', SIG_BG, P); await reg.run('a2', SIG_BG, P);
    assert.equal(reg.snapshot('a1', EXCH_BG).processedFills, 1);
    assert.equal(reg.snapshot('a2', EXCH_BG).processedFills, 1);
    assert.ok(reg.snapshot('a1', EXCH_BG).cashUsd < 100_000);
    assert.ok(reg.snapshot('a2', EXCH_BG).cashUsd < 50_000);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});
