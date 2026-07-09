// src/types/indicators/order-block.ts
// SmartOrderBlock — P3: Order block tracking with decay

import type { BaseResult } from './base';

export interface Phase3BridgeSignal {
  confluence_triggered: boolean;
  suggested_track: 'FAST_TRACK' | 'SLOW_TRACK' | 'IDLE';
}

export interface OrderBlockResult extends BaseResult {
  name: 'SmartOrderBlock';
  has_active_ob: boolean;
  nearest_bullish_ob: [number, number] | null;
  nearest_bearish_ob: [number, number] | null;
  ob_strength_weight: number;
  total_obs: number;
  active_obs: number;
  phase3_bridge_signal: Phase3BridgeSignal;
  lag_bars: number;
}