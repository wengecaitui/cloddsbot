// Stage 3B4C8: Paper Account types — config, position, snapshot, ledger entries.

import type { ExchangeId } from '../data/MarketIdentity';
import type { PaperFill } from './paper-fill';

// ─── Config ────────────────────────────────────────────────────
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface PaperAccountConfig {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly initialCashUsd: number;
}

export function validatePaperAccountConfig(c: PaperAccountConfig): PaperAccountConfig {
  if (!c.accountId || typeof c.accountId !== 'string' || !ACCOUNT_ID_RE.test(c.accountId)) {
    throw new Error(`PaperAccountConfig: accountId must match ${ACCOUNT_ID_RE}, got ${JSON.stringify(c.accountId)}`);
  }
  if (typeof c.initialCashUsd !== 'number' || !Number.isFinite(c.initialCashUsd) || c.initialCashUsd <= 0) {
    throw new Error(`PaperAccountConfig: initialCashUsd must be a finite positive number, got ${c.initialCashUsd}`);
  }
  return c;
}

// ─── Position ──────────────────────────────────────────────────
export interface PaperPosition {
  exchange: ExchangeId;
  symbol: string;
  direction: 'long' | 'short';
  signedQuantity: number;
  averageEntryPriceUsd: number;
  markPriceUsd: number;
  marketValueUsd: number;
  unrealizedPnlUsd: number;
  openedAt: number;
  updatedAt: number;
}

// ─── Snapshot ──────────────────────────────────────────────────
export interface PaperAccountSnapshot {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly initialCashUsd: number;
  readonly cashUsd: number;
  readonly realizedPnlUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly totalFeesUsd: number;
  readonly equityUsd: number;
  readonly grossExposureUsd: number;
  readonly netExposureUsd: number;
  readonly openPositions: number;
  readonly processedFills: number;
  readonly sequence: number;
  readonly updatedAt: number;
  readonly positions: readonly PaperPosition[];
}

// ─── Ledger Entries ────────────────────────────────────────────
export interface PaperFillLedgerEntry {
  readonly type: 'fill';
  readonly sequence: number;
  readonly fill: PaperFill;
}

export interface PaperMarkLedgerEntry {
  readonly type: 'mark';
  readonly sequence: number;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly markPriceUsd: number;
  readonly markedAt: number;
}

export type PaperLedgerEntry = PaperFillLedgerEntry | PaperMarkLedgerEntry;

// ─── Persistence Document ──────────────────────────────────────
export interface PaperLedgerDocumentV1 {
  readonly version: 1;
  readonly config: PaperAccountConfig;
  readonly entries: readonly PaperLedgerEntry[];
}
