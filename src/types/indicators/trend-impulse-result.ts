// src/types/indicators/trend-impulse-result.ts
// TrendImpulse — P1: ATR-based trend channel

import type { BaseResult } from './base';

export interface TrendImpulseResult extends BaseResult {
  name: 'TrendImpulse';
  period: number;
  mult: number;
  close: number;
  upper: number;
  mid: number;
  lower: number;
  zone: 'OVERBOUGHT' | 'OVERSOLD' | 'BULL_ZONE' | 'BEAR_ZONE';
  signal: 'BULL' | 'BEAR';
  lag_bars: number;
}