// Stage 3B1B: trading runtime barrel
export type { TradingRuntime, TradingRuntimeOptions, UniverseApplyResult } from './TradingRuntime';
export { createTradingRuntime } from './TradingRuntime';
export { createPlanAwareCollector } from './PlanAwareCollector';

// Stage 3B2C: Bitget V2 wiring
export type {
  BitgetTradingRuntimeOptions,
  BitgetTradingRuntimeCollectorFailure,
} from './BitgetTradingRuntime';
export {
  createBitgetTradingRuntime,
} from './BitgetTradingRuntime';

// Stage 3B3D: Binance USD-M wiring
export type {
  BinanceTradingRuntimeOptions,
  BinanceTradingRuntimeCollectorFailure,
} from './BinanceTradingRuntime';
export {
  createBinanceTradingRuntime,
} from './BinanceTradingRuntime';
