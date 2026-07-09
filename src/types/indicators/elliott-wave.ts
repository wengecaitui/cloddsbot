// src/types/indicators/elliott-wave.ts
// ElliottWave — P2: Strict_Lag_Offset pivot-based wave pattern

import type { BaseResult } from './base';

export interface ElliottWaveResult extends BaseResult {
  name: 'ElliottWave';
  pivot_count: number;
  recent_pattern: string;
  wave_pattern: string;
  trend: 'BULL' | 'BEAR' | 'NEUTRAL';
  position: 'LONG' | 'SHORT' | 'HOLD';
  pivot_right: number;
  lag_bars: number;
  note?: string;
}