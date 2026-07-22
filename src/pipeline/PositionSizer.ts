// Stage 3B4C7: Deterministic Position Sizer
//
// Pure function — no state, no async, no I/O, no LLM, no randomness.
// Computes requested position amount in USD from total capital and suggested
// allocation percentage.  Does NOT apply risk limits — KillSwitch does that.
//
// Formula: roundToCents(totalCapitalUsd × suggestedPositionPct)

export interface PositionSizerInput {
  totalCapitalUsd: number;
  suggestedPositionPct: number;
}

export function computePositionUsd(input: PositionSizerInput): number {
  const { totalCapitalUsd, suggestedPositionPct } = input;

  if (typeof totalCapitalUsd !== 'number' || !Number.isFinite(totalCapitalUsd)) {
    throw new Error(`PositionSizer: totalCapitalUsd must be a finite number, got ${totalCapitalUsd}`);
  }
  if (totalCapitalUsd <= 0) {
    throw new Error(`PositionSizer: totalCapitalUsd must be > 0, got ${totalCapitalUsd}`);
  }

  if (typeof suggestedPositionPct !== 'number' || !Number.isFinite(suggestedPositionPct)) {
    throw new Error(`PositionSizer: suggestedPositionPct must be a finite number, got ${suggestedPositionPct}`);
  }
  if (suggestedPositionPct <= 0 || suggestedPositionPct > 1) {
    throw new Error(`PositionSizer: suggestedPositionPct must be in (0, 1], got ${suggestedPositionPct}`);
  }

  const raw = totalCapitalUsd * suggestedPositionPct;
  // Round to cents: two-decimal USD precision, banker's rounding.
  const result = Math.round(raw * 100) / 100;

  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`PositionSizer: computed positionUsd=${result} is not a finite positive number`);
  }

  return result;
}
