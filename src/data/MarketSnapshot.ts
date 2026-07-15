// Stage 3A2: MarketSnapshot — immutable market state types
// Reuses WsTicker, WsKline directly. No copy/reduction.

import type { WsTicker, WsKline } from './types';

// ── Clock abstraction ───────────────────────────────────────────────────────

export interface Clock {
  now(): number;
}

// ── Wrappers ────────────────────────────────────────────────────────────────

export interface ReceivedTicker {
  readonly ticker: WsTicker;
  readonly receivedAt: number;
}

export interface ReceivedClosedKline {
  readonly kline: WsKline;
  readonly receivedAt: number;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface MarketSnapshot {
  readonly symbol: string;
  readonly ticker: ReceivedTicker | null;
  readonly klines: Readonly<Record<string, ReceivedClosedKline>>;
  readonly snapshotVersion: number;
  readonly generatedAt: number;
  readonly lastUpdatedAt: number;
  readonly ageMs: number;
  readonly isStale: boolean;
}

// ── Store Contract ──────────────────────────────────────────────────────────

export interface MarketSnapshotStore {
  updateTicker(input: {
    ticker: WsTicker;
    receivedAt: number;
  }): MarketSnapshot;

  updateClosedKline(input: {
    kline: WsKline;
    receivedAt: number;
  }): MarketSnapshot;

  getSnapshot(symbol: string): MarketSnapshot | undefined;

  getAllSnapshots(): MarketSnapshot[];

  removeSymbol(symbol: string): boolean;
}
