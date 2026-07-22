// Stage 3B4C7-R1: PositionSizer — deterministic pure function
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePositionUsd } from '../../src/pipeline/PositionSizer';

const DEFAULT = { totalCapitalUsd: 10000, suggestedPositionPct: 0.15, symbol: 'BTCUSDT', direction: 'long' as const };

// 1. 10000 × 0.15 = 1500.00
test('1. basic 10000 × 0.15 = 1500.00', () => {
  assert.equal(computePositionUsd(DEFAULT), 1500.00);
});

// 2. 小数正确 round to nearest cent
test('2. rounding to nearest cent', () => {
  assert.equal(computePositionUsd({ ...DEFAULT, totalCapitalUsd: 9999.99, suggestedPositionPct: 0.12345 }), 1234.50);
  assert.equal(computePositionUsd({ ...DEFAULT, totalCapitalUsd: 1000, suggestedPositionPct: 0.001 }), 1.00);
  assert.equal(computePositionUsd({ ...DEFAULT, totalCapitalUsd: 1000, suggestedPositionPct: 0.0015 }), 1.50);
});

// 3. totalCapitalUsd = 0 rejected
test('3. totalCapitalUsd = 0 throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, totalCapitalUsd: 0 }), /totalCapitalUsd must be > 0/);
});

// 4. totalCapitalUsd < 0 rejected
test('4. totalCapitalUsd < 0 throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, totalCapitalUsd: -1000 }), /totalCapitalUsd must be > 0/);
});

// 5. totalCapitalUsd NaN rejected
test('5. totalCapitalUsd NaN throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, totalCapitalUsd: NaN }), /totalCapitalUsd must be a finite number/);
});

// 6. suggestedPct = 0 rejected
test('6. suggestedPct = 0 throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, suggestedPositionPct: 0 }), /suggestedPositionPct must be in \(0, 1\]/);
});

// 7. suggestedPct < 0 rejected
test('7. suggestedPct < 0 throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, suggestedPositionPct: -0.1 }), /suggestedPositionPct must be in \(0, 1\]/);
});

// 8. suggestedPct > 1 rejected
test('8. suggestedPct > 1 throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, suggestedPositionPct: 1.5 }), /suggestedPositionPct must be in \(0, 1\]/);
});

// 9. suggestedPct NaN rejected
test('9. suggestedPct NaN throws', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, suggestedPositionPct: NaN }), /suggestedPositionPct must be a finite number/);
});

// 10. 相同输入产生相同输出（确定性）
test('10. deterministic — same input = same output', () => {
  const a = computePositionUsd({ totalCapitalUsd: 20000, suggestedPositionPct: 0.1, symbol: 'ETHUSDT', direction: 'short' });
  const b = computePositionUsd({ totalCapitalUsd: 20000, suggestedPositionPct: 0.1, symbol: 'ETHUSDT', direction: 'short' });
  assert.equal(a, b);
  assert.equal(a, 2000.00);
});

// R1: symbol validation
test('11. symbol must be non-empty string', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, symbol: '' }), /symbol must be a non-empty string/);
});

// R1: direction validation
test('12. direction must be long or short', () => {
  assert.throws(() => computePositionUsd({ ...DEFAULT, direction: 'hold' as any }), /direction must be 'long' or 'short'/);
  assert.throws(() => computePositionUsd({ ...DEFAULT, direction: 'skip' as any }), /direction must be 'long' or 'short'/);
});
