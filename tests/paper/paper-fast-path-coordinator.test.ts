// Stage 3B4C14-R1: FP bridge tests — compatible with bind-at-construct coordinator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperFastPathCoordinator } from '../../src/paper/PaperFastPathCoordinator';
import { PaperExecutionService } from '../../src/paper/PaperExecutionService';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { IndicatorService } from '../../src/pipeline/IndicatorService';
import { ExecutionRouter } from '../../src/router/ExecutionRouter';
import { MarketBiasReportFull } from '../../src/types/market-bias';
import { createTradeIntent } from '../../src/types/trade-intent';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const EXCH: ExchangeId = 'bitget';
const an: PaperAccountConfig = { accountId: 's14r2', exchange: EXCH, initialCashUsd: 100_000 };

function makeFp(report?: Partial<MarketBiasReportFull>) {
  const r: MarketBiasReportFull = { exchange: EXCH, updatedAt: Date.now(), assets: [{ symbol: 'BTCUSDT', direction: 'long', confidence: 0.85, suggestedPositionPct: 0.1 }], whitelist: ['BTCUSDT'], ...report } as any;
  const router = { exchange: EXCH, getBiasReport: () => r, getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: null } as any as ExecutionRouter;
  return new FastPipeline({ exchange: EXCH, router, indicatorService: { calculateAll: async () => [] } as any as IndicatorService });
}
async function svc(d: string) { return PaperExecutionService.open(an, new PaperLedgerStore(an, { baseDir: d })); }
const SIG = { exchange: EXCH, symbol: 'BTCUSDT', source: 's' };
const P = { feeBps: 10, slippageBps: 5 };

test('1. real FP trade → applied', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const r = await new PaperFastPathCoordinator(makeFp(), await svc(d), EXCH).run(SIG, P);
    assert.equal(r.pipelineResult.decision, 'trade'); assert.equal(r.paperEvent!.status, 'applied');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('2. duplicate via real FP', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const s = await svc(d); const c = new PaperFastPathCoordinator(makeFp(), s, EXCH);
    assert.equal((await c.run(SIG, P)).paperEvent!.status, 'applied');
    assert.equal((await c.run(SIG, P)).paperEvent!.status, 'duplicate');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('3. skip → no paper', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const r = await new PaperFastPathCoordinator(makeFp({ whitelist: ['ETHUSDT'] } as any), await svc(d), EXCH).run(SIG, P);
    assert.equal(r.pipelineResult.decision, 'skip'); assert.ok(!r.paperEvent);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('4. signal mismatch throws', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    await assert.rejects(() => new PaperFastPathCoordinator(makeFp(), null as any, EXCH).run({ ...SIG, exchange: 'binance' }, P));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('5. invalid fee throws', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const s = await svc(d);
    await assert.rejects(() => new PaperFastPathCoordinator(makeFp(), s, EXCH).run(SIG, { feeBps: -1, slippageBps: 5 }));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('6. restart preserves fills', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    await new PaperFastPathCoordinator(makeFp(), await svc(d), EXCH).run(SIG, P);
    assert.equal((await svc(d)).snapshot().processedFills, 1);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('7. dynamic fee/slippage', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const r = await new PaperFastPathCoordinator(makeFp(), await svc(d), EXCH).run(SIG, { feeBps: 20, slippageBps: 10 });
    assert.ok(r.paperEvent!.feeUsd! > 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('8. fillId format sha', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const r = await new PaperFastPathCoordinator(makeFp(), await svc(d), EXCH).run(SIG, P);
    assert.ok(/^sim-[a-f0-9]{32}$/.test(r.paperEvent!.fillId!));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('9. snapshot consistent', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's14r2-')); try {
    const s = await svc(d);
    const r = await new PaperFastPathCoordinator(makeFp(), s, EXCH).run(SIG, P);
    assert.deepStrictEqual(r.paperEvent!.snapshot, s.snapshot());
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('10. coordinator rejects invalid exchange', () => {
  assert.throws(() => new PaperFastPathCoordinator(null as any, null as any, 'bad' as any), /exchange/);
});
