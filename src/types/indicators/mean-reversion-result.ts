// types/indicators/mean-reversion-result.ts
import type { BaseResult } from './base';

export interface MeanReversionResult extends BaseResult {
  name: 'MeanReversion';
  period: number;
  std_mult: number;
  z_score: number;
  probability: number;
  zone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  close: number;
  signal: 'BUY' | 'SELL' | 'HOLD';
  lag_bars: number;
}