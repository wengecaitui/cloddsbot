// src/types/indicators/fibonacci.ts
// FibonacciEntryBands — P2: Swing pivot-based Fibonacci retracement/extension

import type { BaseResult } from './base';

export interface FibonacciResult extends BaseResult {
  name: 'FibonacciEntryBands';
  direction: 'UP' | 'DOWN';
  swing_high: number;
  swing_low: number;
  swing_range: number;
  retracement: number;
  extension: number;
  entry_band_lower: number;
  entry_band_upper: number;
  in_entry_band: boolean;
  position: 'BUY' | 'SELL' | 'HOLD';
  lag_bars: number;
  note?: string;
}