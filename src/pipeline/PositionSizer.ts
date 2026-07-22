// Stage 3B4C7-R1: Deterministic Position Sizer
//
// Pure function — no state, no async, no I/O, no LLM, no randomness.
// Computes requested position amount in USD from total capital and suggested
// allocation percentage.  Does NOT apply risk limits — KillSwitch does that.
//
// Formula: round to nearest cent using Math.round(totalCapitalUsd × suggestedPositionPct × 100) / 100

export interface PositionSizerInput {
  totalCapitalUsd: number;
  suggestedPositionPct: number;
  /** Stage 3B4C7-R1: symbol for audit trail in error messages. */
  symbol: string;
  /** Stage 3B4C7-R1: validated direction before sizing. */
  direction: 'long' | 'short';
}

export function computePositionUsd(input: PositionSizerInput): number {
  const { totalCapitalUsd, suggestedPositionPct, symbol, direction } = input;

  if (typeof symbol !== 'string' || !symbol) {
    throw new Error(`PositionSizer: symbol must be a non-empty string, got ${JSON.stringify(symbol)}`);
  }
  if (direction !== 'long' && direction !== 'short') {
    throw new Error(`PositionSizer: direction must be 'long' or 'short', got ${JSON.stringify(direction)}`);
  }

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

  // round to nearest cent using Math.round
  const result = Math.round(totalCapitalUsd * suggestedPositionPct * 100) / 100;

  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`PositionSizer: computed positionUsd=${result} is not a finite positive number`);
  }

  return result;
}
