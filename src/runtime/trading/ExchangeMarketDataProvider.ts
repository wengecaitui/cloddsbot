// Stage 3B4A: Exchange Market Data Provider abstraction
//
// Provides a unified interface for building Exchange-specific Collector factories.
// Each ExchangeMarketDataProvider snapshots all non-plan configuration at creation
// time so caller mutations cannot retroactively affect Collectors.
//
// Two built-in implementations:
//   - createBitgetMarketDataProvider(options)
//   - createBinanceMarketDataProvider(options)

import type { MarketDataCollectorPort } from '../market/MarketDataRuntime';
import type { SubscriptionPlan } from '../market/UniverseManager';

export type ExchangeId = 'bitget' | 'binance';

/**
 * Exchange Market Data Provider.
 * Created once per exchange, then called once per collector lifecycle
 * (each start / applyUniversePlan creates one collector).
 *
 * All non-plan configuration is snapshotted at provider creation time.
 */
export interface ExchangeMarketDataProvider {
  readonly exchange: ExchangeId;
  createCollector(plan: SubscriptionPlan): MarketDataCollectorPort;
}
