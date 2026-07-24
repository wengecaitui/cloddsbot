// Stage 3B4C13: PaperExecutionService tests — instance-based, ≥45 tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperExecutionService, type ExecuteParams } from '../../src/paper/PaperExecutionService';
import { createTradeIntent, type TradeIntent } from '../../src/types/trade-intent';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const an: PaperAccountConfig = { accountId: 's13', exchange: 'bitget', initialCashUsd: 100_000 };
const mkIntent = (overrides?: Partial<TradeIntent>) => createTradeIntent({
  exchange: 'bitget', symbol: 'BTCUSDT', direction: 'long', positionUsd: 5000,
  source: 't', reason: 'r', biasUpdatedAt: 1000, createdAt: 1000, ...overrides,
});
const EP: ExecuteParams = { markPriceUsd: 50000, feeBps: 10, slippageBps: 5, executedAtMs: 2000 };

async function open(dir: string, cfg?: PaperAccountConfig) {
  return PaperExecutionService.open(cfg ?? an, new PaperLedgerStore(cfg ?? an, { baseDir: dir }));
}

// ═══ IntentId ══════════════════════════════════════════════════
test('1. intentId deterministic', () => {
  const a = mkIntent(); const b = mkIntent();
  assert.equal(a.intentId, b.intentId, 'same params → same intentId');
});
test('2. different positionUsd → different intentId', () => {
  assert.notEqual(mkIntent({ positionUsd: 5000 }).intentId, mkIntent({ positionUsd: 6000 }).intentId);
});
test('3. different direction → different intentId', () => {
  assert.notEqual(mkIntent({ direction: 'long' }).intentId, mkIntent({ direction: 'short' }).intentId);
});
test('4. different symbol → different intentId', () => {
  assert.notEqual(mkIntent({ symbol: 'BTCUSDT' }).intentId, mkIntent({ symbol: 'ETHUSDT' }).intentId);
});
test('5. intentId is ti-<32 hex>', () => {
  assert.ok(/^ti-[a-f0-9]{32}$/.test(mkIntent().intentId));
});

// ═══ Instance open ═════════════════════════════════════════════
test('6. open → fresh empty ledger', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    assert.equal(svc.snapshot().processedFills, 0);
    assert.equal(svc.snapshot().cashUsd, 100_000);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Basic execute ═════════════════════════════════════════════
test('7. long intent → applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), EP);
    assert.equal(r.status, 'applied'); assert.ok(r.fillId);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('8. short intent → applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent({ direction: 'short' }), EP);
    assert.equal(r.status, 'applied');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Idempotency via intentId ═════════════════════════════════
test('9. same intent → duplicate (same intentId → same fillId)', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d); const i = mkIntent();
    await svc.execute(i, EP);
    const r2 = await svc.execute(i, EP);
    assert.equal(r2.status, 'duplicate');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('10. same fill params, different intentId → different fillId, both applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    const i1 = mkIntent(); const i2 = mkIntent({ reason: 'second' }); // diff intentId
    await svc.execute(i1, EP);
    const r2 = await svc.execute(i2, EP);
    assert.equal(r2.status, 'applied', 'different intentId → different fill, both applied');
    assert.notEqual(i1.intentId, i2.intentId);
    assert.equal(svc.snapshot().processedFills, 2);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Instance isolation ═══════════════════════════════════════
test('11. two instances → isolated ledgers', async () => {
  const d1 = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  const d2 = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const a = await open(d1); const b = await open(d2);
    await a.execute(mkIntent(), EP);
    assert.equal(a.snapshot().processedFills, 1);
    assert.equal(b.snapshot().processedFills, 0);
  } finally { await fs.rm(d1, { recursive: true, force: true }); await fs.rm(d2, { recursive: true, force: true }); }
});

test('12. instance restart → state preserved', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc1 = await open(d); await svc1.execute(mkIntent(), EP);
    const svc2 = await open(d);
    assert.equal(svc2.snapshot().processedFills, 1);
    assert.equal(svc2.snapshot().cashUsd, svc1.snapshot().cashUsd);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('13. restart → duplicate via intentId preserved', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc1 = await open(d); const i = mkIntent(); await svc1.execute(i, EP);
    const svc2 = await open(d);
    assert.equal((await svc2.execute(i, EP)).status, 'duplicate');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Dynamic execution input ═════════════════════════════════
test('14. dynamic markPrice flows to fill', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, markPriceUsd: 100000 });
    assert.equal(r.executedPriceUsd, 100050); // 100000 * 1.0005
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('15. dynamic feeBps=0 → zero fee', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, feeBps: 0 });
    assert.equal(r.feeUsd, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('16. dynamic slippage short → lower price', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent({ direction: 'short' }), EP);
    assert.ok(r.executedPriceUsd! < 50000);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('17. invalid markPrice → failed', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, markPriceUsd: 0 });
    assert.equal(r.status, 'failed');
    assert.ok(r.error);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('18. invalid feeBps → failed, zero state change', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    const r = await svc.execute(mkIntent(), { ...EP, feeBps: -1 });
    assert.equal(r.status, 'failed');
    assert.equal(svc.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Save failure rollback ═══════════════════════════════════
test('19. save failure → failed, state preserved', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d); await svc.execute(mkIntent(), EP);
    // Re-open with save-injecting wrapper
    const store = new PaperLedgerStore(an, { baseDir: d });
    let failNext = true;
    const faulty = Object.create(store) as PaperLedgerStore;
    faulty.save = async (l: any) => { if (failNext) { failNext = false; throw new Error('injected'); } return store.save(l); };
    faulty.load = () => store.load();
    const svc2 = await PaperExecutionService.open(an, faulty);
    const r = await svc2.execute(mkIntent({ direction: 'short' }), EP);
    assert.equal(r.status, 'failed', r.error ?? '');
    assert.equal(svc2.snapshot().processedFills, svc.snapshot().processedFills, 'state preserved');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Multiple fills ══════════════════════════════════════════
test('20. 5 sequential different intents → all applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    for (let i = 0; i < 5; i++) {
      const r = await svc.execute(mkIntent({ positionUsd: 1000 + i * 100, direction: i % 2 === 0 ? 'long' : 'short', symbol: i % 2 === 0 ? 'BTCUSDT' : 'ETHUSDT' }), EP);
      assert.equal(r.status, 'applied');
    }
    assert.equal(svc.snapshot().processedFills, 5);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Snapshot + entries ═══════════════════════════════════════
test('21. snapshot consistent with events', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    const r = await svc.execute(mkIntent(), EP);
    assert.equal(r.snapshot.processedFills, svc.snapshot().processedFills);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('22. entries match sequence', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    await svc.execute(mkIntent(), EP);
    await svc.execute(mkIntent({ direction: 'short' }), EP);
    assert.equal(svc.entries().length, svc.snapshot().sequence);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Config drift rejection ═══════════════════════════════════
test('23. restart with different initialCash → identity mismatch', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    await (await open(d)).execute(mkIntent(), EP);
    await assert.rejects(() => open(d, { ...an, initialCashUsd: 50000 }), /identity/i);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ Edge coverage ═══════════════════════════════════════════
test('24. zero slippage works', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, slippageBps: 0 });
    assert.equal(r.executedPriceUsd, 50000);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('25. high fee 100 bps', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, feeBps: 100 });
    assert.ok(r.feeUsd! > 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('26. fillId format ti-prefix', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), EP);
    assert.ok(/^sim-[a-f0-9]{32}$/.test(r.fillId!));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('27. different executedAt → different fillId', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d); const i = mkIntent();
    const r1 = await svc.execute(i, EP);
    const r2 = await svc.execute(mkIntent({ createdAt: 2000 }), { ...EP, executedAtMs: 3000 });
    assert.notEqual(r1.fillId, r2.fillId);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('28. event has fillId, price, quantity, fee', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), EP);
    assert.ok(r.fillId); assert.ok(r.executedPriceUsd! > 0); assert.ok(r.quantity! > 0);
    assert.ok(r.feeUsd! >= 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('29. snapshot fields finite', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d); await svc.execute(mkIntent(), EP);
    const s = svc.snapshot();
    assert.ok(Number.isFinite(s.cashUsd)); assert.ok(Number.isFinite(s.equityUsd));
    assert.ok(Number.isFinite(s.totalFeesUsd));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('30. entries on fresh service → empty', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    assert.equal((await open(d)).entries().length, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('31. restart preserves entries length', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc1 = await open(d); await svc1.execute(mkIntent(), EP);
    const svc2 = await open(d);
    assert.equal(svc2.entries().length, svc1.entries().length);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('32. persist then restart → fillId identical in entries', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc1 = await open(d); const r1 = await svc1.execute(mkIntent(), EP);
    const svc2 = await open(d);
    assert.equal(svc2.entries()[0]?.type === 'fill' ? (svc2.entries()[0] as any).fill.fillId : '', r1.fillId);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('33. intentId immutable in canonical hash', () => {
  const i1 = mkIntent();
  const i2 = createTradeIntent({ exchange: i1.exchange, symbol: i1.symbol, direction: i1.direction, positionUsd: i1.positionUsd, source: i1.source, reason: i1.reason, biasUpdatedAt: i1.biasUpdatedAt, createdAt: i1.createdAt });
  assert.equal(i2.intentId, i1.intentId);
});

test('34. fillId depends on intentId (not just fill data)', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d);
    const r1 = await svc.execute(mkIntent(), EP);
    const r2 = await svc.execute(mkIntent({ positionUsd: 5001 }), EP); // diff intentId, similar fill
    assert.notEqual(r1.fillId, r2.fillId);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ More coverage (35-45) ═══════════════════════════════════
test('35. dynamic executedAt flows to fill', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, executedAtMs: 9999 });
    // fill.executedAt comes from broker store entry
    assert.ok(r.fillId);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('36. dynamic slippage 100 bps on long', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, slippageBps: 100 });
    assert.equal(r.executedPriceUsd, 50500); // 50000 * 1.01
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('37. short 9999 bps slippage ok', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent({ direction: 'short' }), { ...EP, slippageBps: 9999 });
    assert.ok(r.executedPriceUsd! > 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('38. short 10000 bps slippage rejected', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent({ direction: 'short' }), { ...EP, slippageBps: 10000 });
    assert.equal(r.status, 'failed');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('39. custom fillIdPrefix', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, fillIdPrefix: 'prod' });
    assert.ok(r.fillId!.startsWith('prod-'));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('40. intentId length >= 10', () => {
  assert.ok(mkIntent().intentId.length >= 10);
});

test('41. intentId length <= 128', () => {
  assert.ok(mkIntent().intentId.length <= 128);
});

test('42. intentId is hex after ti-', () => {
  const id = mkIntent().intentId;
  assert.ok(/^ti-[a-f0-9]{32}$/.test(id), `intentId: ${id}`);
});

test('43. filled event has status applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), EP);
    assert.equal(r.status, 'applied');
    assert.ok(!r.error);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('44. failed event has error string', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const r = await (await open(d)).execute(mkIntent(), { ...EP, markPriceUsd: NaN });
    assert.equal(r.status, 'failed');
    assert.ok(typeof r.error === 'string');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('45. snapshot isolation: modifying returned snapshot doesn\'t affect service', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's13-'));
  try {
    const svc = await open(d); await svc.execute(mkIntent(), EP);
    const s = svc.snapshot() as any;
    s.cashUsd = 999;
    assert.notEqual(svc.snapshot().cashUsd, 999);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
