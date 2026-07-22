// Stage 3B4C8: PaperFill — immutable simulated fill contract.
// Does NOT represent a real exchange order ID or execution.

import type { ExchangeId } from '../data/MarketIdentity';

export interface PaperFill {
  readonly fillId: string;
  readonly exchange: ExchangeId;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly priceUsd: number;
  readonly feeUsd: number;
  readonly executedAt: number;
}

export function validatePaperFill(fill: PaperFill): PaperFill {
  if (!fill.fillId || typeof fill.fillId !== 'string' || fill.fillId.length > 128) {
    throw new Error(`PaperFill: fillId must be a non-empty string (1-128 chars), got ${JSON.stringify(fill.fillId)}`);
  }
  if (!fill.symbol || typeof fill.symbol !== 'string' || !fill.symbol.trim()) {
    throw new Error(`PaperFill: symbol must be a non-empty string, got ${JSON.stringify(fill.symbol)}`);
  }
  if (fill.side !== 'buy' && fill.side !== 'sell') {
    throw new Error(`PaperFill: side must be 'buy' or 'sell', got ${JSON.stringify(fill.side)}`);
  }
  if (typeof fill.quantity !== 'number' || !Number.isFinite(fill.quantity) || fill.quantity <= 0) {
    throw new Error(`PaperFill: quantity must be a finite positive number, got ${fill.quantity}`);
  }
  if (typeof fill.priceUsd !== 'number' || !Number.isFinite(fill.priceUsd) || fill.priceUsd <= 0) {
    throw new Error(`PaperFill: priceUsd must be a finite positive number, got ${fill.priceUsd}`);
  }
  if (typeof fill.feeUsd !== 'number' || !Number.isFinite(fill.feeUsd) || fill.feeUsd < 0) {
    throw new Error(`PaperFill: feeUsd must be a finite non-negative number, got ${fill.feeUsd}`);
  }
  if (typeof fill.executedAt !== 'number' || !Number.isFinite(fill.executedAt) || !Number.isInteger(fill.executedAt) || fill.executedAt < 0) {
    throw new Error(`PaperFill: executedAt must be a non-negative integer, got ${fill.executedAt}`);
  }
  return fill;
}
