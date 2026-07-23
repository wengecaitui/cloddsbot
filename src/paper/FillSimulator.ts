// Stage 3B4C9-R1: Hardened deterministic fill simulator.
//
// Full input validation, canonical hashed fillId, post-round verification,
// fee on executed notional, integration-safe output.

import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import { roundUsd, roundQuantity } from './PaperLedgerMath';

export interface FillSimulatorConfig {
  markPriceUsd: number;
  feeBps: number;
  slippageBps: number;
  executedAtMs: number;
  fillIdPrefix?: string;
}

const DEFAULT_PREFIX = 'sim';
const MAX_FILLID_LEN = 128;
const FILLID_MIN_LEN = 8;

export interface SimulateResult {
  fill: PaperFill;
  executedPriceUsd: number;
  quantity: number;
  executedNotionalUsd: number;
  feeUsd: number;
}

/** R1: deterministic hash for fillId. Uses canonical components. */
function hashFillId(intent: TradeIntent, config: FillSimulatorConfig, counter: number): string {
  const key = `${intent.symbol}|${intent.direction}|${config.executedAtMs}|${counter}`;
  // Simple deterministic hash — sum of char codes mod 36^6, produces ~6-char hex-like suffix
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  const suffix = Math.abs(hash).toString(36).slice(0, 6).padStart(6, '0');
  const prefix = config.fillIdPrefix ?? DEFAULT_PREFIX;
  const id = `${prefix}-${intent.symbol}-${counter}-${suffix}`;
  if (id.length > MAX_FILLID_LEN) {
    throw new Error(`FillSimulator: fillId too long (${id.length} > ${MAX_FILLID_LEN}): ${id}`);
  }
  if (id.length < FILLID_MIN_LEN) {
    throw new Error(`FillSimulator: fillId too short (${id.length} < ${FILLID_MIN_LEN}): ${id}`);
  }
  return id;
}

function validateIntent(intent: TradeIntent): void {
  if (!isExchangeId(intent.exchange)) throw new Error(`FillSimulator: invalid exchange ${JSON.stringify(intent.exchange)}`);
  if (intent.direction !== 'long' && intent.direction !== 'short') throw new Error(`FillSimulator: direction must be long/short, got ${intent.direction}`);
  if (intent.orderType !== 'market') throw new Error(`FillSimulator: orderType must be market, got ${intent.orderType}`);
  if (!intent.symbol || typeof intent.symbol !== 'string') throw new Error('FillSimulator: symbol must be non-empty');
  if (typeof intent.positionUsd !== 'number' || !Number.isFinite(intent.positionUsd) || intent.positionUsd <= 0)
    throw new Error(`FillSimulator: positionUsd must be finite positive, got ${intent.positionUsd}`);
  if (typeof intent.createdAt !== 'number' || !Number.isInteger(intent.createdAt) || intent.createdAt < 0)
    throw new Error(`FillSimulator: createdAt must be non-negative integer, got ${intent.createdAt}`);
  if (typeof intent.biasUpdatedAt !== 'number' || !Number.isInteger(intent.biasUpdatedAt) || intent.biasUpdatedAt < 0)
    throw new Error(`FillSimulator: biasUpdatedAt must be non-negative integer, got ${intent.biasUpdatedAt}`);
}

function validateConfig(config: FillSimulatorConfig, direction: string): void {
  if (!Number.isFinite(config.markPriceUsd) || config.markPriceUsd <= 0)
    throw new Error('FillSimulator: markPriceUsd must be finite positive');
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0)
    throw new Error('FillSimulator: feeBps must be finite non-negative');
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0)
    throw new Error('FillSimulator: slippageBps must be finite non-negative');
  if (!Number.isInteger(config.executedAtMs) || config.executedAtMs < 0)
    throw new Error('FillSimulator: executedAtMs must be non-negative integer');
  if (config.executedAtMs < 0)
    throw new Error('FillSimulator: executedAtMs must be >= 0');
  if (direction === 'short' && config.slippageBps >= 10_000)
    throw new Error(`FillSimulator: short slippageBps=${config.slippageBps} must be < 10000 (would zero or negate price)`);
}

export function simulateFill(intent: TradeIntent, config: FillSimulatorConfig, counter: number): SimulateResult {
  if (!Number.isInteger(counter) || counter < 0) throw new Error(`FillSimulator: counter must be non-negative integer, got ${counter}`);
  validateIntent(intent);
  validateConfig(config, intent.direction);
  if (config.executedAtMs < intent.createdAt) throw new Error('FillSimulator: executedAtMs < intent.createdAt');

  const isBuy = intent.direction === 'long';
  const slipMult = 1 + (isBuy ? 1 : -1) * config.slippageBps / 10_000;
  const executedPriceUsd = roundUsd(config.markPriceUsd * slipMult);
  const quantity = roundQuantity(intent.positionUsd / executedPriceUsd);
  const executedNotionalUsd = roundUsd(quantity * executedPriceUsd);
  const feeUsd = roundUsd(executedNotionalUsd * config.feeBps / 10_000);

  // Post-round validation
  if (!Number.isFinite(executedPriceUsd) || executedPriceUsd <= 0)
    throw new Error(`FillSimulator: executedPriceUsd=${executedPriceUsd} after rounding`);
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new Error(`FillSimulator: quantity=${quantity} after rounding`);
  if (!Number.isFinite(executedNotionalUsd) || executedNotionalUsd <= 0)
    throw new Error(`FillSimulator: executedNotionalUsd=${executedNotionalUsd} after rounding`);
  if (!Number.isFinite(feeUsd) || feeUsd < 0)
    throw new Error(`FillSimulator: feeUsd=${feeUsd} after rounding`);

  const fillId = hashFillId(intent, config, counter);
  const fill: PaperFill = {
    fillId, exchange: intent.exchange, symbol: intent.symbol,
    side: isBuy ? 'buy' : 'sell', quantity, priceUsd: executedPriceUsd,
    feeUsd, executedAt: config.executedAtMs,
  };
  validatePaperFill(fill);
  return { fill, executedPriceUsd, quantity, executedNotionalUsd, feeUsd };
}
