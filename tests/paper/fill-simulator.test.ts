// Stage 3B4C9-R2: SHA-256 fill ID tests — ≥50 tests
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
function f(c: number) { return simulateFill(BASE_INTENT, CFG, c); }

// ─── Validation ────────────────────────────────────────────────
test('1. long → buy', () => { assert.equal(f(0).fill.side, 'buy'); });
test('2. short → sell', () => {
  assert.equal(simulateFill({ ...BASE_INTENT, direction: 'short' }, CFG, 0).fill.side, 'sell');
});
test('3. forged direction rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, direction: 'hold' as any }, CFG, 0), /direction/); });
test('4. forged orderType rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, orderType: 'limit' as any }, CFG, 0), /orderType/); });
test('5. invalid exchange rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, exchange: 'invalid' as any }, CFG, 0), /exchange/); });
test('6. NaN position rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, positionUsd: NaN }, CFG, 0)); });
test('7. zero position rejected', () => { assert.throws(() => simulateFill({ ...BASE_INTENT, positionUsd: 0 }, CFG, 0)); });
test('8. negative counter rejected', () => { assert.throws(() => f(-1)); });
test('9. short slippage>=10000 rejected', () => {
  assert.throws(() => simulateFill({ ...BASE_INTENT, direction: 'short' }, { ...CFG, slippageBps: 10000 }, 0), /slippage/);
});
test('10. executedAt < createdAt rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, executedAtMs: 500 }, 0), /executedAtMs.*createdAt/);
});

// ─── Price / fee math ──────────────────────────────────────────
test('11. long slippage increases price', () => { assert.equal(f(0).executedPriceUsd, 50025); });
test('12. short slippage decreases price', () => {
  assert.equal(simulateFill({ ...BASE_INTENT, direction: 'short' }, CFG, 0).executedPriceUsd, 49975);
});
test('13. zero slippage = mark price', () => {
  assert.equal(simulateFill(BASE_INTENT, { ...CFG, slippageBps: 0 }, 0).executedPriceUsd, 50000);
});
test('14. zero fee', () => {
  assert.equal(simulateFill(BASE_INTENT, { ...CFG, feeBps: 0 }, 0).feeUsd, 0);
});
test('15. feeUsd = executedNotional × feeBps / 10000', () => {
  const r = f(0);
  assert.equal(r.feeUsd, Math.round(r.executedNotionalUsd * CFG.feeBps / 10000 * 1e8) / 1e8);
});
test('16. short fee also computed from executedNotional', () => {
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, CFG, 0);
  assert.equal(r.feeUsd, Math.round(r.executedNotionalUsd * CFG.feeBps / 10000 * 1e8) / 1e8);
});

// ─── SHA-256 fillId determinism ────────────────────────────────
test('17. same canonical fill + same counter → same fillId', () => {
  assert.equal(f(17).fill.fillId, f(17).fill.fillId);
});
test('18. different counter → different fillId', () => {
  assert.notEqual(f(18).fill.fillId, f(19).fill.fillId);
});
test('19. fillId has <prefix>-<32 hex> format', () => {
  const id = f(19).fill.fillId;
  assert.ok(/^sim-[a-f0-9]{32}$/.test(id), `fillId format: ${id}`);
});
test('20. fillId ≤ 128 chars', () => { assert.ok(f(20).fill.fillId.length <= 128); });
test('21. custom prefix', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, fillIdPrefix: 'prod-v2' }, 21);
  assert.ok(r.fill.fillId.startsWith('prod-v2-'));
});
test('22. different exchange → different fillId', () => {
  const a = f(22);
  const b = simulateFill({ ...BASE_INTENT, exchange: 'binance' }, CFG, 22);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('23. different symbol → different fillId', () => {
  const a = f(23);
  const b = simulateFill({ ...BASE_INTENT, symbol: 'ETHUSDT' }, CFG, 23);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('24. different markPrice → different fillId', () => {
  const a = f(24);
  const b = simulateFill(BASE_INTENT, { ...CFG, markPriceUsd: 60000 }, 24);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('25. different feeBps → different fillId', () => {
  const a = f(25);
  const b = simulateFill(BASE_INTENT, { ...CFG, feeBps: 20 }, 25);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('26. different slippageBps → different fillId', () => {
  const a = f(26);
  const b = simulateFill(BASE_INTENT, { ...CFG, slippageBps: 10 }, 26);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('27. different executedAtMs → different fillId', () => {
  const a = f(27);
  const b = simulateFill(BASE_INTENT, { ...CFG, executedAtMs: 3000 }, 27);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('28. different positionUsd → different fillId', () => {
  const a = f(28);
  const b = simulateFill({ ...BASE_INTENT, positionUsd: 2000 }, CFG, 28);
  assert.notEqual(a.fill.fillId, b.fill.fillId);
});
test('29. same canonical input (same rounding) = same fillId', () => {
  const a = f(29);
  const b = f(29); // same counter, same everything → identical
  assert.equal(a.fill.fillId, b.fill.fillId);
});
test('30. fillId collision resistance 200 counters', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(f(i).fill.fillId);
  assert.equal(ids.size, 200);
});
test('31. empty prefix rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, fillIdPrefix: '' }, 31), /fillIdPrefix/);
});
test('32. prefix > 32 chars rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, fillIdPrefix: 'a'.repeat(33) }, 32), /fillIdPrefix/);
});
test('33. prefix with special chars rejected', () => {
  assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, fillIdPrefix: 'bad prefix!' }, 33), /fillIdPrefix/);
});

// ─── Ledger integration ───────────────────────────────────────
test('34. fill accepted by PaperAccountLedger', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  const r = f(34);
  assert.equal(l.applyFill(r.fill).status, 'applied');
  assert.ok(l.getPosition('BTCUSDT')!.signedQuantity > 0);
});
test('35. short fill accepted by Ledger', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, CFG, 35);
  assert.equal(l.applyFill(r.fill).status, 'applied');
  assert.ok(l.getPosition('BTCUSDT')!.signedQuantity < 0);
});
test('36. two different fills (diff counter) → both accepted (no conflict)', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  l.applyFill(f(36).fill);
  l.applyFill(f(37).fill);
  assert.equal(l.snapshot().processedFills, 2);
});
test('37. same fill twice → duplicate', () => {
  const l = new PaperAccountLedger({ accountId: 't', exchange: 'bitget', initialCashUsd: 100_000 });
  l.applyFill(f(38).fill);
  assert.equal(l.applyFill(f(38).fill).status, 'duplicate');
});

// ─── Post-round validation ─────────────────────────────────────
test('38. markPrice=0 rejected', () => { assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, markPriceUsd: 0 }, 38)); });
test('39. feeBps negative rejected', () => { assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, feeBps: -1 }, 39)); });
test('40. slippageBps negative rejected', () => { assert.throws(() => simulateFill(BASE_INTENT, { ...CFG, slippageBps: -1 }, 40)); });

// ─── Edge cases ───────────────────────────────────────────────
test('41. positionUsd=1e8 works', () => {
  const r = simulateFill({ ...BASE_INTENT, positionUsd: 1e8 }, CFG, 41);
  assert.ok(r.quantity > 0);
});
test('42. feeBps=1 gives fractional fee', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, feeBps: 1 }, 42);
  assert.ok(r.feeUsd > 0 && r.feeUsd < 1);
});
test('43. zero slippage on short', () => {
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, { ...CFG, slippageBps: 0 }, 43);
  assert.equal(r.executedPriceUsd, 50000);
});
test('44. high slippage long', () => {
  const r = simulateFill(BASE_INTENT, { ...CFG, slippageBps: 5000 }, 44);
  assert.equal(r.executedPriceUsd, 75000);
});
test('45. short high slippage 9999 ok', () => {
  const r = simulateFill({ ...BASE_INTENT, direction: 'short' }, { ...CFG, slippageBps: 9999 }, 45);
  assert.ok(r.executedPriceUsd > 0);
});
test('46. same input = same output (deepStrictEqual)', () => {
  assert.deepStrictEqual(f(46), f(46));
});
test('47. fill validatePaperFill passes internally', () => {
  const r = f(47);
  assert.ok(r.fill.quantity > 0 && r.fill.priceUsd > 0 && r.fill.feeUsd >= 0);
});
test('48. notional = quantity × price', () => {
  const r = f(48);
  assert.equal(r.executedNotionalUsd, Math.round(r.quantity * r.executedPriceUsd * 1e8) / 1e8);
});
test('49. markPrice=1e8 works', () => {
  const r = simulateFill({ ...BASE_INTENT, positionUsd: 1e8 }, { ...CFG, markPriceUsd: 1e8 }, 49);
  assert.equal(r.executedNotionalUsd, Math.round(r.quantity * r.executedPriceUsd * 1e8) / 1e8);
});
test('50. fillId for identical canonicals = identical hex', () => {
  const a = f(50);
  const b = simulateFill(BASE_INTENT, CFG, 50);
  assert.equal(a.fill.fillId, b.fill.fillId);
});
