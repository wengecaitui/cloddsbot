// Stage 3B4C9: Fill Simulator tests — deterministic, no I/O, no randomness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateFill } from '../../src/paper/FillSimulator';
import type { TradeIntent } from '../../src/types/trade-intent';

const BASE_INTENT: TradeIntent = {
  exchange: 'bitget', symbol: 'BTCUSDT', direction: 'long',
  positionUsd: 1500, orderType: 'market',
  source: 'spread', createdAt: 1000, reason: 'test', biasUpdatedAt: 1000,
};
const BASE_CONFIG = { markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000 };

// 1. basic long buy
test('1. long intent → buy fill', () => {
  const r = simulateFill(BASE_INTENT, BASE_CONFIG, 0);
  assert.equal(r.fill.side, 'buy');
  assert.equal(r.fill.symbol, 'BTCUSDT');
  assert.equal(r.fill.exchange, 'bitget');
});

// 2. short intent → sell fill
test('2. short intent → sell fill', () => {
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, BASE_CONFIG, 0);
  assert.equal(r.fill.side, 'sell');
});

// 3. fillId deterministic
test('3. fillId deterministic per counter', () => {
  const r1 = simulateFill(BASE_INTENT, BASE_CONFIG, 1);
  const r2 = simulateFill(BASE_INTENT, BASE_CONFIG, 1);
  assert.equal(r1.fill.fillId, r2.fill.fillId);
  assert.equal(r1.fill.fillId, 'sim-BTCUSDT-1');
  const r3 = simulateFill(BASE_INTENT, BASE_CONFIG, 2);
  assert.equal(r3.fill.fillId, 'sim-BTCUSDT-2');
});

// 4. price with slippage (long → slightly higher)
test('4. long slippage increases price', () => {
  const r = simulateFill(BASE_INTENT, BASE_CONFIG, 0);
  // markPrice=50000, slippage=5bps → 50000 * (1 + 5/10000) = 50025
  assert.equal(r.executedPriceUsd, 50025);
});

// 5. price with slippage (short → slightly lower)
test('5. short slippage decreases price', () => {
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, BASE_CONFIG, 0);
  assert.equal(r.executedPriceUsd, 49975);
});

// 6. quantity = positionUsd / executedPrice
test('6. quantity from positionUsd / price', () => {
  const r = simulateFill(BASE_INTENT, BASE_CONFIG, 0);
  assert.equal(r.quantity, roundQty(1500 / 50025));
});

// 7. feeUsd from feeBps
test('7. feeUsd = positionUsd × feeBps / 10000', () => {
  const r = simulateFill(BASE_INTENT, { ...BASE_CONFIG, feeBps: 20 }, 0);
  assert.equal(r.feeUsd, 3); // 1500 * 20 / 10000 = 3
});

// 8. same input → same output
test('8. deterministic — fixed config + counter', () => {
  const a = simulateFill(BASE_INTENT, BASE_CONFIG, 5);
  const b = simulateFill(BASE_INTENT, BASE_CONFIG, 5);
  assert.deepStrictEqual(a, b);
});

// 9. zero slippage
test('9. zero slippage', () => {
  const r = simulateFill(BASE_INTENT, { ...BASE_CONFIG, slippageBps: 0 }, 0);
  assert.equal(r.executedPriceUsd, 50000);
  assert.equal(r.quantity, roundQty(1500 / 50000));
});

// 10. zero fee
test('10. zero fee', () => {
  const r = simulateFill(BASE_INTENT, { ...BASE_CONFIG, feeBps: 0 }, 0);
  assert.equal(r.feeUsd, 0);
});

// 11. custom fillIdPrefix
test('11. custom fillIdPrefix', () => {
  const r = simulateFill(BASE_INTENT, { ...BASE_CONFIG, fillIdPrefix: 'prod' }, 7);
  assert.ok(r.fill.fillId.startsWith('prod-'));
});

// 12. fill validates via validatePaperFill
test('12. fill passes validatePaperFill', () => {
  // simulateFill internally calls validatePaperFill
  const r = simulateFill(BASE_INTENT, BASE_CONFIG, 0);
  assert.ok(typeof r.fill.fillId === 'string' && r.fill.fillId.length > 0);
  assert.ok(r.fill.quantity > 0);
  assert.ok(r.fill.priceUsd > 0);
});

// 13. invalid markPrice
test('13. invalid markPrice rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...BASE_CONFIG, markPriceUsd: 0 }, 0));
  assert.throws(() => simulateFill(BASE_INTENT, { ...BASE_CONFIG, markPriceUsd: -50 }, 0));
});

// 14. invalid feeBps
test('14. invalid feeBps rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...BASE_CONFIG, feeBps: -1 }, 0));
});

// 15. invalid slippageBps
test('15. invalid slippageBps rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...BASE_CONFIG, slippageBps: -1 }, 0));
});

// 16. invalid counter
test('16. invalid counter rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, BASE_CONFIG, -1));
});

// 17. large numbers don't overflow
test('17. large numbers compute correctly', () => {
  const r = simulateFill(
    { ...BASE_INTENT, positionUsd: 1_000_000 },
    { markPriceUsd: 65000, feeBps: 15, slippageBps: 100, executedAtMs: 5000 },
    0,
  );
  assert.ok(r.fill.priceUsd > 65000, 'slippage applied');
  assert.ok(r.fill.quantity > 0);
  assert.ok(r.fill.feeUsd > 0);
});

// 18. different counter = different fillId
test('18. counter = uniqueness', () => {
  const r0 = simulateFill(BASE_INTENT, BASE_CONFIG, 0);
  const r1 = simulateFill(BASE_INTENT, BASE_CONFIG, 1);
  assert.notEqual(r0.fill.fillId, r1.fill.fillId);
});

// 19. fill exchange matches intent exchange
test('19. fill.exchange === intent.exchange', () => {
  const r = simulateFill({ ...BASE_INTENT, exchange: 'binance' }, BASE_CONFIG, 0);
  assert.equal(r.fill.exchange, 'binance');
});

// 20. fill symbol matches intent symbol
test('20. fill.symbol === intent.symbol', () => {
  const r = simulateFill({ ...BASE_INTENT, symbol: 'ETHUSDT' }, BASE_CONFIG, 0);
  assert.equal(r.fill.symbol, 'ETHUSDT');
});

// 21. feeBps=1 edge case
test('21. feeBps=1 gives 0.15 fee', () => {
  const r = simulateFill(BASE_INTENT, { ...BASE_CONFIG, feeBps: 1 }, 0);
  assert.equal(r.feeUsd, 0.15);
});

function roundQty(v: number): number {
  return Math.round(v * 1e12) / 1e12;
}
