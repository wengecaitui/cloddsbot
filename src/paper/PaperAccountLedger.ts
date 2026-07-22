// Stage 3B4C8: Deterministic Paper Account Ledger
//
// Synchronous, no async, no I/O, no network, no LLM, no randomness.
// Same config + same event sequence = exactly identical state.
// All error classes from './errors'.
// Mutations follow: validate → clone → compute → verify → commit.

import type { ExchangeId } from '../data/MarketIdentity';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import type {
  PaperAccountConfig,
  PaperPosition,
  PaperAccountSnapshot,
  PaperLedgerEntry,
  PaperFillLedgerEntry,
  PaperMarkLedgerEntry,
} from '../types/paper-account';
import { validatePaperAccountConfig } from '../types/paper-account';
import {
  roundUsd, roundQuantity, normalizeZero, assertFinitePositive, assertFiniteNonNegative,
  assertAccountingInvariant, ACCOUNTING_EPSILON,
} from './PaperLedgerMath';
import {
  DuplicateFillConflictError, StalePaperLedgerEventError, ConflictingMarkError,
  PaperLedgerInvariantError, PaperLedgerValidationError, PaperLedgerExchangeMismatchError,
  PaperLedgerCorruptionError,
} from './errors';

// ─── Internal state (never exposed mutably) ────────────────────
interface LedgerState {
  config: PaperAccountConfig;
  cashUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;
  positions: Map<string, PaperPosition>;  // symbol → position
  entries: PaperLedgerEntry[];
  processedFillIds: Map<string, PaperFill>; // fillId → canonical normalized fill
  sequence: number;
  updatedAt: number;
  lastEventAt: Map<string, number>; // symbol → most recent event time
}

function cloneState(s: LedgerState): LedgerState {
  return {
    ...s,
    positions: new Map(s.positions),
    entries: [...s.entries],
    processedFillIds: new Map(s.processedFillIds),
    lastEventAt: new Map(s.lastEventAt),
  };
}

// ─── Helpers ───────────────────────────────────────────────────
function buildSnapshot(s: LedgerState): PaperAccountSnapshot {
  const positions = Array.from(s.positions.values()).map(p => ({ ...p }));
  const grossExposureUsd = positions.reduce((sum, p) => sum + Math.abs(p.marketValueUsd), 0);
  const netExposureUsd = positions.reduce((sum, p) => sum + p.marketValueUsd, 0);
  const equityUsd = roundUsd(s.cashUsd + netExposureUsd);
  return {
    accountId: s.config.accountId,
    exchange: s.config.exchange,
    initialCashUsd: s.config.initialCashUsd,
    cashUsd: s.cashUsd,
    realizedPnlUsd: s.realizedPnlUsd,
    unrealizedPnlUsd: s.unrealizedPnlUsd,
    totalFeesUsd: s.totalFeesUsd,
    equityUsd,
    grossExposureUsd: roundUsd(grossExposureUsd),
    netExposureUsd: roundUsd(netExposureUsd),
    openPositions: s.positions.size,
    processedFills: s.processedFillIds.size,
    sequence: s.sequence,
    updatedAt: s.updatedAt,
    positions,
  };
}

function positionUnrealizedPnl(p: PaperPosition): number {
  const absQty = Math.abs(p.signedQuantity);
  if (p.direction === 'long') {
    return (p.markPriceUsd - p.averageEntryPriceUsd) * absQty;
  }
  return (p.averageEntryPriceUsd - p.markPriceUsd) * absQty;
}

function positionMarketValue(p: PaperPosition): number {
  return roundUsd(p.signedQuantity * p.markPriceUsd);
}

function verifyInvariants(s: LedgerState): void {
  // All fields finite
  if (!Number.isFinite(s.cashUsd)) throw new PaperLedgerInvariantError('cashUsd not finite');
  if (!Number.isFinite(s.realizedPnlUsd)) throw new PaperLedgerInvariantError('realizedPnlUsd not finite');
  if (!Number.isFinite(s.totalFeesUsd)) throw new PaperLedgerInvariantError('totalFeesUsd not finite');
  if (s.totalFeesUsd < 0) throw new PaperLedgerInvariantError(`totalFeesUsd negative: ${s.totalFeesUsd}`);

  // Per-position checks
  let totalUnrealized = 0;
  for (const [symbol, p] of s.positions) {
    if (p.signedQuantity === 0) throw new PaperLedgerInvariantError(`${symbol}: signedQuantity=0 but position exists`);
    const absQty = Math.abs(p.signedQuantity);
    if (absQty < ACCOUNTING_EPSILON) throw new PaperLedgerInvariantError(`${symbol}: near-zero quantity ${absQty}`);
    if (p.direction !== (p.signedQuantity > 0 ? 'long' : 'short'))
      throw new PaperLedgerInvariantError(`${symbol}: direction ${p.direction} inconsistent with signedQuantity ${p.signedQuantity}`);
    if (!Number.isFinite(p.averageEntryPriceUsd) || p.averageEntryPriceUsd <= 0)
      throw new PaperLedgerInvariantError(`${symbol}: invalid averageEntryPriceUsd ${p.averageEntryPriceUsd}`);
    if (!Number.isFinite(p.markPriceUsd) || p.markPriceUsd <= 0)
      throw new PaperLedgerInvariantError(`${symbol}: invalid markPriceUsd ${p.markPriceUsd}`);
    totalUnrealized += p.unrealizedPnlUsd;
  }
  if (s.positions.size !== (new Set(s.positions.keys())).size)
    throw new PaperLedgerInvariantError('duplicate positions');
  if (!Number.isFinite(totalUnrealized)) throw new PaperLedgerInvariantError('total unrealized not finite');
  if (Math.abs(totalUnrealized - s.unrealizedPnlUsd) > ACCOUNTING_EPSILON)
    throw new PaperLedgerInvariantError(`unrealized sum mismatch: position sum=${totalUnrealized} vs state=${s.unrealizedPnlUsd}`);

  // Equity equation: equity ≈ initialCash + realized + unrealized
  const expectedEquity = s.config.initialCashUsd + s.realizedPnlUsd + s.unrealizedPnlUsd;
  assertAccountingInvariant(s.cashUsd + (() => {
    let n = 0; for (const p of s.positions.values()) n += p.marketValueUsd; return n;
  })(), expectedEquity, 'equity equation');
}

function recalcAllUnrealized(state: LedgerState): void {
  let total = 0;
  for (const [, p] of state.positions) {
    p.unrealizedPnlUsd = roundUsd(positionUnrealizedPnl(p));
    p.marketValueUsd = positionMarketValue(p);
    total += p.unrealizedPnlUsd;
  }
  state.unrealizedPnlUsd = roundUsd(total);
}

// ─── PaperAccountLedger ────────────────────────────────────────
export class PaperAccountLedger {
  private state: LedgerState;

  constructor(config: PaperAccountConfig) {
    validatePaperAccountConfig(config);
    this.state = {
      config: { ...config },
      cashUsd: roundUsd(config.initialCashUsd),
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalFeesUsd: 0,
      positions: new Map(),
      entries: [],
      processedFillIds: new Map(),
      sequence: 0,
      updatedAt: 0,
      lastEventAt: new Map(),
    };
  }

  snapshot(): PaperAccountSnapshot {
    return buildSnapshot(this.state);
  }

  entries(): readonly PaperLedgerEntry[] {
    return [...this.state.entries];
  }

  hasProcessedFill(fillId: string): boolean {
    return this.state.processedFillIds.has(fillId);
  }

  getPosition(symbol: string): PaperPosition | null {
    const p = this.state.positions.get(symbol);
    return p ? { ...p } : null;
  }

  applyFill(fill: PaperFill): { status: 'applied' | 'duplicate'; snapshot: PaperAccountSnapshot } {
    validatePaperFill(fill);
    this.assertExchangeMatch(fill.exchange);
    this.assertTimeOrder(fill.symbol, fill.executedAt);

    // Idempotency check
    const existing = this.state.processedFillIds.get(fill.fillId);
    if (existing) {
      if (fillsEqual(existing, fill)) {
        return { status: 'duplicate', snapshot: this.snapshot() };
      }
      throw new DuplicateFillConflictError(
        `fillId ${fill.fillId}: existing ${JSON.stringify(normalizeFill(existing))} vs new ${JSON.stringify(normalizeFill(fill))}`,
      );
    }

    // Clone → compute candidate
    const candidate = cloneState(this.state);
    applyFillToState(candidate, fill);
    recalcAllUnrealized(candidate);

    // Verify
    try { verifyInvariants(candidate); } catch (e) {
      throw new PaperLedgerInvariantError(`fill ${fill.fillId}: ${(e as Error).message}`);
    }

    // Commit
    this.state = candidate;
    this.state.processedFillIds.set(fill.fillId, normalizeFill(fill));
    this.state.sequence += 1;
    this.state.updatedAt = Math.max(this.state.updatedAt, fill.executedAt);
    this.state.lastEventAt.set(fill.symbol, fill.executedAt);
    this.state.entries.push({ type: 'fill', sequence: this.state.sequence, fill });

    return { status: 'applied', snapshot: this.snapshot() };
  }

  markToMarket(input: {
    exchange: ExchangeId;
    symbol: string;
    markPriceUsd: number;
    markedAt: number;
  }): { status: 'applied' | 'duplicate'; snapshot: PaperAccountSnapshot } {
    const { exchange, symbol, markPriceUsd, markedAt } = input;
    this.assertExchangeMatch(exchange);
    if (!this.state.positions.has(symbol)) {
      throw new PaperLedgerValidationError(`mark: no position for ${symbol}`);
    }
    assertFinitePositive(markPriceUsd, 'markPriceUsd');
    if (typeof markedAt !== 'number' || !Number.isFinite(markedAt) || !Number.isInteger(markedAt) || markedAt < 0) {
      throw new PaperLedgerValidationError(`mark: markedAt must be non-negative integer, got ${markedAt}`);
    }

    const lastTime = this.state.lastEventAt.get(symbol) ?? 0;
    if (markedAt < lastTime) {
      throw new StalePaperLedgerEventError(`mark: ${symbol} markedAt ${markedAt} < lastEvent ${lastTime}`);
    }
    if (markedAt === lastTime) {
      // Same time check
      const lastMark = [...this.state.entries].reverse().find(
        (e): e is PaperMarkLedgerEntry => e.type === 'mark' && e.symbol === symbol && e.markedAt === markedAt,
      );
      if (lastMark) {
        if (lastMark.markPriceUsd === markPriceUsd) {
          return { status: 'duplicate', snapshot: this.snapshot() };
        }
        throw new ConflictingMarkError(
          `mark: ${symbol} at ${markedAt}: existing price ${lastMark.markPriceUsd} vs new ${markPriceUsd}`,
        );
      }
    }

    // No conflict found at same time without prior mark — proceed
    // Clone and apply
    const candidate = cloneState(this.state);
    const pos = candidate.positions.get(symbol);
    if (!pos) throw new PaperLedgerValidationError(`mark: no position for ${symbol}`);
    pos.markPriceUsd = markPriceUsd;
    pos.updatedAt = markedAt;
    recalcAllUnrealized(candidate);

    try { verifyInvariants(candidate); } catch (e) {
      throw new PaperLedgerInvariantError(`mark ${symbol}@${markedAt}: ${(e as Error).message}`);
    }

    this.state = candidate;
    this.state.sequence += 1;
    this.state.updatedAt = Math.max(this.state.updatedAt, markedAt);
    this.state.lastEventAt.set(symbol, markedAt);
    this.state.entries.push({ type: 'mark', sequence: this.state.sequence, exchange, symbol, markPriceUsd, markedAt });

    return { status: 'applied', snapshot: this.snapshot() };
  }

  replay(entries: readonly PaperLedgerEntry[]): void {
    // Reset to initial state and replay from scratch
    this.state = {
      config: { ...this.state.config },
      cashUsd: roundUsd(this.state.config.initialCashUsd),
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalFeesUsd: 0,
      positions: new Map(),
      entries: [],
      processedFillIds: new Map(),
      sequence: 0,
      updatedAt: 0,
      lastEventAt: new Map(),
    };

    let expectedSeq = 0;
    for (const entry of entries) {
      expectedSeq += 1;
      if (entry.sequence !== expectedSeq) {
        throw new PaperLedgerCorruptionError(
          `replay: expected sequence ${expectedSeq}, got ${entry.sequence}`,
        );
      }
      if (entry.type === 'fill') {
        this.applyFill(entry.fill);
      } else if (entry.type === 'mark') {
        this.markToMarket({
          exchange: entry.exchange,
          symbol: entry.symbol,
          markPriceUsd: entry.markPriceUsd,
          markedAt: entry.markedAt,
        });
      }
    }
  }

  static fromEntries(config: PaperAccountConfig, entries: readonly PaperLedgerEntry[]): PaperAccountLedger {
    const ledger = new PaperAccountLedger(config);
    ledger.replay(entries);
    return ledger;
  }

  private assertExchangeMatch(exchange: ExchangeId): void {
    if (exchange !== this.state.config.exchange) {
      throw new PaperLedgerExchangeMismatchError(
        `Ledger exchange ${this.state.config.exchange}, got ${JSON.stringify(exchange)}`,
      );
    }
  }

  private assertTimeOrder(symbol: string, time: number): void {
    const last = this.state.lastEventAt.get(symbol);
    if (last != null && time < last) {
      throw new StalePaperLedgerEventError(`${symbol}: time ${time} < lastEventAt ${last}`);
    }
  }
}

// ─── Fill helpers (module-level, no state access) ──────────────

function normalizeFill(f: PaperFill): PaperFill {
  return {
    fillId: f.fillId,
    exchange: f.exchange,
    symbol: f.symbol,
    side: f.side,
    quantity: f.quantity,
    priceUsd: f.priceUsd,
    feeUsd: f.feeUsd,
    executedAt: f.executedAt,
  };
}

function fillsEqual(a: PaperFill, b: PaperFill): boolean {
  return (
    a.fillId === b.fillId &&
    a.exchange === b.exchange &&
    a.symbol === b.symbol &&
    a.side === b.side &&
    a.quantity === b.quantity &&
    a.priceUsd === b.priceUsd &&
    a.feeUsd === b.feeUsd &&
    a.executedAt === b.executedAt
  );
}

// ─── State mutation (used during candidate computation) ────────

function applyFillToState(s: LedgerState, fill: PaperFill): void {
  const qty = fill.quantity;
  const price = fill.priceUsd;
  const fee = fill.feeUsd;
  const side = fill.side;

  // Cash and fee accounting
  s.totalFeesUsd = roundUsd(s.totalFeesUsd + fee);

  const pos = s.positions.get(fill.symbol) ?? null;
  const oldSigned = pos?.signedQuantity ?? 0;
  const oldAvgEntry = pos?.averageEntryPriceUsd ?? 0;

  if (side === 'buy') {
    // Buy: cash decreases by (qty × price + fee)
    s.cashUsd = roundUsd(s.cashUsd - qty * price - fee);
  } else {
    // Sell: cash increases by (qty × price - fee)
    s.cashUsd = roundUsd(s.cashUsd + qty * price - fee);
  }

  // Determine what happens to the position
  if (oldSigned === 0) {
    // Opening new position
    const signedQty = side === 'buy' ? qty : -qty;
    const direction = side === 'buy' ? 'long' as const : 'short' as const;
    s.positions.set(fill.symbol, {
      exchange: fill.exchange,
      symbol: fill.symbol,
      direction,
      signedQuantity: roundQuantity(signedQty),
      averageEntryPriceUsd: price,
      markPriceUsd: price,
      marketValueUsd: 0, // computed later
      unrealizedPnlUsd: 0,
      openedAt: fill.executedAt,
      updatedAt: fill.executedAt,
    });
    // Realized PnL: opening fee only
    s.realizedPnlUsd = roundUsd(s.realizedPnlUsd - fee);
  } else if ((side === 'buy' && oldSigned > 0) || (side === 'sell' && oldSigned < 0)) {
    // Same direction — add to position
    const oldAbs = Math.abs(oldSigned);
    const newAbs = oldAbs + qty;
    const newAvg = (oldAbs * oldAvgEntry + qty * price) / newAbs;
    pos!.averageEntryPriceUsd = newAvg;
    pos!.signedQuantity = roundQuantity(oldSigned > 0 ? newAbs : -newAbs);
    pos!.markPriceUsd = price;
    pos!.updatedAt = fill.executedAt;
    // openerAt preserved
    s.positions.set(fill.symbol, pos!);
    s.realizedPnlUsd = roundUsd(s.realizedPnlUsd - fee);
  } else if ((side === 'sell' && oldSigned > 0) || (side === 'buy' && oldSigned < 0)) {
    // Opposite direction — close or flip
    const oldAbs = Math.abs(oldSigned);
    if (qty <= oldAbs) {
      // Partial or full close
      const closeQty = qty;
      const realizedGross = oldSigned > 0
        ? (price - oldAvgEntry) * closeQty   // long sell
        : (oldAvgEntry - price) * closeQty;   // short cover
      s.realizedPnlUsd = roundUsd(s.realizedPnlUsd + realizedGross - fee);

      const remainingAbs = oldAbs - closeQty;
      if (normalizeZero(remainingAbs) === 0) {
        s.positions.delete(fill.symbol);
      } else {
        pos!.signedQuantity = roundQuantity(oldSigned > 0 ? remainingAbs : -remainingAbs);
        pos!.markPriceUsd = price;
        pos!.updatedAt = fill.executedAt;
        s.positions.set(fill.symbol, pos!);
      }
    } else {
      // Flip — close entire old position, open new opposite
      const closeQty = oldAbs;
      const newQty = qty - oldAbs;

      // Realized from closing
      const realizedGross = oldSigned > 0
        ? (price - oldAvgEntry) * closeQty
        : (oldAvgEntry - price) * closeQty;
      s.realizedPnlUsd = roundUsd(s.realizedPnlUsd + realizedGross - fee);

      // Remove old position
      s.positions.delete(fill.symbol);

      // Open new opposite position
      const newDir = side === 'buy' ? 'long' as const : 'short' as const;
      const newSigned = side === 'buy' ? newQty : -newQty;
      s.positions.set(fill.symbol, {
        exchange: fill.exchange,
        symbol: fill.symbol,
        direction: newDir,
        signedQuantity: roundQuantity(newSigned),
        averageEntryPriceUsd: price,
        markPriceUsd: price,
        marketValueUsd: 0,
        unrealizedPnlUsd: 0,
        openedAt: fill.executedAt,
        updatedAt: fill.executedAt,
      });
    }
  }
}
