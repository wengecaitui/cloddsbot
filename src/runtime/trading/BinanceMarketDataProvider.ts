// Stage 3B4A: Binance Market Data Provider
//
// Wraps all Binance V2 Public Collector configuration snapshot + creation.
// Used by createBinanceTradingRuntime to delegate collector construction.
//
// Migration contract:
//   - Snapshot logic and semantics identical to the prior
//     snapshotBinanceConfig() in BinanceTradingRuntime.ts.
//   - Caller-supplied `binance.plan` (when injected via `any`) is overridden by
//     the runtime-supplied plan, which is passed as the LAST field.
//   - Per-instance error handler binds the live Collector's planVersion.
//   - Provider creation does NOT open any socket.

import type { MarketDataCollectorPort } from '../market/MarketDataRuntime';
import type { SubscriptionPlan } from '../market/UniverseManager';
import type { Clock } from '../../data/MarketSnapshot';
import type { ExchangeMarketDataProvider, ExchangeId } from './ExchangeMarketDataProvider';

import {
  BinanceV2PublicCollector,
  type BinanceV2PublicCollectorOptions,
  type BinanceCollectorFailure,
  type BinanceWebSocketFactory,
  type BinanceTimerScheduler,
} from '../../data/binance/BinanceV2PublicCollector';
import type { BinanceSubscriptionPlannerOptions } from '../../data/binance/BinanceSubscriptionPlanner';

export interface BinanceMarketDataProviderOptions {
  /**
   * Binance V2 Collector tuning. All fields optional except `plan` which is
   * supplied by the runtime on each restart. NEVER read `binance.plan` even if
   * the caller injects it via `any` — the runtime plan always overrides.
   */
  readonly binance?: Omit<BinanceV2PublicCollectorOptions, 'plan'>;

  /**
   * Optional Collector failure callback. Each Collector instance binds its
   * own handler; restart swaps the binding. The callback receives the
   * Collector's actual planVersion at the time of the failure.
   */
  readonly onBinanceCollectorError?: (
    failure: BinanceCollectorFailure & { readonly planVersion: number }
  ) => void;
}

// ── Internal snapshot types ────────────────────────────────────────────────

interface SnapshotPlannerOptions {
  readonly maxStreamsPerRequest?: number;
  readonly startId?: number;
}

interface SnapshotBinanceConfig {
  readonly marketEndpoint?: string;
  readonly publicEndpoint?: string;
  readonly webSocketFactory?: BinanceWebSocketFactory;
  readonly scheduler?: BinanceTimerScheduler;
  readonly clock?: Clock;
  readonly ackTimeoutMs: number;
  readonly reconnectDelayMs: number;
  readonly inactivityPeriodMs: number;
  readonly lifetimeMs: number;
  readonly plannerOptions: SnapshotPlannerOptions;
}

const DEFAULTS = {
  ackTimeoutMs: 10000,
  reconnectDelayMs: 3000,
  inactivityPeriodMs: 7_200_000,
  lifetimeMs: 82_800_000,
} as const;

function snapshotBinanceConfig(
  binance: BinanceMarketDataProviderOptions['binance'],
): SnapshotBinanceConfig | null {
  if (!binance) return null;

  const marketEndpoint = binance.marketEndpoint;
  const publicEndpoint = binance.publicEndpoint;

  const webSocketFactory = binance.webSocketFactory;
  if (typeof webSocketFactory !== 'function' && webSocketFactory !== undefined) {
    throw new TypeError('BinanceMarketDataProvider: binance.webSocketFactory must be a function when provided');
  }

  // Wrapper scheduler: bind methods at snapshot time to isolate from later
  // replacements on the caller's object.
  const userScheduler = binance.scheduler;
  let scheduler: BinanceTimerScheduler | undefined;
  if (userScheduler) {
    scheduler = {
      setTimeout: userScheduler.setTimeout.bind(userScheduler),
      clearTimeout: userScheduler.clearTimeout.bind(userScheduler),
    };
  }

  // Wrapper clock: bind now() at snapshot time.
  const userClock = binance.clock;
  let clock: Clock | undefined;
  if (userClock) {
    clock = { now: userClock.now.bind(userClock) };
  }

  const ackTimeoutMs = binance.ackTimeoutMs ?? DEFAULTS.ackTimeoutMs;
  const reconnectDelayMs = binance.reconnectDelayMs ?? DEFAULTS.reconnectDelayMs;
  const inactivityPeriodMs = binance.inactivityPeriodMs ?? DEFAULTS.inactivityPeriodMs;
  const lifetimeMs = binance.lifetimeMs ?? DEFAULTS.lifetimeMs;

  // Deep-copy plannerOptions (only the two known fields).
  const userPlanner = binance.plannerOptions;
  const plannerOptions: SnapshotPlannerOptions = {
    maxStreamsPerRequest: userPlanner?.maxStreamsPerRequest,
    startId: userPlanner?.startId,
  };

  return {
    marketEndpoint,
    publicEndpoint,
    webSocketFactory,
    scheduler,
    clock,
    ackTimeoutMs,
    reconnectDelayMs,
    inactivityPeriodMs,
    lifetimeMs,
    plannerOptions,
  };
}

/**
 * Create a Binance Market Data Provider.
 *
 * The Provider:
 *   - Snapshots all Binance collector configuration ONCE at creation time.
 *   - Returns a NEW BinanceV2PublicCollector per createCollector(plan) call
 *     (no caching, no singleton).
 *   - Passes the runtime-supplied SubscriptionPlan as the LAST field so
 *     caller-supplied `binance.plan` (when injected via `any`) is overridden.
 *   - Binds onBinanceCollectorError with the live Collector's planVersion.
 *
 * Provider creation does NOT open any socket.
 */
export function createBinanceMarketDataProvider(
  options: BinanceMarketDataProviderOptions
): ExchangeMarketDataProvider {
  const { binance, onBinanceCollectorError } = options;
  const snapshot = snapshotBinanceConfig(binance);

  return {
    exchange: 'binance' as ExchangeId,
    createCollector(plan: SubscriptionPlan): MarketDataCollectorPort {
      let collector: BinanceV2PublicCollector;
      if (snapshot) {
        collector = new BinanceV2PublicCollector({
          plan,
          ...snapshot,
        });
      } else {
        collector = new BinanceV2PublicCollector({ plan });
      }

      collector.onError((failure: BinanceCollectorFailure) => {
        onBinanceCollectorError?.({
          ...failure,
          planVersion: collector.planVersion,
        });
      });

      return collector;
    },
  };
}
