// src/types/indicators/volume-profile.ts
// VolumeProfile — Price-volume distribution histogram

import type { BaseResult } from './base';

export interface VolumeProfileBin {
  price_low: number;
  price_high: number;
  volume: number;
  delta: number;
  is_poc: boolean;
}

export interface VolumeProfileResult extends BaseResult {
  name: 'VolumeProfile';
  profile: VolumeProfileBin[];
  poc: number;
  poc_volume: number;
  vah: number;
  val: number;
  vwap: number;
  total_volume: number;
  ticks_used?: number;
  method: 'tick_exact' | 'ohlcv_approximate';
  bins: number;
  value_area_pct: number;
  lag_bars: number;
  note?: string;
}