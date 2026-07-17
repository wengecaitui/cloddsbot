// Stage 3B4B: Unified single-exchange Trading Runtime selector
//
// Provides a discriminated-union factory that routes to the correct Exchange
// Market Data Provider and creates a TradingRuntime. Keeps all existing
// per-exchange API functions intact — this is purely additive.
//
// Architecture:
//   ExchangeTradingRuntimeOptions → discriminated by .exchange
//     "bitget"  → createBitgetMarketDataProvider → createCollector → createTradingRuntime
//     "binance" → createBinanceMarketDataProvider → createCollector → createTradingRuntime
//
// No socket is opened at construction time. Only one exchange per runtime.
// Provider and runtime options are defensively handled at the caller's
// discretion — the selector does NOT deep-copy, it passes them through as-is.

import type { TradingRuntime, TradingRuntimeOptions } from './TradingRuntime';
import { createTradingRuntime } from './TradingRuntime';
import {
  createBitgetMarketDataProvider,
  type BitgetMarketDataProviderOptions,
} from './BitgetMarketDataProvider';
import {
  createBinanceMarketDataProvider,
  type BinanceMarketDataProviderOptions,
} from './BinanceMarketDataProvider';

export type ExchangeTradingRuntimeOptions = {
  exchange: 'bitget';
  runtime: Omit<TradingRuntimeOptions, 'collectorFactory'>;
  provider?: BitgetMarketDataProviderOptions;
} | {
  exchange: 'binance';
  runtime: Omit<TradingRuntimeOptions, 'collectorFactory'>;
  provider?: BinanceMarketDataProviderOptions;
};

/**
 * Create a TradingRuntime for a single exchange.
 *
 * The `exchange` discriminant selects the Market Data Provider:
 *   - 'bitget'  → BitgetMarketDataProvider → BitgetV2PublicCollector
 *   - 'binance' → BinanceMarketDataProvider → BinanceV2PublicCollector
 *
 * The Provider and Runtime options are passed through to the respective
 * factory functions. Provider construction does NOT open any socket.
 *
 * All existing per-exchange factory functions (`createBitgetTradingRuntime`,
 * `createBinanceTradingRuntime`) remain available for direct use.
 */
export function createExchangeTradingRuntime(
  options: ExchangeTradingRuntimeOptions,
): TradingRuntime {
  switch (options.exchange) {
    case 'bitget': {
      const provider = createBitgetMarketDataProvider(options.provider ?? {});
      return createTradingRuntime({
        ...options.runtime,
        collectorFactory: (plan) => provider.createCollector(plan),
      });
    }
    case 'binance': {
      const provider = createBinanceMarketDataProvider(options.provider ?? {});
      return createTradingRuntime({
        ...options.runtime,
        collectorFactory: (plan) => provider.createCollector(plan),
      });
    }
    default: {
      const _exhaustive: never = options;
      throw new Error(`ExchangeTradingRuntime: unsupported exchange "${(_exhaustive as any)?.exchange}"`);
    }
  }
}
