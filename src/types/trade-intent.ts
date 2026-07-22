// Stage 3B4C7: Risk-Admitted Trade Intent
// Immutable contract between FastPipeline decision and future Paper Broker.
// Contains no API keys, account credentials, exchange order IDs, fills, or PnL.

import type { ExchangeId } from '../data/MarketIdentity';

export interface TradeIntent {
  /** Authoritative exchange from FastPipeline config (not signal). */
  readonly exchange: ExchangeId;
  /** Symbol from validated signal. */
  readonly symbol: string;
  /** Trade direction — only long or short allowed. */
  readonly direction: 'long' | 'short';
  /** Order type — market only in this stage; NOT executed. */
  readonly orderType: 'market';
  /** Position size in USD (finite positive number). */
  readonly positionUsd: number;
  /** Signal source string for audit trail. */
  readonly source: string;
  /** Unix epoch millisecond timestamp when intent was created. */
  readonly createdAt: number;
  /** DecisionEngine reason appended to intent. */
  readonly reason: string;
  /** updatedAt from the bias report used for this decision. */
  readonly biasUpdatedAt: number;
}

/** Create a validated TradeIntent. Throws on any invalid input. */
export function createTradeIntent(params: {
  exchange: ExchangeId;
  symbol: string;
  direction: 'long' | 'short';
  positionUsd: number;
  source: string;
  reason: string;
  biasUpdatedAt: number;
}): TradeIntent {
  if (!params.symbol || typeof params.symbol !== 'string') {
    throw new Error('TradeIntent: symbol must be a non-empty string');
  }
  if (params.direction !== 'long' && params.direction !== 'short') {
    throw new Error(`TradeIntent: direction must be 'long' or 'short', got ${JSON.stringify(params.direction)}`);
  }
  if (typeof params.positionUsd !== 'number' || !Number.isFinite(params.positionUsd) || params.positionUsd <= 0) {
    throw new Error(`TradeIntent: positionUsd must be a finite positive number, got ${params.positionUsd}`);
  }
  if (typeof params.biasUpdatedAt !== 'number' || !Number.isFinite(params.biasUpdatedAt) || params.biasUpdatedAt < 0) {
    throw new Error(`TradeIntent: biasUpdatedAt must be a non-negative number, got ${params.biasUpdatedAt}`);
  }

  return {
    exchange: params.exchange,
    symbol: params.symbol,
    direction: params.direction,
    orderType: 'market',
    positionUsd: params.positionUsd,
    source: params.source,
    createdAt: Date.now(),
    reason: params.reason,
    biasUpdatedAt: params.biasUpdatedAt,
  };
}
