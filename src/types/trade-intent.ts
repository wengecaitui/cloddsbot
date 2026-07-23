// Stage 3B4C13: Risk-Admitted Trade Intent with deterministic intentId.
import * as crypto from 'crypto';
import type { ExchangeId } from '../data/MarketIdentity';

export interface TradeIntent {
  /** Deterministic SHA-256 identity — immutable once created. */
  readonly intentId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly direction: 'long' | 'short';
  readonly orderType: 'market';
  readonly positionUsd: number;
  readonly source: string;
  readonly createdAt: number;
  readonly reason: string;
  readonly biasUpdatedAt: number;
}

export function createTradeIntent(params: {
  exchange: ExchangeId;
  symbol: string;
  direction: 'long' | 'short';
  positionUsd: number;
  source: string;
  reason: string;
  biasUpdatedAt: number;
  createdAt?: number;
  intentId?: string;
}): TradeIntent {
  if (!params.symbol || typeof params.symbol !== 'string')
    throw new Error('TradeIntent: symbol must be a non-empty string');
  if (params.direction !== 'long' && params.direction !== 'short')
    throw new Error(`TradeIntent: direction must be long/short, got ${params.direction}`);
  if (typeof params.positionUsd !== 'number' || !Number.isFinite(params.positionUsd) || params.positionUsd <= 0)
    throw new Error(`TradeIntent: positionUsd must be finite positive, got ${params.positionUsd}`);
  if (typeof params.biasUpdatedAt !== 'number' || !Number.isFinite(params.biasUpdatedAt) || params.biasUpdatedAt < 0)
    throw new Error(`TradeIntent: biasUpdatedAt must be non-negative, got ${params.biasUpdatedAt}`);

  const createdAt = params.createdAt ?? Date.now();
  const canonical = `${params.exchange}|${params.symbol}|${params.direction}|${params.positionUsd}|${params.reason}|${createdAt}`;
  const intentId = params.intentId ?? `ti-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;

  if (typeof intentId !== 'string' || intentId.length < 10 || intentId.length > 128)
    throw new Error(`TradeIntent: intentId must be 10-128 chars, got ${JSON.stringify(intentId)}`);

  return { intentId, exchange: params.exchange, symbol: params.symbol, direction: params.direction,
    orderType: 'market', positionUsd: params.positionUsd, source: params.source, createdAt,
    reason: params.reason, biasUpdatedAt: params.biasUpdatedAt };
}
