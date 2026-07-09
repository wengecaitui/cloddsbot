// types/indicators/chandelier.ts
import type { BaseResult } from './base';

export interface ChandelierResult extends BaseResult {
  name: 'ChandelierExit';
  length: number;
  mult: number;
  long_stop: number;
  short_stop: number;
  direction: 'LONG' | 'SHORT';
  signal: 'LONG' | 'SHORT' | 'HOLD';
  atr: number;
  lag_bars: number;
}