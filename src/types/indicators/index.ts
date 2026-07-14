// src/types/indicators/index.ts
// Discriminated union of all 14 indicator results + failure result
//
// Stage 2B-2P-B: Added IndicatorName and IndicatorFailureResult to handle
// daemon partial failure responses that produce { name, error } shapes
// instead of full success fields.

export * from './base';
export * from './hull';
export * from './chandelier';
export * from './utbot';
export * from './stc-result';
export * from './stochastic-result';
export * from './mean-reversion-result';
export * from './trend-impulse-result';
export * from './deltaflow';
export * from './elliott-wave';
export * from './fibonacci';
export * from './sr-range';
export * from './volume-profile';
export * from './momentum';
export * from './order-block';

import type { HullResult } from './hull';
import type { ChandelierResult } from './chandelier';
import type { UTBotResult } from './utbot';
import type { StcResult } from './stc-result';
import type { StochasticResult } from './stochastic-result';
import type { MeanReversionResult } from './mean-reversion-result';
import type { TrendImpulseResult } from './trend-impulse-result';
import type { DeltaFlowResult } from './deltaflow';
import type { ElliottWaveResult } from './elliott-wave';
import type { FibonacciResult } from './fibonacci';
import type { SRRangeResult } from './sr-range';
import type { VolumeProfileResult } from './volume-profile';
import type { MomentumResult } from './momentum';
import type { OrderBlockResult } from './order-block';

// ── IndicatorName — authoritative list of all known indicator names ──────

export type IndicatorName =
  | 'HullSuite'
  | 'ChandelierExit'
  | 'UTBotAlerts'
  | 'STC'
  | 'StochasticOverlay'
  | 'MeanReversion'
  | 'TrendImpulse'
  | 'DeltaFlow'
  | 'ElliottWave'
  | 'FibonacciEntryBands'
  | 'SRRange'
  | 'VolumeProfile'
  | 'CompositeMomentum'
  | 'SmartOrderBlock';

// ── IndicatorFailureResult — daemon partial failure shape ───────────────

export interface IndicatorFailureResult {
  name: IndicatorName;
  error: string;
  lag_bars?: number;
}

// ── IndicatorResult — all known success types + failure ─────────────────

export type IndicatorResult =
  | HullResult
  | ChandelierResult
  | UTBotResult
  | StcResult
  | StochasticResult
  | MeanReversionResult
  | TrendImpulseResult
  | DeltaFlowResult
  | ElliottWaveResult
  | FibonacciResult
  | SRRangeResult
  | VolumeProfileResult
  | MomentumResult
  | OrderBlockResult
  | IndicatorFailureResult;
