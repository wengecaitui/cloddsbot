// types/indicators/hull.ts
// HullSuite — P0: Hull Moving Average

import type { BaseResult } from './base';

export interface HullResult extends BaseResult {
  name: 'HullSuite';
  period: number;
  hma: number;
  close: number;
  trend: 'BULL' | 'BEAR' | 'NEUTRAL';
  position: 'LONG' | 'SHORT' | 'HOLD';
  lag_bars: number;
}