// src/types/indicators/momentum.ts
// CompositeMomentum — P3: 5-state regime matrix

import type { BaseResult } from './base';

export interface DimensionScore {
  score: number;
  trend?: string;
  signal?: string;
  strength?: string;
}

export interface MomentumResult extends BaseResult {
  name: 'CompositeMomentum';
  composite_score: number;
  regime_state: 'STRONG_BULLISH' | 'WEAK_BULLISH' | 'NEUTRAL' | 'WEAK_BEARISH' | 'STRONG_BEARISH';
  in_cooldown: boolean;
  dimension_scores: {
    hull_big_trend: DimensionScore;
    stc_momentum: DimensionScore;
    volume_micro: DimensionScore;
  };
  lag_bars: number;
}