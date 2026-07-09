/**
 * tests/unit/decision-engine.test.ts
 * Step 2A.5: DecisionEngine 单元测试
 * 纯函数测试，不依赖 FastPipeline / daemon.py / Python
 *
 * 运行: npx ts-node tests/unit/decision-engine.test.ts
 */

import { evaluate } from '../../src/pipeline/DecisionEngine';
import type { EngineInput, EngineOutput } from '../../src/pipeline/DecisionEngine';
import type { IndicatorResult } from '../../src/types/indicators';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

function makeInput(overrides: Partial<EngineInput> & { symbol: string }): EngineInput {
  return {
    indicators: [],
    bias: null,
    ...overrides,
  };
}

function makeMomentumResult(
  regime: string,
  score: number,
  inCooldown: boolean = false,
): IndicatorResult {
  return {
    name: 'CompositeMomentum',
    composite_score: score,
    regime_state: regime as any,
    in_cooldown: inCooldown,
    dimension_scores: {
      hull_big_trend: { score: 0 },
      stc_momentum: { score: 0 },
      volume_micro: { score: 0, strength: 'WEAK' },
    },
    lag_bars: 0,
  } as unknown as IndicatorResult;
}

function makeOrderBlockResult(
  hasActive: boolean,
  weight: number,
  track: string = 'IDLE',
): IndicatorResult {
  return {
    name: 'SmartOrderBlock',
    has_active_ob: hasActive,
    ob_strength_weight: weight,
    active_obs: hasActive ? 1 : 0,
    total_obs: 0,
    nearest_bullish_ob: null,
    nearest_bearish_ob: null,
    phase3_bridge_signal: { confluence_triggered: hasActive && weight > 0.3, suggested_track: track as any },
    lag_bars: 0,
  } as unknown as IndicatorResult;
}

function run(testName: string, input: EngineInput, expected: Partial<EngineOutput>): void {
  const result = evaluate(input);
  const ok =
    result.decision === expected.decision &&
    result.direction === (expected.direction ?? result.direction);
  assert(ok, testName);
  if (!ok) {
    console.error(`    got:      decision=${result.decision}, direction=${result.direction}, reason=${result.reason}`);
    console.error(`    expected: decision=${expected.decision}, direction=${expected.direction ?? '?'}`);
  }
}

// ═══════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════

// Case 1: 无 bias → skip
run('Case 1: No bias → skip',
  makeInput({ symbol: 'BTC/USDT', bias: null }),
  { decision: 'skip' }
);

// Case 2: Bias direction = hold → skip
run('Case 2: Bias hold → skip',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'hold', confidence: 80 },
    indicators: [makeMomentumResult('STRONG_BULLISH', 85)],
  }),
  { decision: 'skip' }
);

// Case 3: Momentum = NEUTRAL → skip
run('Case 3: Neutral momentum → skip',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'long', confidence: 80 },
    indicators: [makeMomentumResult('NEUTRAL', 50)],
  }),
  { decision: 'skip' }
);

// Case 4: STRONG_BULLISH + OB + bias long → trade long
run('Case 4: Strong Bullish + OB → trade long',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'long', confidence: 80 },
    indicators: [
      makeMomentumResult('STRONG_BULLISH', 85),
      makeOrderBlockResult(true, 0.5, 'FAST_TRACK'),
    ],
  }),
  { decision: 'trade', direction: 'long' }
);

// Case 5: STRONG_BULLISH + no OB → defense
run('Case 5: Strong Bullish + no OB → defense',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'long', confidence: 80 },
    indicators: [
      makeMomentumResult('STRONG_BULLISH', 75),
      makeOrderBlockResult(false, 0),
    ],
  }),
  { decision: 'defense' }
);

// Case 6: STRONG_BEARISH + OB + bias short → trade short
run('Case 6: Strong Bearish + OB → trade short',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'short', confidence: 80 },
    indicators: [
      makeMomentumResult('STRONG_BEARISH', 15),
      makeOrderBlockResult(true, 0.5, 'SLOW_TRACK'),
    ],
  }),
  { decision: 'trade', direction: 'short' }
);

// Case 7: STRONG_BEARISH + no OB → defense
run('Case 7: Strong Bearish + no OB → defense',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'short', confidence: 80 },
    indicators: [
      makeMomentumResult('STRONG_BEARISH', 25),
      makeOrderBlockResult(false, 0),
    ],
  }),
  { decision: 'defense' }
);

// Case 8: Momentum cooldown → skip
run('Case 8: Cooldown → skip',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'long', confidence: 80 },
    indicators: [makeMomentumResult('STRONG_BULLISH', 85, true)],
  }),
  { decision: 'skip' }
);

// Case 9: Low confidence → skip
run('Case 9: Low confidence (< 60) → skip',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'long', confidence: 45 },
    indicators: [makeMomentumResult('STRONG_BULLISH', 85)],
  }),
  { decision: 'skip' }
);

// Case 10: WEAK_BULLISH (non-strong) → skip
run('Case 10: Weak Bullish → skip',
  makeInput({
    symbol: 'BTC/USDT',
    bias: { direction: 'long', confidence: 70 },
    indicators: [makeMomentumResult('WEAK_BULLISH', 60)],
  }),
  { decision: 'skip' }
);

// ═══════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════

const total = passed + failed;
console.log(`\n=== DecisionEngine Test Results ===`);
console.log(`  Total: ${total}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests PASSED`);
}
