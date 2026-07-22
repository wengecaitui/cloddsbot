// Stage 3B4C7: KillSwitch explicit lock semantics
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KillSwitch } from '../../src/router/KillSwitch';
import type { KillSwitchConfig } from '../../src/router/KillSwitch';

function makeKs(overrides: Partial<KillSwitchConfig> = {}): KillSwitch {
  return new KillSwitch('bitget', {
    maxSinglePositionPct: 0.15,
    totalCapitalUsd: 10000,
    writeActionTimeoutSec: 1.5,
    enabled: true,
    ...overrides,
  });
}

// 1. 1500 在 15% 上限内允许
test('1. 1500 within 15% limit = allowed', () => {
  const ks = makeKs();
  assert.equal(ks.check('bitget', 'BTCUSDT', 1500).allowed, true);
});

// 2. 1500.01 超出后拒绝
test('2. 1500.01 exceeds 15% limit = rejected', () => {
  const ks = makeKs();
  const result = ks.check('bitget', 'BTCUSDT', 1500.01);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('exceeds single-position limit'));
});

// 3. absolute cap 比百分比 cap 更低时生效
test('3. absolute cap lower than pct cap wins', () => {
  const ks = makeKs({ maxSinglePositionAbsUsd: 500 });
  const result = ks.check('bitget', 'BTCUSDT', 600);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('500'));
});

// 4. locked 状态拒绝
test('4. locked state rejects check()', () => {
  const ks = makeKs();
  ks.lock('bitget', 'timeout');
  const result = ks.check('bitget', 'BTCUSDT', 100);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('locked') && result.reason?.includes('timeout'));
});

// 5. locked + enabled=false 仍拒绝
test('5. locked with enabled=false still rejects', () => {
  const ks = makeKs({ enabled: false });
  ks.lock('bitget', 'timeout');
  const result = ks.check('bitget', 'BTCUSDT', 100);
  assert.equal(result.allowed, false);
});

// 6. unlock 后恢复
test('6. unlock restores check()', () => {
  const ks = makeKs();
  ks.lock('bitget', 'timeout');
  ks.unlock('bitget');
  assert.equal(ks.check('bitget', 'BTCUSDT', 100).allowed, true);
  // snapshot after unlock
  const snap = ks.snapshot('bitget');
  assert.equal(snap.isTriggered, false);
  assert.equal(snap.triggerReason, undefined);
});

// 7. lock reason 精确保留
test('7. lock reason precisely preserved in snapshot', () => {
  const ks = makeKs();
  ks.lock('bitget', 'Write-Action timeout: 1.5s exceeded');
  const snap = ks.snapshot('bitget');
  assert.equal(snap.isTriggered, true);
  assert.equal(snap.triggerReason, 'Write-Action timeout: 1.5s exceeded');
});

// 8. recordLoss 锁定原因精确保留
test('8. recordLoss lock reason precise', () => {
  const ks = makeKs({ dailyMaxLossUsd: 200 });
  ks.recordLoss('bitget', 250);
  const result = ks.check('bitget', 'BTCUSDT', 10);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('locked') || result.reason?.includes('Daily loss'));
  const snap = ks.snapshot('bitget');
  assert.equal(snap.isTriggered, true);
  assert.ok(snap.triggerReason?.includes('Daily loss'));
});

// 9. NaN positionUsd 拒绝
test('9. NaN positionUsd rejected', () => {
  const ks = makeKs();
  const result = ks.check('bitget', 'BTCUSDT', NaN);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('finite positive number'));
});

// 10. Infinity 拒绝
test('10. Infinity rejected', () => {
  const ks = makeKs();
  const result = ks.check('bitget', 'BTCUSDT', Infinity);
  assert.equal(result.allowed, false);
});

// 11. 负数拒绝
test('11. negative positionUsd rejected', () => {
  const ks = makeKs();
  const result = ks.check('bitget', 'BTCUSDT', -100);
  assert.equal(result.allowed, false);
});

// 12. zero 拒绝
test('12. zero positionUsd rejected', () => {
  const ks = makeKs();
  const result = ks.check('bitget', 'BTCUSDT', 0);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes('finite positive number'));
});

// 13. exchange mismatch 零状态变更
test('13. exchange mismatch rejects with no state change', () => {
  const ks = makeKs();
  assert.throws(
    () => ks.check('binance', 'BTCUSDT', 100),
    /exchange mismatch/,
  );
  // Previous lock state unchanged
  assert.equal(ks.check('bitget', 'BTCUSDT', 100).allowed, true);
});
