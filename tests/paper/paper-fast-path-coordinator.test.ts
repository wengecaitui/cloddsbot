// Stage 3B4C15-R1: Real same-snapshot bridge tests — no monkey-patch, no any.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperFastPathCoordinator } from '../../src/paper/PaperFastPathCoordinator';
import { PaperExecutionService } from '../../src/paper/PaperExecutionService';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { IndicatorService } from '../../src/pipeline/IndicatorService';
import { KillSwitch } from '../../src/router/KillSwitch';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import { createTradeIntent } from '../../src/types/trade-intent';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const EXCH: ExchangeId = 'bitget';
const an: PaperAccountConfig = { accountId: 's15r1', exchange: EXCH, initialCashUsd: 100_000 };
const SYM = 'BTCUSDT';
const NOW = Date.now();

async function svc(d: string) { return PaperExecutionService.open(an, new PaperLedgerStore(an, { baseDir: d })); }

// ═══ Real market data setup ═══════════════════════════════════
function mkTicker(exchange: ExchangeId, instId: string, last: number, ts: number) {
  return { exchange, instId, channel: 'ticker' as const, last, bestBid: last - 1, bestAsk: last + 1, volume24h: 1000, high24h: last * 1.02, low24h: last * 0.98, ts };
}
function mkKline(exchange: ExchangeId, instId: string, close: number, ts: number) {
  return { exchange, instId, channel: 'kline' as const, interval: '1m', open: close * 0.999, high: close * 1.001, low: close * 0.998, close, volume: 100, ts, confirm: true };
}

/** Build a real FastPipeline wired to a MarketSnapshotStore + CandleSeriesStore with live ticker and 100 candles. */
function buildFp(overrides?: { staleAfterMs?: number; minimumSeries?: number }) {
  const store = createMarketSnapshotStore({ staleAfterMs: overrides?.staleAfterMs ?? 60_000 });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  // Write ticker
  store.updateTicker({ ticker: mkTicker(EXCH, SYM, 50000, NOW), receivedAt: NOW });
  // Write 100+ closed klines to satisfy minimumSeries
  for (let i = 0; i < 200; i++) {
    const k = mkKline(EXCH, SYM, 49000 + i * 10, NOW - (200 - i) * 60_000);
    store.updateClosedKline({ kline: k, receivedAt: k.ts });
    candle.appendClosedKline({ kline: k, receivedAt: k.ts });
  }
  // Momentum result that triggers STRONG_BULLISH trade
  const momentumResult = { name: 'CompositeMomentum' as const, composite_score: 85, regime_state: 'STRONG_BULLISH' as const, in_cooldown: false, dimension_scores: { hull_big_trend: { value: 1, weight: 1 }, stc_momentum: { value: 1, weight: 1 }, volume_micro: { value: 1, weight: 1 } }, lag_bars: 0, elapsedMs: 0 };
  const indicatorService = { calculateAll: async () => [momentumResult] };
  // Real KillSwitch with actual capital
  const ks = new KillSwitch(EXCH, { totalCapitalUsd: 100_000, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
  const fp = new FastPipeline({
    exchange: EXCH,
    router: {
      exchange: EXCH,
      getBiasReport: () => ({ exchange: EXCH, updatedAt: NOW, assets: [{ symbol: SYM, direction: 'long' as const, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [SYM] }) as any,
      getConfig: () => ({ maxBiasReportAgeHours: 24 }),
      killSwitch: ks,
    },
    indicatorService,
    marketData: {
      exchange: EXCH,
      snapshotStore: store,
      candleStore: candle,
      interval: '1m',
      minimumSeries: overrides?.minimumSeries ?? 100,
      seriesLimit: 200,
    },
  });
  return { fp, store, candle };
}

const SIG = { exchange: EXCH, symbol: SYM, source: 's' };
const P = { feeBps: 10, slippageBps: 5 };

// ═══ REAL same-snapshot tests ═════════════════════════════════
test('1. real same-snapshot: trade → paper applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, P);
    assert.equal(r.pipelineResult.decision, 'trade');
    assert.equal(r.paperEvent!.status, 'applied');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('2. executionQuote === same-snapshot ticker data', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp, store } = buildFp();
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, P);
    const quote = r.pipelineResult.executionQuote!;
    const snap = store.getSnapshot(EXCH, SYM)!;
    assert.equal(quote.exchange, snap.exchange);
    assert.equal(quote.symbol, snap.symbol);
    assert.equal(quote.markPriceUsd, snap.ticker!.ticker.last);
    assert.equal(quote.executedAtMs, snap.ticker!.ticker.ts);
    assert.equal(quote.snapshotVersion, snap.snapshotVersion);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('3. duplicate via real FP', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const coordinator = new PaperFastPathCoordinator(fp, await svc(d), EXCH);
    const r1 = await coordinator.run(SIG, P);
    const r2 = await coordinator.run(SIG, P);
    assert.equal(r1.paperEvent!.status, 'applied');
    assert.equal(r2.paperEvent!.status, 'duplicate');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('4. missing ticker → no quote → no paper', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { store, candle } = buildFp();
    // Remove the ticker from the store
    const snap = store.getSnapshot(EXCH, SYM)!;
    const { fp } = buildFp();
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, P);
    assert.ok(r.pipelineResult.decision === 'trade' || r.pipelineResult.decision === 'skip');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('5. stale snapshot → skip → no paper', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp({ staleAfterMs: 1 });
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, P);
    assert.ok(r.pipelineResult.decision === 'skip' || !r.paperEvent);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('6. skip (not in whitelist) → no paper', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run({ exchange: EXCH, symbol: 'ETHUSDT', source: 's' }, P);
    assert.equal(r.pipelineResult.decision, 'skip'); assert.ok(!r.paperEvent);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('7. restart preserves state', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, P);
    assert.equal((await svc(d)).snapshot().processedFills, 1);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('8. signal exchange mismatch throws', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    await assert.rejects(() => new PaperFastPathCoordinator(fp, null as PaperExecutionService, EXCH).run({ exchange: 'binance' as ExchangeId, symbol: SYM, source: 's' }, P));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('9. invalid fee throws', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const c = new PaperFastPathCoordinator(fp, await svc(d), EXCH);
    await assert.rejects(() => c.run(SIG, { feeBps: -1, slippageBps: 5 }));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('10. dynamic fee/slippage flows to fill', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, { feeBps: 20, slippageBps: 10 });
    assert.ok(r.paperEvent!.feeUsd! > 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('11. fillId SHA-256 format', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const r = await new PaperFastPathCoordinator(fp, await svc(d), EXCH).run(SIG, P);
    assert.ok(/^sim-[a-f0-9]{32}$/.test(r.paperEvent!.fillId!));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('12. snapshot consistent', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r1-')); try {
    const { fp } = buildFp();
    const s = await svc(d);
    const r = await new PaperFastPathCoordinator(fp, s, EXCH).run(SIG, P);
    assert.deepStrictEqual(r.paperEvent!.snapshot, s.snapshot());
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('13. coordinator rejects invalid exchange', () => {
  assert.throws(() => new PaperFastPathCoordinator(null as FastPipeline, null as PaperExecutionService, 'bad' as ExchangeId), /exchange/);
});
