// Stage 3B4C8-R1: Deterministic Paper Account Ledger — deep clone, immutable, atomic replay.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import type {
  PaperAccountConfig, PaperPosition, PaperAccountSnapshot,
  PaperLedgerEntry, PaperFillLedgerEntry, PaperMarkLedgerEntry,
} from '../types/paper-account';
import { validatePaperAccountConfig } from '../types/paper-account';
import {
  roundUsd, roundQuantity, normalizeZero, assertFinitePositive,
  assertAccountingInvariant, ACCOUNTING_EPSILON, QUANTITY_EPSILON,
} from './PaperLedgerMath';
import {
  DuplicateFillConflictError, StalePaperLedgerEventError, ConflictingMarkError,
  PaperLedgerInvariantError, PaperLedgerValidationError, PaperLedgerExchangeMismatchError,
  PaperLedgerCorruptionError,
} from './errors';

// ═══ Deep clone helpers (R1) ═══════════════════════════════════════
function cloneConfig(c: PaperAccountConfig): PaperAccountConfig {
  return { accountId: c.accountId, exchange: c.exchange, initialCashUsd: c.initialCashUsd };
}

function clonePosition(p: PaperPosition): PaperPosition {
  return { ...p };
}

function cloneFill(f: PaperFill): PaperFill {
  return {
    fillId: f.fillId, exchange: f.exchange, symbol: f.symbol,
    side: f.side, quantity: f.quantity, priceUsd: f.priceUsd, feeUsd: f.feeUsd, executedAt: f.executedAt,
  };
}

function cloneEntry(e: PaperLedgerEntry): PaperLedgerEntry {
  if (e.type === 'fill') return { type: 'fill', sequence: e.sequence, fill: cloneFill(e.fill) };
  return { type: 'mark', sequence: e.sequence, exchange: e.exchange, symbol: e.symbol, markPriceUsd: e.markPriceUsd, markedAt: e.markedAt };
}

// ─── Internal state ──────────────────────────────────────────────
interface LedgerState {
  config: PaperAccountConfig;
  cashUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;
  positions: Map<string, PaperPosition>;
  entries: PaperLedgerEntry[];
  processedFillIds: Map<string, PaperFill>;
  sequence: number;
  updatedAt: number;
  lastEventAt: Map<string, number>;
}

function cloneState(s: LedgerState): LedgerState {
  const positions = new Map<string, PaperPosition>();
  for (const [k, v] of s.positions) positions.set(k, clonePosition(v));
  const processedFillIds = new Map<string, PaperFill>();
  for (const [k, v] of s.processedFillIds) processedFillIds.set(k, cloneFill(v));
  return {
    config: cloneConfig(s.config),
    cashUsd: s.cashUsd,
    realizedPnlUsd: s.realizedPnlUsd,
    unrealizedPnlUsd: s.unrealizedPnlUsd,
    totalFeesUsd: s.totalFeesUsd,
    positions,
    entries: s.entries.map(cloneEntry),
    processedFillIds,
    sequence: s.sequence,
    updatedAt: s.updatedAt,
    lastEventAt: new Map(s.lastEventAt),
  };
}

function canonicalizeFill(f: PaperFill): PaperFill {
  const validated = validatePaperFill(f);
  const qty = roundQuantity(validated.quantity);
  if (qty <= 0) throw new Error('PaperFill: quantity must be a finite positive number after canonicalization');
  return {
    fillId: validated.fillId,
    exchange: validated.exchange,
    symbol: validated.symbol,
    side: validated.side,
    quantity: qty,
    priceUsd: roundUsd(validated.priceUsd),
    feeUsd: roundUsd(validated.feeUsd),
    executedAt: validated.executedAt,
  };
}

function fillsEqual(a: PaperFill, b: PaperFill): boolean {
  return a.fillId === b.fillId && a.exchange === b.exchange && a.symbol === b.symbol &&
    a.side === b.side && a.quantity === b.quantity && a.priceUsd === b.priceUsd &&
    a.feeUsd === b.feeUsd && a.executedAt === b.executedAt;
}

// ─── Snapshot & helpers ─────────────────────────────────────────
function buildSnapshot(s: LedgerState): PaperAccountSnapshot {
  const positions: PaperPosition[] = [];
  for (const p of s.positions.values()) positions.push(clonePosition(p));
  const gross = positions.reduce((sum, p) => sum + Math.abs(p.marketValueUsd), 0);
  const net = positions.reduce((sum, p) => sum + p.marketValueUsd, 0);
  return {
    accountId: s.config.accountId, exchange: s.config.exchange,
    initialCashUsd: s.config.initialCashUsd,
    cashUsd: s.cashUsd, realizedPnlUsd: s.realizedPnlUsd,
    unrealizedPnlUsd: s.unrealizedPnlUsd, totalFeesUsd: s.totalFeesUsd,
    equityUsd: roundUsd(s.cashUsd + net),
    grossExposureUsd: roundUsd(gross), netExposureUsd: roundUsd(net),
    openPositions: s.positions.size, processedFills: s.processedFillIds.size,
    sequence: s.sequence, updatedAt: s.updatedAt, positions,
  };
}

function positionUnrealizedPnl(p: PaperPosition): number {
  const absQty = Math.abs(p.signedQuantity);
  return p.direction === 'long'
    ? (p.markPriceUsd - p.averageEntryPriceUsd) * absQty
    : (p.averageEntryPriceUsd - p.markPriceUsd) * absQty;
}

function positionMarketValue(p: PaperPosition): number {
  return roundUsd(p.signedQuantity * p.markPriceUsd);
}

function verifyInvariants(s: LedgerState): void {
  if (!Number.isFinite(s.cashUsd)) throw new PaperLedgerInvariantError('cashUsd not finite');
  if (s.totalFeesUsd < 0) throw new PaperLedgerInvariantError(`totalFeesUsd negative: ${s.totalFeesUsd}`);
  let totalUnreal = 0;
  for (const [sym, p] of s.positions) {
    if (p.signedQuantity === 0) throw new PaperLedgerInvariantError(`${sym}: signedQuantity=0`);
    if (p.direction !== (p.signedQuantity > 0 ? 'long' : 'short'))
      throw new PaperLedgerInvariantError(`${sym}: direction mismatch`);
    if (!Number.isFinite(p.averageEntryPriceUsd) || p.averageEntryPriceUsd <= 0)
      throw new PaperLedgerInvariantError(`${sym}: invalid avg entry ${p.averageEntryPriceUsd}`);
    if (!Number.isFinite(p.markPriceUsd) || p.markPriceUsd <= 0)
      throw new PaperLedgerInvariantError(`${sym}: invalid mark ${p.markPriceUsd}`);
    totalUnreal += p.unrealizedPnlUsd;
  }
  if (Math.abs(totalUnreal - roundUsd(s.unrealizedPnlUsd)) > ACCOUNTING_EPSILON || !Number.isFinite(totalUnreal))
    throw new PaperLedgerInvariantError(`unrealized sum mismatch: ${totalUnreal} vs ${s.unrealizedPnlUsd}`);
}

function recalcAllUnrealized(st: LedgerState): void {
  let total = 0;
  for (const [, p] of st.positions) {
    p.unrealizedPnlUsd = roundUsd(positionUnrealizedPnl(p));
    p.marketValueUsd = positionMarketValue(p);
    total += p.unrealizedPnlUsd;
  }
  st.unrealizedPnlUsd = roundUsd(total);
}

// ─── Apply fill to state (candidate computation) ─────────────────
function applyFillToState(s: LedgerState, fill: PaperFill): void {
  const qty = fill.quantity; const price = fill.priceUsd;
  const fee = fill.feeUsd; const side = fill.side;
  s.totalFeesUsd = roundUsd(s.totalFeesUsd + fee);
  if (side === 'buy') s.cashUsd = roundUsd(s.cashUsd - qty * price - fee);
  else s.cashUsd = roundUsd(s.cashUsd + qty * price - fee);

  const pos = s.positions.get(fill.symbol) ?? null;
  const oldSigned = pos?.signedQuantity ?? 0;
  const oldAvg = pos?.averageEntryPriceUsd ?? 0;

  if (oldSigned === 0) {
    const signedQty = side === 'buy' ? qty : -qty;
    s.positions.set(fill.symbol, {
      exchange: fill.exchange, symbol: fill.symbol,
      direction: side === 'buy' ? 'long' : 'short',
      signedQuantity: roundQuantity(signedQty),
      averageEntryPriceUsd: price, markPriceUsd: price,
      marketValueUsd: 0, unrealizedPnlUsd: 0,
      openedAt: fill.executedAt, updatedAt: fill.executedAt,
    });
    s.realizedPnlUsd = roundUsd(s.realizedPnlUsd - fee);
  } else if ((side === 'buy' && oldSigned > 0) || (side === 'sell' && oldSigned < 0)) {
    const oldAbs = Math.abs(oldSigned);
    const newAbs = oldAbs + qty;
    const newAvg = (oldAbs * oldAvg + qty * price) / newAbs;
    pos!.averageEntryPriceUsd = roundUsd(newAvg);
    pos!.signedQuantity = roundQuantity(oldSigned > 0 ? newAbs : -newAbs);
    pos!.markPriceUsd = price; pos!.updatedAt = fill.executedAt;
    s.realizedPnlUsd = roundUsd(s.realizedPnlUsd - fee);
  } else {
    const oldAbs = Math.abs(oldSigned);
    if (qty <= oldAbs) {
      const realizedGross = oldSigned > 0 ? (price - oldAvg) * qty : (oldAvg - price) * qty;
      s.realizedPnlUsd = roundUsd(s.realizedPnlUsd + realizedGross - fee);
      const rem = roundQuantity(oldAbs - qty);
      if (normalizeZero(rem, QUANTITY_EPSILON) === 0) {
        s.positions.delete(fill.symbol);
      } else {
        pos!.signedQuantity = roundQuantity(oldSigned > 0 ? rem : -rem);
        pos!.markPriceUsd = price; pos!.updatedAt = fill.executedAt;
      }
    } else {
      const closeQty = oldAbs;
      const newQty = roundQuantity(qty - oldAbs);
      const realizedGross = oldSigned > 0 ? (price - oldAvg) * closeQty : (oldAvg - price) * closeQty;
      s.realizedPnlUsd = roundUsd(s.realizedPnlUsd + realizedGross - fee);
      s.positions.delete(fill.symbol);
      if (normalizeZero(newQty, QUANTITY_EPSILON) > 0) {
        const newDir = side === 'buy' ? 'long' as const : 'short' as const;
        s.positions.set(fill.symbol, {
          exchange: fill.exchange, symbol: fill.symbol, direction: newDir,
          signedQuantity: roundQuantity(side === 'buy' ? newQty : -newQty),
          averageEntryPriceUsd: price, markPriceUsd: price,
          marketValueUsd: 0, unrealizedPnlUsd: 0,
          openedAt: fill.executedAt, updatedAt: fill.executedAt,
        });
      }
    }
  }
}

// ═══ PaperAccountLedger ══════════════════════════════════════════
export class PaperAccountLedger {
  private state: LedgerState;

  constructor(config: PaperAccountConfig) {
    validatePaperAccountConfig(config);
    this.state = {
      config: cloneConfig(config),
      cashUsd: roundUsd(config.initialCashUsd),
      realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalFeesUsd: 0,
      positions: new Map(), entries: [], processedFillIds: new Map(),
      sequence: 0, updatedAt: 0, lastEventAt: new Map(),
    };
  }

  getConfig(): PaperAccountConfig { return cloneConfig(this.state.config); }
  snapshot(): PaperAccountSnapshot { return buildSnapshot(this.state); }
  entries(): readonly PaperLedgerEntry[] { return this.state.entries.map(cloneEntry); }
  hasProcessedFill(fillId: string): boolean { return this.state.processedFillIds.has(fillId); }
  getPosition(symbol: string): PaperPosition | null {
    const p = this.state.positions.get(symbol);
    return p ? clonePosition(p) : null;
  }

  applyFill(fill: PaperFill): { status: 'applied' | 'duplicate'; snapshot: PaperAccountSnapshot } {
    // 1. validate
    const raw = validatePaperFill(fill);
    // 2. validate exchange
    if (!isExchangeId(raw.exchange)) throw new PaperLedgerValidationError(`PaperFill: invalid ExchangeId ${JSON.stringify(raw.exchange)}`);
    this.assertExchangeMatch(raw.exchange);
    // 3. canonicalize
    const canonical = canonicalizeFill(raw);
    // 4-6. idempotency (BEFORE time check)
    const existing = this.state.processedFillIds.get(canonical.fillId);
    if (existing) {
      if (fillsEqual(existing, canonical)) return { status: 'duplicate', snapshot: this.snapshot() };
      throw new DuplicateFillConflictError(`fillId ${canonical.fillId}: conflict`);
    }
    // 7. time order
    this.assertTimeOrder(canonical.symbol, canonical.executedAt);
    // 8. compute on clone
    const candidate = cloneState(this.state);
    applyFillToState(candidate, canonical);
    recalcAllUnrealized(candidate);
    try { verifyInvariants(candidate); } catch (e) {
      throw new PaperLedgerInvariantError(`fill ${canonical.fillId}: ${(e as Error).message}`);
    }
    // commit
    this.state = candidate;
    this.state.processedFillIds.set(canonical.fillId, canonical);
    this.state.sequence += 1;
    this.state.updatedAt = Math.max(this.state.updatedAt, canonical.executedAt);
    this.state.lastEventAt.set(canonical.symbol, canonical.executedAt);
    this.state.entries.push({ type: 'fill', sequence: this.state.sequence, fill: canonical });
    return { status: 'applied', snapshot: this.snapshot() };
  }

  markToMarket(input: { exchange: ExchangeId; symbol: string; markPriceUsd: number; markedAt: number }): { status: 'applied' | 'duplicate'; snapshot: PaperAccountSnapshot } {
    const { exchange, symbol, markPriceUsd: rawPrice, markedAt } = input;
    if (!isExchangeId(exchange)) throw new PaperLedgerValidationError(`mark: invalid ExchangeId ${JSON.stringify(exchange)}`);
    this.assertExchangeMatch(exchange);
    const markPriceUsd = roundUsd(rawPrice);
    assertFinitePositive(markPriceUsd, 'markPriceUsd');
    if (!Number.isInteger(markedAt) || markedAt < 0) throw new PaperLedgerValidationError(`markedAt invalid: ${markedAt}`);

    const pos = this.state.positions.get(symbol);
    if (!pos) throw new PaperLedgerValidationError(`mark: no position for ${symbol}`);

    const lastTime = this.state.lastEventAt.get(symbol) ?? 0;
    if (markedAt < lastTime) throw new StalePaperLedgerEventError(`mark stale: ${symbol} ${markedAt} < ${lastTime}`);
    // Same-time: compare with current position.markPriceUsd (R1 fix)
    if (markedAt === lastTime) {
      if (pos.markPriceUsd === markPriceUsd) return { status: 'duplicate', snapshot: this.snapshot() };
      throw new ConflictingMarkError(`mark conflict: ${symbol}@${markedAt}: current ${pos.markPriceUsd} vs new ${markPriceUsd}`);
    }

    const candidate = cloneState(this.state);
    const cpos = candidate.positions.get(symbol)!;
    cpos.markPriceUsd = markPriceUsd; cpos.updatedAt = markedAt;
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

  // Atomic replay (R1): temp ledger, no clear until all pass
  replay(entries: readonly PaperLedgerEntry[]): void {
    if (!Array.isArray(entries)) throw new PaperLedgerCorruptionError('entries must be an array');
    const temp = new PaperAccountLedger(this.state.config);
    let expectedSeq = 0;
    for (const e of entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e))
        throw new PaperLedgerCorruptionError(`invalid entry: ${JSON.stringify(e)}`);
      expectedSeq += 1;
      if (e.sequence !== expectedSeq)
        throw new PaperLedgerCorruptionError(`sequence: expected ${expectedSeq}, got ${e.sequence}`);
      if (e.type === 'fill') {
        if (!e.fill) throw new PaperLedgerCorruptionError('fill entry missing fill');
        temp.applyFill(e.fill);
      } else if (e.type === 'mark') {
        const m = e as PaperMarkLedgerEntry;
        if (!m.symbol || !m.markPriceUsd) throw new PaperLedgerCorruptionError('malformed mark entry');
        temp.markToMarket({ exchange: m.exchange, symbol: m.symbol, markPriceUsd: m.markPriceUsd, markedAt: m.markedAt });
      } else {
        throw new PaperLedgerCorruptionError(`unknown entry type: ${(e as any).type}`);
      }
    }
    // Verify final state
    verifyInvariants(temp.state);
    if (temp.state.entries.length !== entries.length) throw new PaperLedgerCorruptionError('entry count mismatch after replay');
    // Atomic swap
    this.state = temp.state;
  }

  static fromEntries(config: PaperAccountConfig, entries: readonly PaperLedgerEntry[]): PaperAccountLedger {
    const ledger = new PaperAccountLedger(config);
    ledger.replay(entries);
    return ledger;
  }

  private assertExchangeMatch(exchange: ExchangeId): void {
    if (exchange !== this.state.config.exchange)
      throw new PaperLedgerExchangeMismatchError(`exchange: ${JSON.stringify(exchange)} vs ${this.state.config.exchange}`);
  }
  private assertTimeOrder(symbol: string, time: number): void {
    const last = this.state.lastEventAt.get(symbol);
    if (last != null && time < last) throw new StalePaperLedgerEventError(`${symbol}: time ${time} < ${last}`);
  }
}
