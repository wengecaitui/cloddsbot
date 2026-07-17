// Stage 3B3D: Binance Trading Runtime composition root
//
// Composes createTradingRuntime with a per-plan BinanceV2PublicCollector factory.
// Layer responsibilities (must NOT cross):
//   UniverseManager         → SubscriptionPlan (canonical symbols)
//   TradingRuntime          → plan defensive copy, PlanAwareCollector, lifecycle
//   BinanceV2PublicCollector → dual-route WS, ack lifecycle, reconnect,
//                              ticker merge, kline close
//   PlanAwareCollector      → exchange symbol → canonical symbol normalization
//
// At construct time all Binance configuration is snapshotted so caller
// mutations to the original options bag cannot affect Collectors created later.

import type { TradingRuntime, TradingRuntimeOptions } from './TradingRuntime';
import { createTradingRuntime } from './TradingRuntime';
import {
  BinanceV2PublicCollector,
  type BinanceV2PublicCollectorOptions,
  type BinanceCollectorFailure,
  type BinanceWebSocketFactory,
  type BinanceTimerScheduler,
} from '../../data/binance/BinanceV2PublicCollector';
import type { BinanceSubscriptionPlannerOptions } from '../../data/binance/BinanceSubscriptionPlanner';
import type { Clock } from '../../data/MarketSnapshot';

/**
 * Failure reported by a Binance Collector owned by the runtime.
 * Augments the protocol-level BinanceCollectorFailure with the SubscriptionPlan
 * version that the failing Collector was actually running under.
 */
export interface BinanceTradingRuntimeCollectorFailure
  extends BinanceCollectorFailure {
  readonly planVersion: number;
}

/**
 * Options for createBinanceTradingRuntime.
 *
 * Extends TradingRuntimeOptions but replaces `collectorFactory` with a Binance-
 * specific `binance` options bag. The factory is constructed internally so
 * that the runtime can supply the exact captured SubscriptionPlan on each
 * (re)start.
 */
export interface BinanceTradingRuntimeOptions
  extends Omit<TradingRuntimeOptions, 'collectorFactory'> {

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
    failure: BinanceTradingRuntimeCollectorFailure
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
  binance: BinanceTradingRuntimeOptions['binance'],
): SnapshotBinanceConfig | null {
  if (!binance) return null;

  const marketEndpoint = binance.marketEndpoint;
  const publicEndpoint = binance.publicEndpoint;

  const webSocketFactory = binance.webSocketFactory;
  if (typeof webSocketFactory !== 'function' && webSocketFactory !== undefined) {
    throw new TypeError('BinanceTradingRuntime: binance.webSocketFactory must be a function when provided');
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
 * Compose a TradingRuntime with a Binance V2 Public Collector factory.
 *
 * The factory:
 *   - Creates a NEW BinanceV2PublicCollector per restart (no caching, no
 *     singleton).
 *   - Sources all non-plan configuration from the snapshot taken at the
 *     time this function is called.
 *   - Passes the runtime-supplied SubscriptionPlan as the LAST field so
 *     caller-supplied `binance.plan` (when injected via `any`) is overridden.
 *   - Binds onBinanceCollectorError with the live Collector's planVersion.
 */
export function createBinanceTradingRuntime(
  options: BinanceTradingRuntimeOptions
): TradingRuntime {
  const {
    binance,
    onBinanceCollectorError,
    ...tradingOptions
  } = options;

  const snapshot = snapshotBinanceConfig(binance);
  const runtimeOptions: Omit<TradingRuntimeOptions, 'collectorFactory'> = tradingOptions;

  return createTradingRuntime({
    ...runtimeOptions,
    collectorFactory: (plan) => {
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
  });
}
