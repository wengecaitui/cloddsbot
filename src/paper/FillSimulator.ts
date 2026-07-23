// Stage 3B4C9: Deterministic Fill Simulator.
//
// Converts a TradeIntent + explicit market configuration into a PaperFill.
// Pure function — same inputs always produce identical outputs.
// No Date.now(), Math.random(), network, LLM, Broker, or Exchange calls.
// Config provides price, fee rate, slippage — simulator applies formula, nothing more.

import type { ExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { PaperFill } from '../types/paper-fill';
import { validatePaperFill } from '../types/paper-fill';
import { roundUsd, roundQuantity } from './PaperLedgerMath';

export interface FillSimulatorConfig {
  /** Mark price used for quantity and execution price calculation. */
  markPriceUsd: number;
  /** Fee rate in basis points (1 bp = 0.01%). Fee = positionUsd × feeBps / 10_000. */
  feeBps: number;
  /** Slippage in basis points. Executed price = markPrice × (1 ± slippageBps/10_000). */
  slippageBps: number;
  /** Integer millisecond timestamp the fill is considered executed at. */
  executedAtMs: number;
  /** Fill ID prefix — simulator appends counter suffix for uniqueness. */
  fillIdPrefix?: string;
}

const DEFAULT_PREFIX = 'sim';

export interface SimulateResult {
  fill: PaperFill;
  /** The executed price after slippage. */
  executedPriceUsd: number;
  /** The computed quantity from positionUsd / executedPrice. */
  quantity: number;
  /** The fee in USD. */
  feeUsd: number;
}

/**
 * Deterministic fill simulation.
 *
 * Formula:
 *   isBuy = intent.direction === 'long'
 *   slippageMultiplier = 1 + (isBuy ? +slippageBps : -slippageBps) / 10_000
 *   executedPriceUsd = roundUsd(markPrice × slippageMultiplier)
 *   quantity = roundQuantity(intent.positionUsd / executedPriceUsd)
 *   feeUsd = roundUsd(intent.positionUsd × feeBps / 10_000)
 */
export function simulateFill(
  intent: TradeIntent,
  config: FillSimulatorConfig,
  counter: number,
): SimulateResult {
  if (!Number.isFinite(config.markPriceUsd) || config.markPriceUsd <= 0) {
    throw new Error('FillSimulator: markPriceUsd must be finite positive');
  }
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0) {
    throw new Error('FillSimulator: feeBps must be finite non-negative');
  }
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0) {
    throw new Error('FillSimulator: slippageBps must be finite non-negative');
  }
  if (!Number.isInteger(config.executedAtMs) || config.executedAtMs < 0) {
    throw new Error('FillSimulator: executedAtMs must be non-negative integer');
  }
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error('FillSimulator: counter must be non-negative integer');
  }

  const isBuy = intent.direction === 'long';
  const slipMult = 1 + (isBuy ? 1 : -1) * config.slippageBps / 10_000;
  const executedPriceUsd = roundUsd(config.markPriceUsd * slipMult);
  const quantity = roundQuantity(intent.positionUsd / executedPriceUsd);
  const feeUsd = roundUsd(intent.positionUsd * config.feeBps / 10_000);
  const side = isBuy ? 'buy' as const : 'sell' as const;
  const prefix = config.fillIdPrefix ?? DEFAULT_PREFIX;

  const fill: PaperFill = {
    fillId: `${prefix}-${intent.symbol}-${counter}`,
    exchange: intent.exchange,
    symbol: intent.symbol,
    side,
    quantity,
    priceUsd: executedPriceUsd,
    feeUsd,
    executedAt: config.executedAtMs,
  };

  validatePaperFill(fill);
  return { fill, executedPriceUsd, quantity, feeUsd };
}
