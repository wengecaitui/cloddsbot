// src/pipeline/DecisionEngine.ts
// Step 2A.5: Deterministic trading decision engine
// Pure function — no state, no async, no LLM, no hidden dependencies.
// Only accepts typed indicator results and returns trade/skip/defense.

import type { IndicatorResult, MomentumResult, OrderBlockResult } from '../types/indicators';

export type Decision = 'trade' | 'skip' | 'defense';

export interface EngineInput {
  symbol: string;
  indicators: IndicatorResult[];
  bias: { direction: 'long' | 'short' | 'hold'; confidence: number } | null;
}

export interface EngineOutput {
  decision: Decision;
  direction: 'long' | 'short' | 'hold';
  reason: string;
}

/**
 * Extract CompositeMomentum result from indicator list.
 * Returns null if not present or errored.
 */
function getMomentum(indicators: IndicatorResult[]): MomentumResult | null {
  for (const r of indicators) {
    if (r.name === 'CompositeMomentum' && !r.error) return r as MomentumResult;
  }
  return null;
}

/**
 * Extract SmartOrderBlock result from indicator list.
 */
function getOrderBlock(indicators: IndicatorResult[]): OrderBlockResult | null {
  for (const r of indicators) {
    if (r.name === 'SmartOrderBlock' && !r.error) return r as OrderBlockResult;
  }
  return null;
}

/**
 * Evaluate indicators and return a single decision.
 *
 * Rules (intentionally simple — replaceable in later sprints):
 *
 * 1. No bias → skip
 * 2. Low confidence (< 60) → skip
 * 3. Bias is 'hold' → skip
 * 4. CompositeMomentum STRONG_BULLISH + OB confluence → trade long
 * 5. CompositeMomentum STRONG_BEARISH + OB confluence → trade short
 * 6. CompositeMomentum score >= 80 (no OB needed) → trade long
 * 7. CompositeMomentum score <= 20 (no OB needed) → trade short
 * 8. Neutral/mixed → skip
 * 9. Strong regime but no OB → defense (watching)
 * 10. Fallback: skip
 *
 * Deterministic: identical inputs always produce identical output.
 */
export function evaluate(input: EngineInput): EngineOutput {
  const { symbol, indicators, bias } = input;

  // Rule 1–3: Bias gates
  if (!bias) {
    return { decision: 'skip', direction: 'hold', reason: `[DE] ${symbol}: no bias report` };
  }
  if (bias.confidence < 60) {
    return { decision: 'skip', direction: 'hold', reason: `[DE] ${symbol}: bias confidence ${bias.confidence} < 60` };
  }
  if (bias.direction === 'hold') {
    return { decision: 'skip', direction: 'hold', reason: `[DE] ${symbol}: bias is hold` };
  }

  const momentum = getMomentum(indicators);
  if (!momentum) {
    return { decision: 'skip', direction: 'hold', reason: `[DE] ${symbol}: no CompositeMomentum result` };
  }

  const { regime_state, composite_score, in_cooldown } = momentum;

  // Rule: Cooldown → skip
  if (in_cooldown) {
    return { decision: 'skip', direction: 'hold', reason: `[DE] ${symbol}: cooldown active (${regime_state})` };
  }

  // Rule: NEUTRAL → skip
  if (regime_state === 'NEUTRAL') {
    return { decision: 'skip', direction: 'hold', reason: `[DE] ${symbol}: CompositeMomentum neutral (score=${composite_score})` };
  }

  const ob = getOrderBlock(indicators);
  const obConfluence = ob && ob.has_active_ob && ob.ob_strength_weight > 0.3;

  // Rule 4: Strong bullish + bias aligns
  if (regime_state === 'STRONG_BULLISH' && bias.direction === 'long') {
    if (obConfluence) {
      return {
        decision: 'trade',
        direction: 'long',
        reason: `[DE] ${symbol}: TRADE LONG — STRONG_BULLISH (${composite_score}) + OB confluence (${ob!.ob_strength_weight})`,
      };
    }
    if (composite_score >= 80) {
      return {
        decision: 'trade',
        direction: 'long',
        reason: `[DE] ${symbol}: TRADE LONG — STRONG_BULLISH score=${composite_score} (no OB)`,
      };
    }
    return {
      decision: 'defense',
      direction: 'hold',
      reason: `[DE] ${symbol}: STRONG_BULLISH but no OB confluence — watching`,
    };
  }

  // Rule 5: Strong bearish + bias aligns
  if (regime_state === 'STRONG_BEARISH' && bias.direction === 'short') {
    if (obConfluence) {
      return {
        decision: 'trade',
        direction: 'short',
        reason: `[DE] ${symbol}: TRADE SHORT — STRONG_BEARISH (${composite_score}) + OB confluence (${ob!.ob_strength_weight})`,
      };
    }
    if (composite_score <= 20) {
      return {
        decision: 'trade',
        direction: 'short',
        reason: `[DE] ${symbol}: TRADE SHORT — STRONG_BEARISH score=${composite_score} (no OB)`,
      };
    }
    return {
      decision: 'defense',
      direction: 'hold',
      reason: `[DE] ${symbol}: STRONG_BEARISH but no OB confluence — watching`,
    };
  }

  // Rules 6-9: Weak directional or regime mismatch → skip
  return {
    decision: 'skip',
    direction: 'hold',
    reason: `[DE] ${symbol}: regime=${regime_state} score=${composite_score} bias=${bias.direction} — no alignment`,
  };
}
