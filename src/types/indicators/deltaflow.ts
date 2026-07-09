// src/types/indicators/deltaflow.ts
// DeltaFlow — P2: Cumulative delta / volume momentum

import type { BaseResult } from './base';

export interface DeltaFlowResult extends BaseResult {
  name: 'DeltaFlow';
  period: number;
  delta_smooth: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
  signal: 'BUY' | 'SELL' | 'HOLD';
  pivot_count: number;
  strict_lag_offset: number;
  lag_bars: number;
}