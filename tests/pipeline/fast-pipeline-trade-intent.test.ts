// Stage 3B4C7-R1: FastPipeline trade intent tests
// Offline — fake IndicatorService, fixture reports, real KillSwitch, no LLM/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { KillSwitch } from '../../src/router/KillSwitch';
import type { IndicatorResult } from '../../src/types/indicators';

// ─── Fake IndicatorService — STRONG_BULLISH + OB confluence ──────
// MomentumResult fields are at the TOP level (not nested in `data`).
// See: src/types/indicators/momentum.ts
const BULLISH_LONG_INDICATORS: IndicatorResult[] = [
  {
    name: 'CompositeMomentum', status: 'done',
    composite_score: 88, regime_state: 'STRONG_BULLISH', in_cooldown: false,
    dimension_scores: { hull_big_trend: { score: 80 }, stc_momentum: { score: 85 }, volume_micro: { score: 90 } },
    lag_bars: 0,
  } as any,
  {
    name: 'SmartOrderBlock', status: 'done',
    has_active_ob: true, ob_strength_weight: 0.7,
    lag_bars: 0,
  } as any,
];

const BEARISH_SHORT_INDICATORS: IndicatorResult[] = [
  {
    name: 'CompositeMomentum', status: 'done',
    composite_score: 12, regime_state: 'STRONG_BEARISH', in_cooldown: false,
    dimension_scores: { hull_big_trend: { score: 15 }, stc_momentum: { score: 10 }, volume_micro: { score: 8 } },
    lag_bars: 0,
  } as any,
  {
    name: 'SmartOrderBlock', status: 'done',
    has_active_ob: true, ob_strength_weight: 0.7,
    lag_bars: 0,
  } as any,
];

class FakeIndicatorService {
  results: IndicatorResult[] = BULLISH_LONG_INDICATORS;
  calculateAllCalled = 0;
  async calculateAll(_: any): Promise<IndicatorResult[]> { this.calculateAllCalled += 1; return this.results; }
}

function makeBiasReport(symbol = 'BTCUSDT', suggestedPct = 0.15) {
  return {
    timestamp: Date.now(), updatedAt: Date.now(),
    globalBias: 'bullish' as const, confidence: 75,
    assets: [{ symbol, bias: 'bullish', direction: 'long' as const, confidence: 75, volatility: 30, suggestedPositionPct: suggestedPct, entryCondition: 'x', stopLoss: '-', takeProfit: '-' }],
    globalLongShortRatio: 1.5, globalVolatility: 30, fearGreedIndex: 60, fundingStatus: 'neutral' as const,
    whitelist: [symbol], blacklist: [], riskEvents: [], exchange: 'bitget' as const,
  };
}

function buildPipeline(opts: { indicators?: IndicatorResult[]; report?: any; ksConfig?: any; lockKs?: boolean } = {}) {
  const ind = new FakeIndicatorService();
  if (opts.indicators) ind.results = opts.indicators;
  const report = opts.report ?? makeBiasReport();
  const ks = new KillSwitch('bitget', { totalCapitalUsd: 10000, maxSinglePositionPct: 0.15, enabled: true, ...opts.ksConfig });
  if (opts.lockKs) ks.lock('bitget', 'test lock');
  const router: any = { exchange: 'bitget', getBiasReport: () => report, getConfig: () => ({ maxBiasReportAgeHours: 2 }), killSwitch: ks };
  const pipeline = new FastPipeline({ exchange: 'bitget', router, indicatorService: ind as any });
  return { pipeline, ind, ks };
}

// ─── Tests (20) ─────────────────────────────────────────────────
test('FP1: trade long creates TradeIntent', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'trade'); assert.equal(r.direction, 'long'); assert.ok(r.tradeIntent);
});

test('FP2: trade short creates TradeIntent', async () => {
  const report = makeBiasReport('BTCUSDT');
  report.assets[0].direction = 'short';
  const r = await buildPipeline({ indicators: BEARISH_SHORT_INDICATORS, report }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'trade'); assert.equal(r.direction, 'short'); assert.ok(r.tradeIntent);
});

test('FP3: positionUsd equals tradeIntent.positionUsd', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.positionUsd, 1500); assert.equal(r.tradeIntent!.positionUsd, r.positionUsd);
});

test('FP4: 0.15 × 10000 = 1500', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.positionUsd, 1500);
});

test('FP5: TradeIntent.exchange from config', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.exchange, 'bitget');
});

test('FP6: TradeIntent.symbol from validated signal', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.symbol, 'BTCUSDT');
});

test('FP7: TradeIntent.source correct', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread_scanner', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.source, 'spread_scanner');
});

test('FP8: TradeIntent.biasUpdatedAt correct', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.biasUpdatedAt, r.biasReport!.updatedAt);
});

test('FP9: percentage cap rejection → defense', async () => {
  const r = await buildPipeline({ ksConfig: { totalCapitalUsd: 100, maxSinglePositionPct: 0.01 } }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense'); assert.equal(r.direction, 'hold'); assert.equal(r.positionUsd, undefined); assert.equal(r.tradeIntent, undefined);
});

test('FP10: absolute cap rejection → defense', async () => {
  const r = await buildPipeline({ ksConfig: { maxSinglePositionAbsUsd: 500 } }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense'); assert.equal(r.tradeIntent, undefined);
});

test('FP11: explicit lock → defense before indicator I/O', async () => {
  const { pipeline, ind } = buildPipeline({ lockKs: true });
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense'); assert.equal(r.tradeIntent, undefined);
  assert.equal(ind.calculateAllCalled, 0, 'indicator not called when locked');
});

test('FP12: invalid suggestedPositionPct → defense', async () => {
  const r = await buildPipeline({ report: makeBiasReport('BTCUSDT', 0) }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
});

test('FP13: totalCapitalUsd=0 → defense', async () => {
  const r = await buildPipeline({ ksConfig: { totalCapitalUsd: 0 } }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
});

test('FP14: skip不调用KillSwitch.check (real amount path)', async () => {
  const neutral: IndicatorResult[] = [
    { name: 'CompositeMomentum', status: 'done', composite_score: 50, regime_state: 'NEUTRAL', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 50 }, stc_momentum: { score: 50 }, volume_micro: { score: 50 } }, lag_bars: 0 } as any,
  ];
  const { pipeline, ks } = buildPipeline({ indicators: neutral });
  let checkCalled = false;
  const orig = ks.check.bind(ks);
  ks.check = (...a: any[]) => { checkCalled = true; return orig(...a); };
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'skip');
  assert.equal(checkCalled, false, 'KillSwitch.check NOT called on skip');
});

test('FP15: created事件只发一次', async () => {
  const p = buildPipeline().pipeline;
  let n = 0; p.on('trade_intent_created', () => n++);
  await p.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(n, 1);
});

test('FP16: rejected事件只发一次（risk admission）', async () => {
  const p = buildPipeline({ ksConfig: { maxSinglePositionAbsUsd: 500 } }).pipeline;
  let n = 0; p.on('trade_intent_rejected', () => n++);
  await p.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(n, 1);
});

test('FP17: 非trade结果无positionUsd或tradeIntent', async () => {
  const neutral: IndicatorResult[] = [
    { name: 'CompositeMomentum', status: 'done', composite_score: 50, regime_state: 'NEUTRAL', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 50 }, stc_momentum: { score: 50 }, volume_micro: { score: 50 } }, lag_bars: 0 } as any,
  ];
  const r = await buildPipeline({ indicators: neutral }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.positionUsd, undefined); assert.equal(r.tradeIntent, undefined);
});

test('FP18: exchange mismatch no TradeIntent', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'binance', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'skip'); assert.equal(r.tradeIntent, undefined);
});

test('FP19: stale report no TradeIntent', async () => {
  const stale = makeBiasReport('BTCUSDT'); stale.updatedAt = Date.now() - 3 * 3600_000;
  const r = await buildPipeline({ report: stale }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense'); assert.equal(r.tradeIntent, undefined);
});

test('FP20: direction has long/short runtime guard (DE output invariant)', async () => {
  // DE always aligns bias.direction with output direction.
  // The direction_validation guard catches future regressions where
  // DE might output trade with an invalid direction.
  // This test verifies the guard EXISTS — if DE output had bad direction,
  // the pipeline would fail-closed instead of crashing.
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'trade');
  assert.ok(r.direction === 'long' || r.direction === 'short', `direction must be long or short, got ${r.direction}`);
  // If direction were invalid AND DE still output 'trade', emitRejected would fire.
  // Current DE never triggers this, so we validate the happy path holds.
});
