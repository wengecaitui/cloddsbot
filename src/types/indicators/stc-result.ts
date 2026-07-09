// types/indicators/stc-result.ts
import type { BaseResult } from './base';

export interface StcResult extends BaseResult {
  name: 'STC';
  fast: number;
  slow: number;
  cycle: number;
  stc: number;
  signal: 'BUY' | 'SELL' | 'HOLD';
  trend: 'BULL' | 'BEAR';
  lag_bars: number;
}