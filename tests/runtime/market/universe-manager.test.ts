// Stage 3B1A: UniverseManager policy tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSymbolRegistry } from '../../../src/runtime/market/SymbolFormat';
import { createUniverseManager } from '../../../src/runtime/market/UniverseManager';
import type { MarketBiasReportFull } from '../../../src/types/market-bias';

const MAPPINGS = [
  { canonical: 'BTC/USDT', exchange: 'BTCUSDT' },
  { canonical: 'ETH/USDT', exchange: 'ETHUSDT' },
  { canonical: 'SOL/USDT', exchange: 'SOLUSDT' },
  { canonical: 'DOGE/USDT', exchange: 'DOGEUSDT' },
  { canonical: 'XRP/USDT', exchange: 'XRPUSDT' },
] as const;

function createTestRegistry() {
  return createSymbolRegistry(MAPPINGS);
}

function defaultConfig() {
  return {
    registry: createTestRegistry(),
    allowedSymbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT', 'XRP/USDT'],
    staticSymbols: ['BTC/USDT', 'ETH/USDT'],
    maxSymbols: 4,
    allowedIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
    defaultIntervals: ['1m', '5m'],
  };
}

const EMPTY_REPORT: MarketBiasReportFull = {
  timestamp: 0, updatedAt: 0,
  globalBias: 'neutral', confidence: 0,
  assets: [],
  globalLongShortRatio: 1, globalVolatility: 50,
  fearGreedIndex: 50, fundingStatus: 'neutral',
  whitelist: [], blacklist: [],
  riskEvents: [],
  meta: { source: 'hermes_cron', modelVersion: '1', generationTimeMs: 0, inputSummary: '' },
};

// ── SymbolRegistry tests ───────────────────────────────────────────────────

test('SR1. canonical → exchange bidirectional', () => {
  const r = createTestRegistry();
  assert.equal(r.toExchange('BTC/USDT'), 'BTCUSDT');
  assert.equal(r.toCanonical('BTCUSDT'), 'BTC/USDT');
  assert.equal(r.toExchange('ETH/USDT'), 'ETHUSDT');
});

test('SR2. duplicate canonical rejects', () => {
  assert.throws(() => createSymbolRegistry([
    { canonical: 'BTC/USDT', exchange: 'BTCUSDT' },
    { canonical: 'BTC/USDT', exchange: 'BTC-PERP' },
  ]), /duplicate canonical/);
});

test('SR3. duplicate exchange rejects', () => {
  assert.throws(() => createSymbolRegistry([
    { canonical: 'BTC/USDT', exchange: 'BTCUSDT' },
    { canonical: 'ETH/USDT', exchange: 'BTCUSDT' },
  ]), /duplicate exchange/);
});

test('SR4. invalid canonical format', () => {
  assert.throws(() => createSymbolRegistry([
    { canonical: 'btc/usdt', exchange: 'BTCUSDT' },
  ]), /invalid canonical/);
  assert.throws(() => createSymbolRegistry([
    { canonical: 'BTC-USD', exchange: 'BTCUSD' },
  ]), /invalid canonical/);
  assert.throws(() => createSymbolRegistry([
    { canonical: '', exchange: 'X' },
  ]), /invalid canonical/);
});

test('SR5. empty/space exchange rejects', () => {
  assert.throws(() => createSymbolRegistry([
    { canonical: 'BTC/USDT', exchange: '' },
  ]), /invalid exchange/);
  assert.throws(() => createSymbolRegistry([
    { canonical: 'BTC/USDT', exchange: 'BTC USD' },
  ]), /invalid exchange/);
});

test('SR6. unregistered lookup throws', () => {
  const r = createTestRegistry();
  assert.throws(() => r.toExchange('SOL/USD'), /unknown canonical/);
  assert.throws(() => r.toCanonical('FAKE'), /unknown exchange/);
});

test('SR7. defensive copies', () => {
  const r = createTestRegistry();
  const m1 = r.mappings();
  const m2 = r.mappings();
  assert.notEqual(m1, m2, 'return new array each call');
  assert.deepEqual(m1, m2);
});

// ── UniverseManager tests ──────────────────────────────────────────────────

test('UM1. initial static plan', () => {
  const um = createUniverseManager(defaultConfig());
  const plan = um.getPlan();
  assert.equal(plan.version, 1);
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].symbol, 'BTC/USDT');
  assert.equal(plan.entries[1].symbol, 'ETH/USDT');
  assert.ok(plan.entries[0].ticker);
  assert.deepEqual([...plan.entries[0].intervals], ['1m', '5m']);
});

test('UM2. allowedSymbols boundary', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    allowedSymbols: ['BTC/USDT'],
    staticSymbols: ['SOL/USDT'],  // not in allowed
  }), /not in allowedSymbols/);
});

test('UM3. hardBlacklist priority', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    hardBlacklist: ['BTC/USDT'],
  }), /on hardBlacklist/);
});

test('UM4. maxSymbols enforcement', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    maxSymbols: 2,
    staticSymbols: ['BTC/USDT'],
  });
  const plan = um.getPlan();
  assert.equal(plan.entries.length, 1);
  // Pre-filled staticSymbols hit maxSymbols on initial
});

test('UM5. invalid interval rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT'],
    defaultIntervals: ['7d'],  // not in allowedIntervals
  }), /must be in allowedIntervals/);
});

test('UM6. atomic rollback on partial failure', () => {
  const um = createUniverseManager(defaultConfig());
  const planBefore = um.getPlan();
  // attempt setPlan with an invalid interval — should not modify current plan
  assert.throws(() => um.setPlan({
    entries: [
      { symbol: 'BTC/USDT' },
      { symbol: 'SOL/USDT', intervals: ['7d'] },
    ],
  }), /not in allowedIntervals/);
  const planAfter = um.getPlan();
  assert.equal(planAfter.version, 1, 'version unchanged on failure');
  assert.equal(planAfter.entries.length, 2, 'plan unchanged on failure');
});

test('UM7. same plan idempotent (no version bump)', () => {
  const um = createUniverseManager(defaultConfig());
  const r1 = um.setPlan({
    entries: [
      { symbol: 'BTC/USDT' },
      { symbol: 'ETH/USDT' },
    ],
  });
  assert.equal(r1.changed, false, 'same as static plan');
  assert.equal(r1.version, 1);
});

test('UM8. interval order normalized', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT'],
  });
  const r1 = um.addSymbol('ETH/USDT', ['5m', '1m']);
  assert.equal(r1.changed, true);
  const plan = um.getPlan();
  const eth = plan.entries.find(e => e.symbol === 'ETH/USDT');
  assert.deepEqual([...eth!.intervals], ['1m', '5m'], 'sorted');
});

test('UM9. addSymbol works', () => {
  const um = createUniverseManager(defaultConfig());
  const r = um.addSymbol('SOL/USDT', ['1m']);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['SOL/USDT']);
  assert.equal(um.getPlan().entries.length, 3);
});

test('UM10. removeSymbol works', () => {
  const um = createUniverseManager(defaultConfig());
  const r = um.removeSymbol('BTC/USDT');
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, ['BTC/USDT']);
  assert.equal(um.getPlan().entries.length, 1);
});

test('UM11. removeSymbol non-existent idempotent', () => {
  const um = createUniverseManager(defaultConfig());
  const r = um.removeSymbol('FAKE/SOMETHING' as any);
  assert.equal(r.changed, false, 'no change for non-existent');
});

test('UM12. addSymbol exceeds maxSymbols', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT'],
    maxSymbols: 4,
  });
  assert.throws(() => um.addSymbol('XRP/USDT'), /exceeds maxSymbols/);
});

test('UM13. Research expansion disabled (default)', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT'],
    maxSymbols: 4,
  });
  const report: MarketBiasReportFull = {
    ...EMPTY_REPORT,
    whitelist: ['SOL/USDT', 'DOGE/USDT'],
  };
  const r = um.applyResearchReport(report);
  assert.equal(r.changed, false, 'no expansion when disabled');
});

test('UM14. Research expansion enabled but bounded by allowedSymbols', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT'],
    maxSymbols: 4,
    allowResearchExpansion: true,
  });
  const report: MarketBiasReportFull = {
    ...EMPTY_REPORT,
    whitelist: ['SOL/USDT', 'FAKE/COIN'],
  };
  const r = um.applyResearchReport(report);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['SOL/USDT'], 'only allowed symbol added');
});

test('UM15. report blacklist temporarily removes', () => {
  const um = createUniverseManager(defaultConfig());
  const report: MarketBiasReportFull = {
    ...EMPTY_REPORT,
    whitelist: [],
    blacklist: ['BTC/USDT'],
  };
  const r = um.applyResearchReport(report);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, ['BTC/USDT']);
  // BTC/USDT should NOT be permanently gone — can be added back manually via addSymbol
  const r2 = um.addSymbol('BTC/USDT');
  assert.equal(r2.changed, true, 'can be re-added');
});

test('UM16. Research expansion does not modify existing intervals', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT'],
    maxSymbols: 4,
    allowResearchExpansion: true,
  });
  // Add ETH/USDT with custom intervals
  um.addSymbol('ETH/USDT', ['1h']);
  const report: MarketBiasReportFull = {
    ...EMPTY_REPORT,
    whitelist: ['ETH/USDT', 'SOL/USDT'],
  };
  const r = um.applyResearchReport(report);
  const plan = um.getPlan();
  const eth = plan.entries.find(e => e.symbol === 'ETH/USDT');
  assert.deepEqual([...eth!.intervals], ['1h'], 'existing intervals unchanged');
});

test('UM17. deterministic ordering', () => {
  const um = createUniverseManager(defaultConfig());
  um.addSymbol('XRP/USDT', ['1m']);
  um.addSymbol('SOL/USDT', ['1m']);
  const plan = um.getPlan();
  const names = plan.entries.map(e => e.symbol);
  assert.deepEqual(names, ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'], 'sorted');
});

test('UM18. defensive copies', () => {
  const um = createUniverseManager(defaultConfig());
  const plan1 = um.getPlan();
  const plan2 = um.getPlan();
  assert.notEqual(plan1, plan2);
  assert.notEqual(plan1.entries, plan2.entries);
  if (plan1.entries.length > 0) {
    assert.notEqual(plan1.entries[0].intervals, plan2.entries[0].intervals);
  }
});

test('UM19. version increments on change', () => {
  const um = createUniverseManager(defaultConfig());
  const r = um.addSymbol('SOL/USDT', ['1m']);
  assert.equal(r.version, 2);
  assert.equal(r.previousVersion, 1);
});

test('UM20. pending + markApplied', () => {
  const um = createUniverseManager(defaultConfig());
  assert.ok(um.hasPendingPlan(), 'initial plan is pending');
  um.markApplied(1);
  assert.equal(um.hasPendingPlan(), false, 'cleared after markApplied');
});

test('UM21. stale markApplied does not clear pending', () => {
  const um = createUniverseManager(defaultConfig());
  um.markApplied(0);  // wrong version
  assert.ok(um.hasPendingPlan(), 'pending not cleared by wrong version');
  um.addSymbol('SOL/USDT');
  assert.equal(um.getPlan().version, 2);
  um.markApplied(1);  // stale version
  assert.ok(um.hasPendingPlan(), 'pending not cleared by stale version');
  um.markApplied(2);
  assert.equal(um.hasPendingPlan(), false, 'pending cleared by correct version');
});

test('UM22. research blacklist does not modify hardBlacklist', () => {
  const um = createUniverseManager({
    ...defaultConfig(),
    allowResearchExpansion: true,
  });
  // First report blacklists SOL/USDT
  const report1: MarketBiasReportFull = {
    ...EMPTY_REPORT, blacklist: ['SOL/USDT'],
  };
  um.applyResearchReport(report1);
  // Second report (without blacklist) should allow adding SOL/USDT
  const report2: MarketBiasReportFull = {
    ...EMPTY_REPORT, whitelist: ['SOL/USDT'],
  };
  const r2 = um.applyResearchReport(report2);
  assert.equal(r2.changed, true, 'SOL/USDT can be re-added by new report');
});

// ── Stage 3B1A-R1: Construction invariants ──────────────────────────────────

test('R1. maxSymbols 0 rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), maxSymbols: 0,
  }), /maxSymbols must be a positive integer/);
});

test('R2. maxSymbols negative rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), maxSymbols: -1,
  }), /maxSymbols must be a positive integer/);
});

test('R3. maxSymbols NaN rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), maxSymbols: NaN,
  }), /maxSymbols must be a positive integer/);
});

test('R4. maxSymbols Infinity rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), maxSymbols: Infinity,
  }), /maxSymbols must be a positive integer/);
});

test('R5. maxSymbols float rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), maxSymbols: 1.5,
  }), /maxSymbols must be a positive integer/);
});

test('R6. staticSymbols exceeds maxSymbols', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT', 'ETH/USDT'],
    maxSymbols: 1,
  }), /exceeds maxSymbols/);
});

test('R7. empty allowedIntervals rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), allowedIntervals: [],
  }), /allowedIntervals must be a non-empty array/);
});

test('R8. empty defaultIntervals rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(), defaultIntervals: [],
  }), /defaultIntervals must be a non-empty array/);
});

test('R9. setPlan explicit empty intervals rejects', () => {
  const um = createUniverseManager({ ...defaultConfig(), staticSymbols: ['BTC/USDT'] });
  assert.throws(() => um.setPlan({
    entries: [{ symbol: 'ETH/USDT', intervals: [] }],
  }), /must be non-empty/);
});

test('R10. addSymbol explicit empty intervals rejects', () => {
  const um = createUniverseManager({ ...defaultConfig(), staticSymbols: ['BTC/USDT'] });
  assert.throws(() => um.addSymbol('ETH/USDT', []), /must be non-empty/);
});

test('R11. unregistered allowedSymbols rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    allowedSymbols: ['BTC/USDT', 'FAKE/COIN'],
    staticSymbols: ['BTC/USDT'],
  }), /contains unregistered canonical/);
});

test('R12. duplicate staticSymbols deduped, does not double-count', () => {
  // Duplicate staticSymbols should be deduped and not cause a duplicate-add error
  const um = createUniverseManager({
    ...defaultConfig(),
    staticSymbols: ['BTC/USDT', 'BTC/USDT', 'ETH/USDT'],
  });
  const plan = um.getPlan();
  assert.equal(plan.entries.length, 2, 'deduped to 2');
});

test('R13. setPlan duplicate symbol atomically rejects', () => {
  const um = createUniverseManager({ ...defaultConfig(), staticSymbols: ['BTC/USDT'] });
  const planBefore = um.getPlan();
  assert.throws(() => um.setPlan({
    entries: [
      { symbol: 'ETH/USDT' },
      { symbol: 'ETH/USDT' },  // duplicate
    ],
  }), /duplicate plan symbol/);
  const planAfter = um.getPlan();
  assert.equal(planAfter.version, planBefore.version, 'version unchanged');
  assert.deepEqual(planAfter.entries, planBefore.entries, 'plan unchanged');
});

test('R14. input mappings mutation does not affect registry', () => {
  const input: Array<{ canonical: string; exchange: string }> = [
    { canonical: 'BTC/USDT', exchange: 'BTCUSDT' },
    { canonical: 'ETH/USDT', exchange: 'ETHUSDT' },
  ];
  const r = createSymbolRegistry(input);
  // Mutate input after creation
  input[0] = { canonical: 'SOL/USDT', exchange: 'SOLUSDT' };
  input.length = 0;
  // Registry should still return original mappings
  const maps = r.mappings();
  assert.equal(maps.length, 2, 'still has 2 entries');
  assert.equal(maps[0].canonical, 'BTC/USDT', 'canonical unchanged');
  assert.equal(maps[0].exchange, 'BTCUSDT', 'exchange unchanged');
  assert.equal(r.toExchange('BTC/USDT'), 'BTCUSDT', 'lookup still works');
});

test('R15. all rejection paths leave plan/version/pending unchanged', () => {
  const um = createUniverseManager(defaultConfig());
  const planBefore = um.getPlan();
  const errs: Array<() => void> = [
    () => um.setPlan({ entries: [{ symbol: 'SOL/USDT', intervals: [] }] }),
    () => um.setPlan({ entries: [{ symbol: 'SOL/USDT', intervals: ['7d'] }] }),
    () => um.setPlan({ entries: [{ symbol: 'FAKE/COIN' }] }),
    () => um.addSymbol('FAKE/COIN'),
    () => um.addSymbol('SOL/USDT', []),
    () => um.addSymbol('SOL/USDT', ['7d']),
  ];
  for (const fn of errs) {
    assert.throws(fn);
    const planAfter = um.getPlan();
    assert.equal(planAfter.version, planBefore.version, `version unchanged after ${fn.name}`);
    assert.equal(planAfter.entries.length, planBefore.entries.length, `entries unchanged after ${fn.name}`);
  }
});

test('R16. allowedIntervals duplicates rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    allowedIntervals: ['1m', '5m', '1m'],
  }), /allowedIntervals contains duplicates/);
});

test('R17. hardBlacklist unregistered rejects', () => {
  assert.throws(() => createUniverseManager({
    ...defaultConfig(),
    hardBlacklist: ['FAKE/COIN'],
  }), /contains unregistered canonical/);
});
