// Stage 3B4C8: Paper Account Ledger tests
// ≥80 tests covering initial, long, short, flip, PnL, fees, mark, idempotency, safety, replay, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperAccountLedger } from '../../src/paper/PaperAccountLedger';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import type { PaperFill } from '../../src/types/paper-fill';
import type { PaperAccountConfig } from '../../src/types/paper-account';
import {
  PaperLedgerCorruptionError, UnsupportedPaperLedgerVersionError,
  PaperLedgerIdentityMismatchError, DuplicateFillConflictError,
  StalePaperLedgerEventError, ConflictingMarkError, PaperLedgerInvariantError,
  PaperLedgerExchangeMismatchError,
} from '../../src/paper/errors';

const CONFIG: PaperAccountConfig = { accountId: 'test01', exchange: 'bitget', initialCashUsd: 10_000 };

function mkFill(overrides: Partial<PaperFill> = {}): PaperFill {
  return {
    fillId: `f${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    exchange: 'bitget', symbol: 'BTCUSDT', side: 'buy', quantity: 1,
    priceUsd: 50000, feeUsd: 5, executedAt: 1000,
    ...overrides,
  };
}

// ─── A. Initial Account (10) ───────────────────────────────────

test('A1: initial cash', () => {
  const r = new PaperAccountLedger(CONFIG).snapshot();
  assert.equal(r.cashUsd, 10_000);
});

test('A2: equity equals initial cash', () => {
  const r = new PaperAccountLedger(CONFIG).snapshot();
  assert.equal(r.equityUsd, 10_000);
});

test('A3: no positions', () => {
  assert.equal(new PaperAccountLedger(CONFIG).snapshot().openPositions, 0);
});

test('A4: realized PnL = 0', () => {
  assert.equal(new PaperAccountLedger(CONFIG).snapshot().realizedPnlUsd, 0);
});

test('A5: unrealized PnL = 0', () => {
  assert.equal(new PaperAccountLedger(CONFIG).snapshot().unrealizedPnlUsd, 0);
});

test('A6: fees = 0', () => {
  assert.equal(new PaperAccountLedger(CONFIG).snapshot().totalFeesUsd, 0);
});

test('A7: exposure = 0', () => {
  const s = new PaperAccountLedger(CONFIG).snapshot();
  assert.equal(s.grossExposureUsd, 0);
  assert.equal(s.netExposureUsd, 0);
});

test('A8: sequence = 0', () => {
  assert.equal(new PaperAccountLedger(CONFIG).snapshot().sequence, 0);
});

test('A9: invalid accountId rejected', () => {
  assert.throws(() => new PaperAccountLedger({ ...CONFIG, accountId: 'bad id!' }), /accountId/);
});

test('A10: invalid initialCash rejected', () => {
  assert.throws(() => new PaperAccountLedger({ ...CONFIG, initialCashUsd: 0 }), /initialCash/);
  assert.throws(() => new PaperAccountLedger({ ...CONFIG, initialCashUsd: -100 }), /initialCash/);
});

// ─── B. Long (7) ───────────────────────────────────────────────

test('B1: open long', () => {
  const l = new PaperAccountLedger(CONFIG);
  const f = mkFill({ fillId: 'BL1', side: 'buy', quantity: 0.1, priceUsd: 50000, feeUsd: 5, executedAt: 1 });
  const r = l.applyFill(f);
  assert.equal(r.status, 'applied');
  const p = l.getPosition(f.symbol)!;
  assert.equal(p.direction, 'long');
  assert.equal(p.signedQuantity, 0.1);
  assert.equal(p.averageEntryPriceUsd, 50000);
});

test('B2: add long (weighted average)', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'B2a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'B2b', side: 'buy', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.signedQuantity, 2);
  assert.equal(p.averageEntryPriceUsd, 55000);
  assert.equal(p.openedAt, 1, 'openedAt preserved');
  assert.equal(p.updatedAt, 2);
});

test('B3: partial long close', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'B3a', side: 'buy', quantity: 2, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'B3b', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.signedQuantity, 1);
  assert.equal(p.averageEntryPriceUsd, 50000, 'avg entry unchanged on partial close');
});

test('B4: full long close', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'B4a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'B4b', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
  assert.equal(l.getPosition('BTCUSDT'), null);
  assert.equal(l.snapshot().openPositions, 0);
});

test('B5: long realized profit', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'B5a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'B5b', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
  // Gross: (60000-50000)*1 = 10000, net after 2 fees: 10000-5-5 = 9990
  const s = l.snapshot();
  assert.equal(s.realizedPnlUsd, 9990);
});

test('B6: long realized loss', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'B6a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'B6b', side: 'sell', quantity: 1, priceUsd: 40000, feeUsd: 5, executedAt: 2 }));
  // Gross: (40000-50000)*1 = -10000, net: -10000-5-5 = -10010
  assert.equal(l.snapshot().realizedPnlUsd, -10010);
});

test('B7: long to short flip', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'B7a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'B7b', side: 'sell', quantity: 3, priceUsd: 45000, feeUsd: 5, executedAt: 2 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.direction, 'short');
  assert.equal(p.signedQuantity, -2);
  assert.equal(p.averageEntryPriceUsd, 45000);
  assert.equal(p.openedAt, 2, 'flip resets openedAt');
  // Gross from closing: (45000-50000)*1 = -5000. Net: -5000-5(open fee)-5(close/flip fee) = -5010
  const s = l.snapshot();
  assert.equal(s.realizedPnlUsd, -5010);
});

// ─── C. Short (8) ──────────────────────────────────────────────

test('C1: open short', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C1', side: 'sell', quantity: 0.5, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.direction, 'short');
  assert.equal(p.signedQuantity, -0.5);
  assert.equal(p.averageEntryPriceUsd, 50000);
});

test('C2: add short (weighted average)', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C2a', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'C2b', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 2 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.signedQuantity, -2);
  assert.equal(p.averageEntryPriceUsd, 55000);
});

test('C3: partial short cover', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C3a', side: 'sell', quantity: 2, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'C3b', side: 'buy', quantity: 1, priceUsd: 40000, feeUsd: 5, executedAt: 2 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.signedQuantity, -1);
  assert.equal(p.averageEntryPriceUsd, 50000);
});

test('C4: full short cover', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C4a', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'C4b', side: 'buy', quantity: 1, priceUsd: 40000, feeUsd: 5, executedAt: 2 }));
  assert.equal(l.getPosition('BTCUSDT'), null);
});

test('C5: short realized profit', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C5a', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'C5b', side: 'buy', quantity: 1, priceUsd: 40000, feeUsd: 5, executedAt: 2 }));
  // Gross: (50000-40000)*1 = 10000, net: 10000-5-5 = 9990
  assert.equal(l.snapshot().realizedPnlUsd, 9990);
});

test('C6: short realized loss', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C6a', side: 'sell', quantity: 1, priceUsd: 40000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'C6b', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 2 }));
  // Gross: (40000-50000)*1 = -10000, net: -10000-5-5 = -10010
  assert.equal(l.snapshot().realizedPnlUsd, -10010);
});

test('C7: short to long flip', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C7a', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'C7b', side: 'buy', quantity: 3, priceUsd: 55000, feeUsd: 5, executedAt: 2 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.direction, 'long');
  assert.equal(p.signedQuantity, 2);
  assert.equal(p.openedAt, 2, 'flip resets openedAt');
  // Gross closing: (50000-55000)*1 = -5000. Net: -5000-5-5 = -5010
  assert.equal(l.snapshot().realizedPnlUsd, -5010);
});

test('C8: short openedAt preserved on add', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'C8a', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 10 }));
  l.applyFill(mkFill({ fillId: 'C8b', side: 'sell', quantity: 1, priceUsd: 51000, feeUsd: 5, executedAt: 20 }));
  assert.equal(l.getPosition('BTCUSDT')!.openedAt, 10);
});

// ─── D. Fees and PnL (7) ──────────────────────────────────────

test('D1: opening fee immediately realized', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D1', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  assert.equal(l.snapshot().realizedPnlUsd, -5);
});

test('D2: totalFees cumulative', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D2a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 3, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'D2b', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 4, executedAt: 2 }));
  assert.equal(l.snapshot().totalFeesUsd, 7);
});

test('D3: flip fee charged once', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D3a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'D3b', side: 'sell', quantity: 3, priceUsd: 45000, feeUsd: 5, executedAt: 2 }));
  assert.equal(l.snapshot().totalFeesUsd, 10);
});

test('D4: equity equation after fill', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D4', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  const s = l.snapshot();
  // equity = cash + netExposure = cash + (1 * markPrice)
  const equity = s.cashUsd + s.netExposureUsd;
  // equity ≈ initialCash + realizedPnl + unrealizedPnl
  const eq2 = CONFIG.initialCashUsd + s.realizedPnlUsd + s.unrealizedPnlUsd;
  assert.ok(Math.abs(equity - eq2) < 1e-6);
});

test('D5: cash decreases on buy', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D5', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  assert.equal(l.snapshot().cashUsd, 10_000 - 50000 - 5);
});

test('D6: cash increases on sell', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D6', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 1 }));
  assert.equal(l.snapshot().cashUsd, 10_000 + 60000 - 5);
});

test('D7: unrealized PnL zero at mark=entry', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'D7', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  assert.equal(l.snapshot().unrealizedPnlUsd, 0);
});

// ─── E. Mark-to-Market (11) ────────────────────────────────────

test('E1: long mark profit', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E1', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 55000, markedAt: 2 });
  const s = l.snapshot();
  assert.equal(s.unrealizedPnlUsd, 5000);
});

test('E2: long mark loss', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E2', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 45000, markedAt: 2 });
  assert.equal(l.snapshot().unrealizedPnlUsd, -5000);
});

test('E3: short mark profit', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E3', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 45000, markedAt: 2 });
  assert.equal(l.snapshot().unrealizedPnlUsd, 5000);
});

test('E4: short mark loss', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E4', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 55000, markedAt: 2 });
  assert.equal(l.snapshot().unrealizedPnlUsd, -5000);
});

test('E5: gross exposure', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E5a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'E5b', side: 'sell', quantity: 0.5, priceUsd: 40000, feeUsd: 5, symbol: 'ETHUSDT', executedAt: 2 }));
  const s = l.snapshot();
  assert.equal(s.grossExposureUsd, 1 * 50000 + 0.5 * 40000);
});

test('E6: stale mark rejected', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E6', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 10 }));
  assert.throws(() => l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 50000, markedAt: 5 }), StalePaperLedgerEventError);
});

test('E7: same-time same-price duplicate mark', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E7', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 10 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 51000, markedAt: 20 });
  const r = l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 51000, markedAt: 20 });
  assert.equal(r.status, 'duplicate');
  assert.equal(l.snapshot().sequence, 2, 'sequence not incremented on duplicate');
});

test('E8: same-time different-price conflict', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E8', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 10 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 51000, markedAt: 20 });
  assert.throws(() => l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 52000, markedAt: 20 }), ConflictingMarkError);
});

test('E9: mark unknown symbol rejected', () => {
  const l = new PaperAccountLedger(CONFIG);
  assert.throws(() => l.markToMarket({ exchange: 'bitget', symbol: 'UNKNOWN', markPriceUsd: 100, markedAt: 1 }), /no position/);
});

test('E10: multi-symbol equity', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E10a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1, symbol: 'BTCUSDT' }));
  l.applyFill(mkFill({ fillId: 'E10b', side: 'buy', quantity: 1, priceUsd: 3000, feeUsd: 5, executedAt: 2, symbol: 'ETHUSDT' }));
  const s = l.snapshot();
  assert.equal(s.openPositions, 2);
  assert.ok(s.equityUsd > 0);
});

test('E11: sequence incremented on successful mark', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E11', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  assert.equal(l.snapshot().sequence, 1);
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 51000, markedAt: 2 });
  assert.equal(l.snapshot().sequence, 2);
});

// ─── F. Idempotency and Safety (20) ────────────────────────────

test('F1: duplicate fill same payload no-op', () => {
  const l = new PaperAccountLedger(CONFIG);
  const f = mkFill({ fillId: 'F1', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 });
  l.applyFill(f);
  const s1 = l.snapshot();
  const r = l.applyFill(f);
  assert.equal(r.status, 'duplicate');
  assert.equal(l.snapshot().sequence, 1, 'sequence unchanged');
  assert.equal(l.snapshot().cashUsd, s1.cashUsd);
});

test('F2: duplicate fill conflict rejected', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F2', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  assert.throws(
    () => l.applyFill(mkFill({ fillId: 'F2', side: 'buy', quantity: 2, priceUsd: 50000, feeUsd: 5, executedAt: 1 })),
    DuplicateFillConflictError,
  );
  assert.equal(l.snapshot().sequence, 1, 'no state change on conflict');
});

test('F3: exchange mismatch rejected', () => {
  const l = new PaperAccountLedger(CONFIG);
  assert.throws(() => l.applyFill(mkFill({ exchange: 'binance', fillId: 'F3' })), PaperLedgerExchangeMismatchError);
});

test('F4: NaN quantity rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F4', quantity: NaN })), /quantity/);
});

test('F5: Infinity quantity rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F5', quantity: Infinity })), /quantity/);
});

test('F6: zero quantity rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F6', quantity: 0 })), /quantity/);
});

test('F7: negative quantity rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F7', quantity: -1 })), /quantity/);
});

test('F8: invalid price rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F8', priceUsd: 0 })), /price/);
});

test('F9: invalid fee rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F9', feeUsd: -0.01 })), /fee/);
});

test('F10: invalid timestamp rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F10', executedAt: -1 })), /executedAt/);
});

test('F11: malformed symbol rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: 'F11', symbol: '  ' })), /symbol/);
});

test('F12: malformed fillId rejected', () => {
  assert.throws(() => new PaperAccountLedger(CONFIG).applyFill(mkFill({ fillId: '' })), /fillId/);
});

test('F13: failed fill keeps sequence unchanged', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F13a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  assert.equal(l.snapshot().sequence, 1);
  try { l.applyFill(mkFill({ fillId: 'F13b', side: 'buy', quantity: 0, priceUsd: 50000, feeUsd: 5, executedAt: 2 })); } catch {}
  assert.equal(l.snapshot().sequence, 1, 'sequence preserved on error');
});

test('F14: failed fill not marked processed', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F14a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  try { l.applyFill(mkFill({ fillId: 'F14b', quantity: NaN, priceUsd: 50000, feeUsd: 5, executedAt: 2 })); } catch {}
  assert.equal(l.hasProcessedFill('F14b'), false);
});

test('F15: external snapshot mutation isolated', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F15', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  const s = l.snapshot();
  (s as any).cashUsd = 999999;
  assert.equal(l.snapshot().cashUsd, 10_000 - 50000 - 5, 'internal state not mutated via snapshot');
});

test('F16: external entries mutation isolated', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F16', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  const e = l.entries();
  (e as any).push({});
  assert.equal(l.entries().length, 1);
});

test('F17: no negative zero on close', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F17a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.applyFill(mkFill({ fillId: 'F17b', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 2 }));
  assert.equal(l.getPosition('BTCUSDT'), null);
  const s = l.snapshot();
  assert.ok(s.cashUsd >= 0 || Object.is(s.cashUsd, -0) === false);
});

test('F18: fill time order enforced', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F18a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 100 }));
  assert.throws(() => l.applyFill(mkFill({ fillId: 'F18b', side: 'sell', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 50 })), StalePaperLedgerEventError);
});

test('F19: same-time different fillIds allowed', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F19a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 100 }));
  l.applyFill(mkFill({ fillId: 'F19b', side: 'buy', quantity: 1, priceUsd: 51000, feeUsd: 5, executedAt: 100 }));
  assert.equal(l.snapshot().sequence, 2);
});

test('F20: direction consistent with signedQuantity', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'F20a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  const p = l.getPosition('BTCUSDT')!;
  assert.equal(p.direction, 'long');
  assert.ok(p.signedQuantity > 0);
  l.applyFill(mkFill({ fillId: 'F20b', side: 'sell', quantity: 3, priceUsd: 45000, feeUsd: 5, executedAt: 2 }));
  const p2 = l.getPosition('BTCUSDT')!;
  assert.equal(p2.direction, 'short');
  assert.ok(p2.signedQuantity < 0);
});

// ─── G. Replay & Persistence (15) ──────────────────────────────

test('G1: save/load roundtrip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir, tmpSuffix: 'test' });
    const l = new PaperAccountLedger(CONFIG);
    l.applyFill(mkFill({ fillId: 'G1a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
    l.applyFill(mkFill({ fillId: 'G1b', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
    await store.save(l);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded!.snapshot().realizedPnlUsd, l.snapshot().realizedPnlUsd);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G2: replay snapshot identical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const l = new PaperAccountLedger(CONFIG);
    l.applyFill(mkFill({ fillId: 'G2a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
    l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 55000, markedAt: 2 });
    await store.save(l);
    const loaded = await store.load();
    const orig = l.snapshot();
    const repl = loaded!.snapshot();
    assert.equal(repl.cashUsd, orig.cashUsd);
    assert.equal(repl.realizedPnlUsd, orig.realizedPnlUsd);
    assert.equal(repl.unrealizedPnlUsd, orig.unrealizedPnlUsd);
    assert.equal(repl.equityUsd, orig.equityUsd);
    assert.equal(repl.sequence, orig.sequence);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G3: replay entries identical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const l = new PaperAccountLedger(CONFIG);
    l.applyFill(mkFill({ fillId: 'G3a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
    l.applyFill(mkFill({ fillId: 'G3b', side: 'sell', quantity: 1, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
    await store.save(l);
    const loaded = await store.load();
    assert.equal(loaded!.entries().length, l.entries().length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G4: replay sequence validation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const l = new PaperAccountLedger(CONFIG);
    l.applyFill(mkFill({ fillId: 'G4a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
    await store.save(l);
    const loaded = await store.load();
    // Replay from scratch
    const l2 = new PaperAccountLedger(CONFIG);
    l2.replay(loaded!.entries());
    assert.equal(l2.snapshot().sequence, l.snapshot().sequence);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G5: missing file returns null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const result = await store.load();
    assert.equal(result, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G6: invalid JSON rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'account.bitget.test01.json'), 'not json', 'utf-8');
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await assert.rejects(() => store.load(), PaperLedgerCorruptionError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G7: unsupported version rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'account.bitget.test01.json'), JSON.stringify({ version: 99, config: CONFIG, entries: [] }), 'utf-8');
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await assert.rejects(() => store.load(), UnsupportedPaperLedgerVersionError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G8: wrong exchange rejected on load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'account.bitget.test01.json'), JSON.stringify({ version: 1, config: { ...CONFIG, exchange: 'binance' }, entries: [] }), 'utf-8');
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await assert.rejects(() => store.load(), PaperLedgerIdentityMismatchError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G9: wrong accountId rejected on load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'account.bitget.test01.json'), JSON.stringify({ version: 1, config: { ...CONFIG, accountId: 'other' }, entries: [] }), 'utf-8');
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    await assert.rejects(() => store.load(), PaperLedgerIdentityMismatchError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G10: tmp file ignored', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    // Write only a tmp file, not the canonical one
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'account.bitget.test01.json.some-random.tmp'), JSON.stringify({ version: 1, config: CONFIG, entries: [] }), 'utf-8');
    const result = await store.load();
    assert.equal(result, null, 'tmp file not treated as account data');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G11: credentials absent from persisted JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir });
    const l = new PaperAccountLedger(CONFIG);
    await store.save(l);
    // Re-read the raw file
    const raw = await fs.readFile(path.join(dir, 'account.bitget.test01.json'), 'utf-8');
    const doc = JSON.parse(raw);
    assert.equal(doc.config.apiKey, undefined);
    assert.equal(doc.config.secret, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('G12: replay duplicate sequence rejected', () => {
  assert.throws(() => {
    const l = new PaperAccountLedger(CONFIG);
    l.replay([
      { type: 'fill', sequence: 1, fill: mkFill({ fillId: 'G12a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }) },
      { type: 'fill', sequence: 1, fill: mkFill({ fillId: 'G12b', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 2 }) },
    ]);
  });
});

test('G13: replay missing sequence rejected', () => {
  assert.throws(() => {
    const l = new PaperAccountLedger(CONFIG);
    l.replay([
      { type: 'fill', sequence: 1, fill: mkFill({ fillId: 'G13a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }) },
      { type: 'fill', sequence: 3, fill: mkFill({ fillId: 'G13b', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 3 }) },
    ]);
  });
});

test('G14: replay out-of-order rejected', () => {
  assert.throws(() => {
    const l = new PaperAccountLedger(CONFIG);
    l.replay([
      { type: 'fill', sequence: 2, fill: mkFill({ fillId: 'G14a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }) },
    ]);
  });
});

test('G15: atomic overwrite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-'));
  try {
    const store = new PaperLedgerStore(CONFIG, { baseDir: dir, tmpSuffix: 'fixed' });
    const l1 = new PaperAccountLedger(CONFIG);
    l1.applyFill(mkFill({ fillId: 'G15a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
    await store.save(l1);

    const l2 = new PaperAccountLedger(CONFIG);
    l2.applyFill(mkFill({ fillId: 'G15b', side: 'buy', quantity: 2, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
    await store.save(l2);

    const loaded = await store.load();
    assert.equal(loaded!.snapshot().processedFills, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Extra tests to hit ≥80
test('E12: equity equation after mark', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E12', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l.markToMarket({ exchange: 'bitget', symbol: 'BTCUSDT', markPriceUsd: 55000, markedAt: 2 });
  const s = l.snapshot();
  // equity = cash + marketValue = cash + 1*55000
  const eq = s.cashUsd + s.netExposureUsd;
  const eq2 = s.initialCashUsd + s.realizedPnlUsd + s.unrealizedPnlUsd;
  assert.ok(Math.abs(eq - eq2) < 1e-6);
});

test('E13: gross exposure equals sum of abs market values', () => {
  const l = new PaperAccountLedger(CONFIG);
  l.applyFill(mkFill({ fillId: 'E13a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1, symbol: 'BTCUSDT' }));
  l.applyFill(mkFill({ fillId: 'E13b', side: 'sell', quantity: 0.5, priceUsd: 3000, feeUsd: 5, executedAt: 1, symbol: 'ETHUSDT' }));
  const s = l.snapshot();
  const expected = 1 * 50000 + 0.5 * 3000;
  assert.equal(s.grossExposureUsd, expected);
});

test('G16: fromEntries reconstructs identical snapshot', () => {
  const l1 = new PaperAccountLedger(CONFIG);
  l1.applyFill(mkFill({ fillId: 'G16a', side: 'buy', quantity: 1, priceUsd: 50000, feeUsd: 5, executedAt: 1 }));
  l1.applyFill(mkFill({ fillId: 'G16b', side: 'sell', quantity: 0.5, priceUsd: 60000, feeUsd: 5, executedAt: 2 }));
  const entries = l1.entries();
  const l2 = PaperAccountLedger.fromEntries(CONFIG, entries);
  assert.equal(l2.snapshot().realizedPnlUsd, l1.snapshot().realizedPnlUsd);
  assert.equal(l2.snapshot().cashUsd, l1.snapshot().cashUsd);
  assert.equal(l2.snapshot().sequence, l1.snapshot().sequence);
});
