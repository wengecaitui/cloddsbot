// Stage 3B4C14: Execution quote — market data captured from the same MarketSnapshot used for execution.
import type { ExchangeId } from '../data/MarketIdentity';

export interface ExecutionQuote {
  readonly exchange: ExchangeId;
  readonly symbol: string;
  /** Price from ticker.last — the markPriceUsd for fill simulation. */
  readonly markPriceUsd: number;
  /** Timestamp from ticker.ts — the executedAtMs for fill simulation. */
  readonly executedAtMs: number;
  /** Snapshot version for audit trail correlation. */
  readonly snapshotVersion: number;
}
