// types/indicators/stochastic-result.ts
import type { BaseResult } from './base';

export interface StochasticResult extends BaseResult {
  name: 'StochasticOverlay';
  k_period: number;
  d_period: number;
  k: number;
  d: number;
  zone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  signal: 'SELL' | 'BUY' | 'WATCH' | 'HOLD';
  lag_bars: number;
}