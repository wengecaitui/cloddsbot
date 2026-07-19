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

// Stage 3B4A: Exchange Market Data Providers
export type {
  ExchangeMarketDataProvider,
  ExchangeId,
} from './ExchangeMarketDataProvider';
export {
  createBitgetMarketDataProvider,
  type BitgetMarketDataProviderOptions,
} from './BitgetMarketDataProvider';
export {
  createBinanceMarketDataProvider,
  type BinanceMarketDataProviderOptions,
} from './BinanceMarketDataProvider';

// Stage 3B4B: Unified single-exchange Runtime selector
export type {
  ExchangeTradingRuntimeOptions,
} from './ExchangeTradingRuntime';
export {
  createExchangeTradingRuntime,
} from './ExchangeTradingRuntime';

// Stage 3B4C3: Multi-exchange Runtime coordinator
export type {
  MultiExchangeRuntime,
  MultiExchangeRuntimeOptions,
  MultiExchangeRuntimeState,
  PerExchangeRuntimeState,
  PerExchangeStatus,
  MultiExchangeStartResult,
} from './MultiExchangeRuntime';
export {
  createMultiExchangeRuntime,
  MultiExchangeStartError,
  MultiExchangeLifecycleCancelledError,
  MultiExchangeIsolationError,
} from './MultiExchangeRuntime';
