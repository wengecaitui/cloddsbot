// Stage 3B4C7: PositionSizer — deterministic pure function
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePositionUsd } from '../../src/pipeline/PositionSizer';

// 1. 10000 × 0.15 = 1500.00
test('1. basic 10000 × 0.15 = 1500.00', () => {
  assert.equal(computePositionUsd({ totalCapitalUsd: 10000, suggestedPositionPct: 0.15 }), 1500.00);
});

// 2. 小数正确 round to cents
test('2. rounding to cents', () => {
  assert.equal(computePositionUsd({ totalCapitalUsd: 9999.99, suggestedPositionPct: 0.12345 }), 1234.50);
  assert.equal(computePositionUsd({ totalCapitalUsd: 1000, suggestedPositionPct: 0.001 }), 1.00);
  assert.equal(computePositionUsd({ totalCapitalUsd: 1000, suggestedPositionPct: 0.0015 }), 1.50);
});

// 3. totalCapitalUsd = 0 rejected
test('3. totalCapitalUsd = 0 throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: 0, suggestedPositionPct: 0.15 }),
    /totalCapitalUsd must be > 0/,
  );
});

// 4. totalCapitalUsd < 0 rejected
test('4. totalCapitalUsd < 0 throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: -1000, suggestedPositionPct: 0.15 }),
    /totalCapitalUsd must be > 0/,
  );
});

// 5. totalCapitalUsd NaN rejected
test('5. totalCapitalUsd NaN throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: NaN, suggestedPositionPct: 0.15 }),
    /totalCapitalUsd must be a finite number/,
  );
});

// 6. suggestedPct = 0 rejected
test('6. suggestedPct = 0 throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: 10000, suggestedPositionPct: 0 }),
    /suggestedPositionPct must be in \(0, 1\]/,
  );
});

// 7. suggestedPct < 0 rejected
test('7. suggestedPct < 0 throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: 10000, suggestedPositionPct: -0.1 }),
    /suggestedPositionPct must be in \(0, 1\]/,
  );
});

// 8. suggestedPct > 1 rejected
test('8. suggestedPct > 1 throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: 10000, suggestedPositionPct: 1.5 }),
    /suggestedPositionPct must be in \(0, 1\]/,
  );
});

// 9. suggestedPct NaN rejected
test('9. suggestedPct NaN throws', () => {
  assert.throws(
    () => computePositionUsd({ totalCapitalUsd: 10000, suggestedPositionPct: NaN }),
    /suggestedPositionPct must be a finite number/,
  );
});

// 10. 相同输入产生相同输出（确定性）
test('10. deterministic — same input = same output', () => {
  const a = computePositionUsd({ totalCapitalUsd: 20000, suggestedPositionPct: 0.1 });
  const b = computePositionUsd({ totalCapitalUsd: 20000, suggestedPositionPct: 0.1 });
  assert.equal(a, b);
  assert.equal(a, 2000.00);
});
