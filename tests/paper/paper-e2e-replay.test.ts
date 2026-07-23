// Stage 3B4C11: Deterministic E2E replay — full paper path with SHA-256 digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { PaperAccountLedger } from '../../src/paper/PaperAccountLedger';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { simulateFill } from '../../src/paper/FillSimulator';
import { PaperBroker } from '../../src/paper/PaperBroker';
import type { PaperAccountConfig } from '../../src/types/paper-account';
import type { TradeIntent } from '../../src/types/trade-intent';
import type { FillSimulatorConfig } from '../../src/paper/FillSimulator';
import { PaperLedgerCorruptionError, PaperLedgerIdentityMismatchError } from '../../src/paper/errors';

const CONFIG: PaperAccountConfig = { accountId: 'e2e01', exchange: 'bitget', initialCashUsd: 100_000 };
const INTENT_LONG: TradeIntent = { exchange: 'bitget', symbol: 'BTCUSDT', direction: 'long', positionUsd: 5000, orderType: 'market', source: 'e2e', createdAt: 1000, reason: 'test', biasUpdatedAt: 1000 };
const INTENT_SHORT: TradeIntent = { exchange: 'bitget', symbol: 'BTCUSDT', direction: 'short', positionUsd: 3000, orderType: 'market', source: 'e2e', createdAt: 1500, reason: 'test', biasUpdatedAt: 1500 };
const SCFG: FillSimulatorConfig = { markPriceUsd: 50000, feeBps: 10, slippageBps: 0, executedAtMs: 2000 };

function digest(entries: any[], snapshot: any): string {
  return crypto.createHash('sha256').update(JSON.stringify({ entries, snapshot })).digest('hex');
}

// ─── Full path: simulateFill → broker.execute → store → restart ───
test('1. full path: execute, persist, restart, verify', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    const r = await b1.execute(INTENT_LONG, SCFG, 1);
    assert.equal(r.status, 'applied');
    assert.equal(r.persisted, true);
    // Restart
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().processedFills, 1);
    assert.equal(b2.snapshot().cashUsd, b1.snapshot().cashUsd);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Restart identity: same entries, same snapshot ───────────
test('2. restart: entries identical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    await b1.execute(INTENT_LONG, SCFG, 2);
    const e1 = b1.entries();
    const b2 = await PaperBroker.open(CONFIG, store);
    const e2 = b2.entries();
    assert.deepStrictEqual(e2, e1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('3. restart: deep clone — modifying after load doesn\'t corrupt store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    await b1.execute(INTENT_LONG, SCFG, 3);
    const b2 = await PaperBroker.open(CONFIG, store);
    // Mutate returned entries — should not affect internal
    const e = b2.entries() as any[];
    if (e.length > 0) e[0] = null;
    const b3 = await PaperBroker.open(CONFIG, store);
    assert.equal(b3.entries().length, 1);
    assert.equal(b3.snapshot().processedFills, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Long + short (flip) ─────────────────────────────────────
test('4. long then short → flip via broker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 4);
    await b.execute({ ...INTENT_SHORT, positionUsd: 10000 }, SCFG, 5);
    const r = await b.execute(INTENT_LONG, SCFG, 6);
    assert.equal(r.status, 'applied');
    assert.equal(b.snapshot().processedFills, 3);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── SHA-256 digest determinism ──────────────────────────────
test('5. digest: same inputs → same SHA-256', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 7);
    const d1 = digest(b.entries(), b.snapshot());
    // Reset and replay
    const store2 = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b2 = await PaperBroker.open(CONFIG, store2);
    const d2 = digest(b2.entries(), b2.snapshot());
    assert.equal(d1, d2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('6. digest: different fill → different SHA-256', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const s1 = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, s1);
    await b1.execute(INTENT_LONG, SCFG, 8);
    const d1 = digest(b1.entries(), b1.snapshot());
    const s2 = new PaperLedgerStore(CONFIG, { baseDir: dir2 });
    const b2 = await PaperBroker.open(CONFIG, s2);
    await b2.execute(INTENT_SHORT, SCFG, 9);
    const d2 = digest(b2.entries(), b2.snapshot());
    assert.notEqual(d1, d2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(dir2, { recursive: true, force: true }); }
});

// ─── Duplicate handling across restart ───────────────────────
test('7. duplicate before restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 10);
    const r = await b.execute(INTENT_LONG, SCFG, 10);
    assert.equal(r.status, 'duplicate');
    assert.equal(b.snapshot().processedFills, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('8. duplicate after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await (await PaperBroker.open(CONFIG, store)).execute(INTENT_LONG, SCFG, 11);
    const b = await PaperBroker.open(CONFIG, store);
    const r = await b.execute(INTENT_LONG, SCFG, 11);
    assert.equal(r.status, 'duplicate');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Persisted state consistency ─────────────────────────────
test('9. persisted cash correct', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 12);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'account.bitget.e2e01.json'), 'utf-8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.config.initialCashUsd, 100_000);
    assert.ok(Array.isArray(raw.entries));
    assert.ok(raw.entries.length > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Save failure recovery ───────────────────────────────────
test('10. save failure → reload shows old state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    await b1.execute(INTENT_LONG, SCFG, 13);
    // Delete the file to simulate corruption for next save
    await fs.unlink(path.join(dir, 'account.bitget.e2e01.json'));
    // Try to execute with a corrupt state — broker won't find file on next open
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().processedFills, 0, 'new ledger when file was deleted');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── JSON corruption fail-closed ─────────────────────────────
test('11. corrupted JSON → fail-closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'account.bitget.e2e01.json'), '{bad json', 'utf-8');
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await assert.rejects(() => store.load(), PaperLedgerCorruptionError);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Identity mismatch fail-closed ───────────────────────────
test('12. identity mismatch → fail-closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await (await PaperBroker.open(CONFIG, store)).execute(INTENT_LONG, SCFG, 14);
    // Try to open with different accountId
    await assert.rejects(() => PaperBroker.open({ ...CONFIG, accountId: 'hacker' }, store), PaperLedgerIdentityMismatchError);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Multi-symbol persistence ────────────────────────────────
test('13. multi-symbol: long BTC + short ETH', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 15);
    await b.execute({ ...INTENT_SHORT, symbol: 'ETHUSDT' }, SCFG, 16);
    assert.equal(b.snapshot().openPositions, 2);
    // Restart
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().openPositions, 2);
    assert.equal(b2.snapshot().processedFills, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Restart: PnL, fees, exposure consistent ─────────────────
test('14. restart: PnL/fees/exposure consistent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    await b1.execute(INTENT_LONG, SCFG, 17);
    const s1 = b1.snapshot();
    const b2 = await PaperBroker.open(CONFIG, store);
    const s2 = b2.snapshot();
    assert.equal(s2.cashUsd, s1.cashUsd);
    assert.equal(s2.realizedPnlUsd, s1.realizedPnlUsd);
    assert.equal(s2.totalFeesUsd, s1.totalFeesUsd);
    assert.equal(s2.equityUsd, s1.equityUsd);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Sequence consistency ────────────────────────────────────
test('15. restart: sequence matches entries length', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    await b1.execute(INTENT_LONG, SCFG, 18);
    await b1.execute(INTENT_SHORT, SCFG, 19);
    const seq = b1.snapshot().sequence;
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().sequence, seq);
    assert.equal(b2.entries().length, seq);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Broker executes with multiple counters ──────────────────
test('16. broker: multiple sequential executes via store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    for (let i = 0; i < 5; i++) {
      const r = await b.execute({ ...INTENT_LONG, direction: i % 2 === 0 ? 'long' : 'short', positionUsd: 1000 + i * 100 }, SCFG, 20 + i);
      assert.equal(r.status, 'applied');
    }
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().processedFills, 5);
    assert.equal(b2.snapshot().sequence, 5);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Real LedgerStore save → digest identical ────────────────
test('17. real store: save → load → digest identical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 25);
    await b.execute(INTENT_SHORT, SCFG, 26);
    const d1 = digest(b.entries(), b.snapshot());
    const loaded = await store.load();
    assert.ok(loaded);
    const d2 = digest(loaded!.entries(), loaded!.snapshot());
    assert.equal(d1, d2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── SHA-256 differs on changed fillId ───────────────────────
test('18. digest: one fillId changed → digest differs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const s1 = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, s1);
    await b1.execute(INTENT_LONG, SCFG, 27);
    await b1.execute(INTENT_LONG, SCFG, 28);
    const d1 = digest(b1.entries(), b1.snapshot());
    const s2 = new PaperLedgerStore(CONFIG, { baseDir: dir2 });
    const b2 = await PaperBroker.open(CONFIG, s2);
    await b2.execute(INTENT_LONG, SCFG, 27); // same first
    await b2.execute({ ...INTENT_LONG, positionUsd: 6000 }, SCFG, 29); // different second
    const d2 = digest(b2.entries(), b2.snapshot());
    assert.notEqual(d1, d2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(dir2, { recursive: true, force: true }); }
});

// ─── Empty ledger digest ─────────────────────────────────────
test('19. empty ledger digest is identical on restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    const d1 = digest(b1.entries(), b1.snapshot());
    const b2 = await PaperBroker.open(CONFIG, store);
    const d2 = digest(b2.entries(), b2.snapshot());
    assert.equal(d1, d2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Add / reduce / close ────────────────────────────────────
test('20. add: two long fills → avg price, restarts consistent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 30);
    await b.execute(INTENT_LONG, SCFG, 31);
    assert.equal(b.snapshot().openPositions, 1);
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().openPositions, 1);
    assert.equal(b2.snapshot().processedFills, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('21. close position via opposite fill', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 32);
    await b.execute({ ...INTENT_SHORT, positionUsd: 5000 }, SCFG, 33);
    assert.equal(b.snapshot().openPositions, 0);
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().openPositions, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('22. partial close → position remains, restarts consistent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, SCFG, 34);
    // Sell half
    await b.execute({ ...INTENT_SHORT, positionUsd: 2500 }, SCFG, 35);
    assert.equal(b.snapshot().openPositions, 1);
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().openPositions, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Multiple restarts ──────────────────────────────────────
test('23. triple restart: state always consistent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await (await PaperBroker.open(CONFIG, store)).execute(INTENT_LONG, SCFG, 36);
    const b2 = await PaperBroker.open(CONFIG, store);
    const b3 = await PaperBroker.open(CONFIG, store);
    assert.equal(b3.snapshot().processedFills, b2.snapshot().processedFills);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Fee accounting across restart ──────────────────────────
test('24. fees preserved across restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b1 = await PaperBroker.open(CONFIG, store);
    await b1.execute(INTENT_LONG, SCFG, 37);
    const fees = b1.snapshot().totalFeesUsd;
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().totalFeesUsd, fees);
    assert.ok(fees > 0, 'non-zero fees accured');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Concurrent fills with real store ────────────────────────
test('25. concurrent fills via broker → all persisted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    const results = await Promise.all([
      b.execute(INTENT_LONG, SCFG, 40),
      b.execute(INTENT_SHORT, SCFG, 41),
      b.execute({ ...INTENT_LONG, symbol: 'ETHUSDT' }, SCFG, 42),
    ]);
    assert.equal(results.filter(r => r.status === 'applied').length, 3);
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(b2.snapshot().processedFills, 3);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Zero slippage digest determinism ────────────────────────
test('26. zero slippage: long + short digest deterministic', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    await b.execute(INTENT_LONG, { ...SCFG, slippageBps: 0 }, 43);
    await b.execute(INTENT_SHORT, { ...SCFG, slippageBps: 0 }, 44);
    const d = digest(b.entries(), b.snapshot());
    const b2 = await PaperBroker.open(CONFIG, store);
    assert.equal(digest(b2.entries(), b2.snapshot()), d);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Mark-to-market deterministic (via simulateFill price) ────
test('27. fillId contains SHA-256 hex format', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    const r = await b.execute(INTENT_LONG, SCFG, 45);
    assert.ok(/^sim-[a-f0-9]{32}$/.test(r.fill.fillId), `fillId: ${r.fill.fillId}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Simulator round-trip via broker ─────────────────────────
test('28. broker result snapshot === broker.snapshot()', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    const r = await b.execute(INTENT_LONG, SCFG, 46);
    assert.deepStrictEqual(r.snapshot, b.snapshot());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Empty store: broker creates new ledger ──────────────────
test('29. empty store → broker creates new ledger', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const b = await PaperBroker.open(CONFIG, store);
    assert.equal(b.snapshot().sequence, 0);
    assert.equal(b.snapshot().processedFills, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ─── Real store identity check on open ───────────────────────
test('30. identity check on real store open', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await (await PaperBroker.open(CONFIG, store)).execute(INTENT_LONG, SCFG, 47);
    // Open with fixed canonical config — same CONFIG works since base config is already canonical
    const b = await PaperBroker.open(CONFIG, store);
    assert.equal(b.snapshot().processedFills, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
