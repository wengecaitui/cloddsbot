// src/types/indicators/sr-range.ts
// SRRange — P2: Support and Resistance with ATR bands

import type { BaseResult } from './base';

export interface SRLevel {
  price: number;
  bar: number;
  strength: 'STRONG' | 'FRESH';
}

export interface SRRangeResult extends BaseResult {
  name: 'SRRange';
  resistance: number;
  support: number;
  midpoint: number;
  atr: number;
  atr_multiplier: number;
  signal: 'BULLISH' | 'BEARISH';
  position: 'LONG' | 'SHORT' | 'HOLD';
  lag_bars: number;
  strict_lag_offset: number;
  sr_levels?: {
    resistances: SRLevel[];
    supports: SRLevel[];
  };
}