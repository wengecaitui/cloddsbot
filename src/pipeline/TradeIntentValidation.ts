// Stage 3B4C7-R2: Decouple candidate validation from FastPipeline.
// Pure function — no state, no I/O, no async, no LLM.
// Makes direction_validation and bias_validation reachable in tests.

export type TradeCandidateValidation =
  | { ok: true; direction: 'long' | 'short' }
  | { ok: false; stage: 'direction_validation' | 'bias_validation'; reason: string };

export interface ValidateTradeCandidateParams {
  engineDecision: 'trade' | 'skip' | 'defense';
  engineDirection: 'long' | 'short' | 'hold' | string;
  biasDirection?: 'long' | 'short' | 'hold';
  symbol: string;
}

export function validateTradeCandidate(
  params: ValidateTradeCandidateParams,
): TradeCandidateValidation {
  const { engineDirection, biasDirection, symbol } = params;

  // 1. Direction validation — must be 'long' or 'short'
  if (engineDirection !== 'long' && engineDirection !== 'short') {
    return {
      ok: false,
      stage: 'direction_validation',
      reason: `[DIR] ${symbol}: DecisionEngine direction not long/short — got ${JSON.stringify(engineDirection)}`,
    };
  }

  // 2. Bias validation
  if (!biasDirection) {
    return {
      ok: false,
      stage: 'bias_validation',
      reason: `[BIAS] ${symbol}: no bias asset`,
    };
  }

  if (biasDirection !== engineDirection) {
    return {
      ok: false,
      stage: 'bias_validation',
      reason: `[BIAS] ${symbol}: bias.direction (${biasDirection}) !== DecisionEngine direction (${engineDirection})`,
    };
  }

  return { ok: true, direction: engineDirection };
}
