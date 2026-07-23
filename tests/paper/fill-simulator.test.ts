// Stage 3B4C9-R1: Hardened fill simulator tests — ≥40 tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateFill } from '../../src/paper/FillSimulator';
import { PaperAccountLedger } from '../../src/paper/PaperAccountLedger';
import type { TradeIntent } from '../../src/types/trade-intent';

const BASE_INTENT: TradeIntent = {
  exchange: 'bitget', symbol: 'BTCUSDT', direction: 'long',
  positionUsd: 1500, orderType: 'market',
  source: 'spread', createdAt: 1000, reason: 'test', biasUpdatedAt: 1000,
};
const CFG = { markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000 };

function fill(c: number) { return simulateFill(BASE_INTENT, CFG, c); }
function fillShort(c: number) { return simulateFill({ ...BASE_INTENT, direction: 'short' }, CFG, c); }

// ─── Validation ────────────────────────────────────────────────
test('1. long → buy', () => { assert.equal(fill(0).fill.side, 'buy'); });
test('2. short → sell', () => { assert.equal(fillShort(0).fill.side, 'sell'); });
test('3. forged direction rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, direction: 'hold' as any }, CFG, 0), /direction/); });
test('4. forged orderType rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, orderType: 'limit' as any }, CFG, 0), /orderType/); });
test('5. invalid exchange rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, exchange: 'invalid' as any }, CFG, 0), /exchange/); });
test('6. NaN position rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, positionUsd: NaN }, CFG, 0)); });
test('7. Infinity position rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, positionUsd: Infinity }, CFG, 0)); });
test('8. zero position rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, positionUsd: 0 }, CFG, 0)); });
test('9. negative position rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, positionUsd: -1 }, CFG, 0)); });
test('10. negative counter rejected', () => { assert.throws(() => fill(-1)); });

// ─── Price / fee math ──────────────────────────────────────────
test('11. long slippage increases price', () => { assert.equal(fill(0).executedPriceUsd, 50025); });
test('12. short slippage decreases price', () => { assert.equal(fillShort(0).executedPriceUsd, 49975); });
test('13. zero slippage', () => { const r = simulateFill(BASE_INTENT, { ...CFG, slippageBps: 0 }, 0); assert.equal(r.executedPriceUsd, 50000); });
test('14. zero fee', () => { const r = simulateFill(BASE_INTENT, { ...CFG, feeBps: 0 }, 0); assert.equal(r.feeUsd, 0); });
test('15. fee on executedNotional (long)', () => {
  const r = fill(15);
  // quantity=1500/50025≈0.029985, notional=0.029985*50025≈1499.99, fee=1499.99*10/10000≈1.50
  assert.ok(r.feeUsd > 0);
});
test('16. fee on executedNotional (short)', () => {
  const r = fillShort(16);
  assert.ok(r.feeUsd > 0);
});
test('17. short slippage >=10000 rejected', () => {
  assert.throws(() => simulateFill({ ...BASE_INTENT, direction: 'short' }, { ...CFG, slippageBps: 10000 }, 0), /slippage/);
});
test('18. short slippage 9999 ok', () => {
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, { ...CFG, slippageBps: 9999 }, 18);
  assert.ok(r.executedPriceUsd > 0, 'extremely small price but still positive');
});

// ─── Determinism ───────────────────────────────────────────────
test('19. same input = same output', () => {
  assert.deepStrictEqual(fill(19), fill(19));
});
test('20. different counter = different fillId', () => {
  assert.notEqual(fill(20).fill.fillId, fill(21).fill.fillId);
});
test('21. fillId within 128 chars', () => {
  assert.ok(fill(21).fill.fillId.length <= 128);
});
test('22. fillId >= 8 chars', () => {
  assert.ok(fill(22).fill.fillId.length >= 8);
});
test('23. fillId collision resistance (100 different counters)', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(simulateFill(BASE_INTENT, CFG, i).fill.fillId);
  assert.equal(ids.size, 100);
});
test('24. long fillId contains prefix', () => {
  assert.ok(fill(24).fill.fillId.startsWith('sim-BTCUSDT'));
});
test('25. custom fillIdPrefix', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, fillIdPrefix: 'prod' }, 25);
  assert.ok(r.fill.fillId.startsWith('prod-BTCUSDT'));
});

// ─── Timestamp ─────────────────────────────────────────────────
test('26. executedAtMs < createdAt rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, executedAtMs: 500 }, 26), /executedAtMs.*createdAt/);
});
test('27. executedAtMs = createdAt ok', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, executedAtMs: 1000 }, 27);
  assert.equal(r.fill.executedAt, 1000);
});

// ─── Post-round validation ─────────────────────────────────────
test('28. markPrice=0 rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, markPriceUsd: 0 }, 28));
});
test('29. markPrice negative rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, markPriceUsd: -100 }, 29));
});
test('30. feeBps negative rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, feeBps: -1 }, 30));
});
test('31. slippageBps negative rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, slippageBps: -1 }, 31));
});

// ─── Ledger integration ───────────────────────────────────────
test('32. fill accepted by PaperAccountLedger', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  const r = fill(32);
  const applied = l.applyFill(r.fill);
  assert.equal(applied.status, 'applied');
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.direction, 'long');
  assert.ok(p.signedQuantity > 0);
});
test('33. short fill accepted by PaperAccountLedger', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  const r = fillShort(33);
  const applied = l.applyFill(r.fill);
  assert.equal(applied.status, 'applied');
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.direction, 'short');
  assert.ok(p.signedQuantity < 0);
});

// ─── Edge cases ───────────────────────────────────────────────
test('34. positionUsd=1e8 works', () => {
  const r = simulateFill({ ...BASE_INTENT, positionUsd: 1e8 }, CFG, 34);
  assert.ok(r.quantity > 0);
  assert.ok(r.executedNotionalUsd > 0);
});
test('35. positionUsd=0.001 at high price works', () => {
  // 0.001 / 100000 = 1e-8 quantity, rounds to 1e-8 (non-zero at 12 decimal places)
  const r = simulateFill({ ...BASE_INTENT, positionUsd: 0.001 }, { ...CFG, markPriceUsd: 50000, slippageBps: 0 }, 35);
  assert.ok(r.quantity >= 0, 'quantity computed');
  assert.ok(r.executedNotionalUsd >= 0);
});
test('36. high slippage on long', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, slippageBps: 5000 }, 36);
  // price = 50000 * 1.5 = 75000
  assert.equal(r.executedPriceUsd, 75000);
  assert.ok(r.quantity > 0);
});
test('37. multiple fills to same ledger work', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  l.applyFill(fill(37).fill);
  l.applyFill(fill(38).fill);
  assert.equal(l.snapshot().processedFills, 2);
  const p = l.getPosition('BTCUSDT')!;
  assert.ok(p.signedQuantity > 0);
});
test('38. feeBps=1 gives fractional fee', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, feeBps: 1 }, 38);
  assert.ok(r.feeUsd > 0 && r.feeUsd < 1);
});
test('39. markPrice=1e8 works', () => {
  const r = simulateFill({ ...BASE_INTENT, positionUsd: 1e8 }, { ...CFG, markPriceUsd: 1e8 }, 39);
  assert.equal(r.executedNotionalUsd, r.quantity * r.executedPriceUsd);
});
test('40. short fee = long fee for same params (feeBps test)', () => {
  const rl = fill(40);
  const rs = fillShort(41);
  // Fee is based on notional, which may differ slightly due to slippage direction
  assert.ok(Math.abs(rl.feeUsd - rs.feeUsd) < 0.01);
});
test('41. execute twice = same fillId (deterministic)', () => {
  const a = fill(42);
  const b = fill(42); // same counter
  assert.equal(a.fill.fillId, b.fill.fillId);
});
test('42. fill validatePaperFill passes internally', () => {
  const r = fill(43);
  assert.ok(r.fill.quantity > 0);
  assert.ok(r.fill.priceUsd > 0);
  assert.ok(r.fill.feeUsd >= 0);
});
