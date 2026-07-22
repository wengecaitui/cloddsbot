// Stage 3B4C7-R2: FastPipeline rejection matrix + TradeIntentValidation tests
// Offline — fake IndicatorService, fixture reports, real KillSwitch, no LLM/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { KillSwitch } from '../../src/router/KillSwitch';
import { validateTradeCandidate } from '../../src/pipeline/TradeIntentValidation';
import type { IndicatorResult } from '../../src/types/indicators';

// ─── Fake IndicatorService ──────────────────────────────────────
const BULLISH_LONG_INDICATORS: IndicatorResult[] = [
  { name: 'CompositeMomentum', status: 'done', composite_score: 88, regime_state: 'STRONG_BULLISH', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 80 }, stc_momentum: { score: 85 }, volume_micro: { score: 90 } }, lag_bars: 0 } as any,
  { name: 'SmartOrderBlock', status: 'done', has_active_ob: true, ob_strength_weight: 0.7, lag_bars: 0 } as any,
];
const BEARISH_SHORT_INDICATORS: IndicatorResult[] = [
  { name: 'CompositeMomentum', status: 'done', composite_score: 12, regime_state: 'STRONG_BEARISH', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 15 }, stc_momentum: { score: 10 }, volume_micro: { score: 8 } }, lag_bars: 0 } as any,
  { name: 'SmartOrderBlock', status: 'done', has_active_ob: true, ob_strength_weight: 0.7, lag_bars: 0 } as any,
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
  const report = 'report' in opts ? opts.report : makeBiasReport();
  const ks = new KillSwitch('bitget', { totalCapitalUsd: 10000, maxSinglePositionPct: 0.15, enabled: true, ...opts.ksConfig });
  if (opts.lockKs) ks.lock('bitget', 'test lock');
  const router: any = { exchange: 'bitget', getBiasReport: () => report, getConfig: () => ({ maxBiasReportAgeHours: 2 }), killSwitch: ks };
  const pipeline = new FastPipeline({ exchange: 'bitget', router, indicatorService: ind as any });
  return { pipeline, ind, ks, report };
}

// ─── TradeIntentValidation unit tests (pure function) ──────────
test('VAL1: direction=hold rejected', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'hold', biasDirection: 'long', symbol: 'BTC' });
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.stage, 'direction_validation');
});
test('VAL2: invalid direction rejected', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'foo', biasDirection: 'long', symbol: 'BTC' });
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.stage, 'direction_validation');
});
test('VAL3: trade long + bias short → bias_validation', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'long', biasDirection: 'short', symbol: 'BTC' });
  assert.equal(r.ok, false); if (!r.ok) { assert.equal(r.stage, 'bias_validation'); assert.ok(r.reason.includes('bias.direction')); }
});
test('VAL4: trade short + bias long → bias_validation', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'short', biasDirection: 'long', symbol: 'BTC' });
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.stage, 'bias_validation');
});
test('VAL5: missing bias → bias_validation', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'short', biasDirection: undefined, symbol: 'BTC' });
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.stage, 'bias_validation');
});
test('VAL6: normal long candidate ok', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'long', biasDirection: 'long', symbol: 'BTC' });
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.direction, 'long');
});
test('VAL7: normal short candidate ok', () => {
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'short', biasDirection: 'short', symbol: 'BTC' });
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.direction, 'short');
});

// ─── FastPipeline rejection matrix tests ───────────────────────
test('FP-A1: direction_validation branch reachable through validateTradeCandidate (VAL1-VAL2)', () => {
  // The FastPipeline direction_validation path is not triggerable via
  // current DecisionEngine (DE always aligns direction with regime).
  // Covered by VAL1/VAL2 which test validateTradeCandidate directly.
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'hold', biasDirection: 'long', symbol: 'BTC' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.stage, 'direction_validation');
});

test('FP-A2: bias_validation (missing bias) — covered via pure function', () => {
  // DE returns skip when bias is missing, so the FastPipeline
  // validateTradeCandidate call-site is not reachable for missing-bias.
  // The validateTradeCandidate pure function IS exercised and wired in
  // FastPipeline.decide() — this test verifies the function directly.
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'long', biasDirection: undefined, symbol: 'BTC' });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.stage, 'bias_validation'); assert.ok(r.reason.includes('no bias asset')); }
});

test('FP-A3: bias_validation (direction mismatch) — covered via pure function', () => {
  // DE aligns direction with regime internally, so it never outputs
  // trade/long when bias is 'short'. The validateTradeCandidate guard
  // prevents future regressions if DE rules change.
  const r = validateTradeCandidate({ engineDecision: 'trade', engineDirection: 'long', biasDirection: 'short', symbol: 'BTC' });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.stage, 'bias_validation'); assert.ok(r.reason.includes('bias.direction')); }
});

// ─── Position sizing rejection event tests ─────────────────────
test('FP-B1: suggestedPct=0 → defense, stage=position_sizing, no requestedPositionUsd', async () => {
  const { pipeline } = buildPipeline({ report: makeBiasReport('BTCUSDT', 0) });
  let rejections: any[] = [];
  pipeline.on('trade_intent_rejected', (e) => rejections.push(e));
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].stage, 'position_sizing');
  assert.equal(rejections[0].requestedPositionUsd, undefined);
});

test('FP-B2: totalCapital=0 → defense, stage=position_sizing, no requestedPositionUsd', async () => {
  const { pipeline } = buildPipeline({ ksConfig: { totalCapitalUsd: 0 } });
  let rejections: any[] = [];
  pipeline.on('trade_intent_rejected', (e) => rejections.push(e));
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].stage, 'position_sizing');
  assert.equal(rejections[0].requestedPositionUsd, undefined);
});

// ─── Risk admission rejection event tests ──────────────────────
test('FP-C1: percentage cap → stage=risk_admission, requestedPositionUsd present, exactly once', async () => {
  const { pipeline } = buildPipeline({ ksConfig: { totalCapitalUsd: 100, maxSinglePositionPct: 0.01 } });
  let rejections: any[] = [];
  pipeline.on('trade_intent_rejected', (e) => rejections.push(e));
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].stage, 'risk_admission');
  assert.ok(typeof rejections[0].requestedPositionUsd === 'number');
  assert.ok(rejections[0].reason.includes('percentage limit exceeded') || rejections[0].reason.includes('percentage'));
});

test('FP-C2: absolute cap → stage=risk_admission, reason contains absolute limit', async () => {
  const { pipeline } = buildPipeline({ ksConfig: { maxSinglePositionAbsUsd: 500 } });
  let rejections: any[] = [];
  pipeline.on('trade_intent_rejected', (e) => rejections.push(e));
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].stage, 'risk_admission');
  assert.ok(rejections[0].reason.includes('absolute limit'));
});

// ─── Intent creation exception test ────────────────────────────
test('FP-D1: biasUpdatedAt=NaN → defense, stage=intent_creation, requestedPositionUsd present', async () => {
  const report = makeBiasReport('BTCUSDT');
  report.updatedAt = NaN;
  const { pipeline } = buildPipeline({ report });
  let rejections: any[] = [];
  pipeline.on('trade_intent_rejected', (e) => rejections.push(e));
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(r.direction, 'hold');
  assert.equal(r.positionUsd, undefined);
  assert.equal(r.tradeIntent, undefined);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].stage, 'intent_creation');
  assert.ok(typeof rejections[0].requestedPositionUsd === 'number', 'requestedPositionUsd present for intent_creation failure');
});

// ─── Early guard tests ─────────────────────────────────────────
test('FP-E1: no report → skip, zero indicator/KillSwitch I/O', async () => {
  const { pipeline, ind, ks } = buildPipeline({ report: null });
  let checkCalled = false;
  const orig = ks.check.bind(ks);
  ks.check = (...a: any[]) => { checkCalled = true; return orig(...a); };
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'skip');
  assert.equal(r.tradeIntent, undefined);
  assert.equal(ind.calculateAllCalled, 0);
  assert.equal(checkCalled, false);
});

test('FP-E2: stale report → defense, no TradeIntent', async () => {
  const stale = makeBiasReport('BTCUSDT');
  stale.updatedAt = Date.now() - 3 * 3600_000;
  const r = await buildPipeline({ report: stale }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(r.tradeIntent, undefined);
});

test('FP-E3: exchange mismatch → skip, zero I/O', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'binance', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'skip');
  assert.equal(r.tradeIntent, undefined);
});

test('FP-E4: explicit lock → defense, indicator zero I/O, KS check zero calls', async () => {
  const { pipeline, ind, ks } = buildPipeline({ lockKs: true });
  let checkCalled = false;
  const orig = ks.check.bind(ks);
  ks.check = (...a: any[]) => { checkCalled = true; return orig(...a); };
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'defense');
  assert.equal(r.tradeIntent, undefined);
  assert.equal(ind.calculateAllCalled, 0);
  assert.equal(checkCalled, false);
});

// ─── Happy path trade tests ────────────────────────────────────
test('FP-H1: trade long creates TradeIntent', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'trade'); assert.equal(r.direction, 'long'); assert.ok(r.tradeIntent);
});
test('FP-H2: trade short creates TradeIntent', async () => {
  const report = makeBiasReport('BTCUSDT'); report.assets[0].direction = 'short';
  const r = await buildPipeline({ indicators: BEARISH_SHORT_INDICATORS, report }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'trade'); assert.equal(r.direction, 'short'); assert.ok(r.tradeIntent);
});
test('FP-H3: positionUsd equals tradeIntent.positionUsd', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.positionUsd, 1500); assert.equal(r.tradeIntent!.positionUsd, 1500);
});
test('FP-H4: 0.15 × 10000 = 1500', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.positionUsd, 1500);
});
test('FP-H5: TradeIntent.exchange from config', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.exchange, 'bitget');
});
test('FP-H6: TradeIntent.symbol from validated signal', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.symbol, 'BTCUSDT');
});
test('FP-H7: TradeIntent.source correct', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread_scanner', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.source, 'spread_scanner');
});
test('FP-H8: TradeIntent.biasUpdatedAt correct', async () => {
  const r = await buildPipeline().pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.tradeIntent!.biasUpdatedAt, r.biasReport!.updatedAt);
});
test('FP-H9: created event fires exactly once', async () => {
  const p = buildPipeline().pipeline; let n = 0; p.on('trade_intent_created', () => n++);
  await p.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(n, 1);
});
test('FP-H10: skip决策不调用KillSwitch.check', async () => {
  const neutral: IndicatorResult[] = [
    { name: 'CompositeMomentum', status: 'done', composite_score: 50, regime_state: 'NEUTRAL', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 50 }, stc_momentum: { score: 50 }, volume_micro: { score: 50 } }, lag_bars: 0 } as any,
  ];
  const { pipeline, ks } = buildPipeline({ indicators: neutral });
  let checkCalled = false;
  const orig = ks.check.bind(ks);
  ks.check = (...a: any[]) => { checkCalled = true; return orig(...a); };
  const r = await pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.decision, 'skip');
  assert.equal(checkCalled, false);
});
test('FP-H11: 非trade结果无positionUsd或tradeIntent', async () => {
  const neutral: IndicatorResult[] = [
    { name: 'CompositeMomentum', status: 'done', composite_score: 50, regime_state: 'NEUTRAL', in_cooldown: false, dimension_scores: { hull_big_trend: { score: 50 }, stc_momentum: { score: 50 }, volume_micro: { score: 50 } }, lag_bars: 0 } as any,
  ];
  const r = await buildPipeline({ indicators: neutral }).pipeline.execute({ exchange: 'bitget', source: 'spread', symbol: 'BTCUSDT' });
  assert.equal(r.positionUsd, undefined);
  assert.equal(r.tradeIntent, undefined);
});
