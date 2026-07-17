// Stage 3B2C + 3B2C-R1 + 3B4A: Bitget Trading Runtime composition root
//
// Composes createTradingRuntime with a Bitget Market Data Provider.
// Layer responsibilities (must NOT cross):
//   UniverseManager         → SubscriptionPlan (canonical symbols)
//   TradingRuntime          → plan defensive copy, PlanAwareCollector, lifecycle
//   BitgetMarketDataProvider → snapshot Bitget config, build Collector per plan
//   BitgetV2PublicCollector  → V2 protocol, ack/heartbeat/reconnect, candle close
//   PlanAwareCollector      → exchange symbol → canonical symbol normalization
//
// Stage 3B4A — Refactor to Provider:
//   The snapshot + collector-build logic now lives in
//   createBitgetMarketDataProvider(). createBitgetTradingRuntime is now a
//   thin wrapper that builds a Provider and wires its createCollector into
//   createTradingRuntime. Public API, types, and behavior are unchanged.

import type { TradingRuntime, TradingRuntimeOptions } from './TradingRuntime';
import { createTradingRuntime } from './TradingRuntime';
import type {
  BitgetV2PublicCollectorOptions,
  BitgetCollectorFailure,
} from '../../data/bitget/BitgetV2PublicCollector';
import {
  createBitgetMarketDataProvider,
  type BitgetMarketDataProviderOptions,
} from './BitgetMarketDataProvider';

/**
 * Failure reported by a Bitget V2 Collector owned by the runtime.
 * Augments the protocol-level BitgetCollectorFailure with the SubscriptionPlan
 * version that the failing Collector was actually running under.
 *
 * Does NOT include:
 *   - the full SubscriptionPlan
 *   - raw WebSocket payloads
 *   - bitget API keys
 *   - any account / order information
 */
export interface BitgetTradingRuntimeCollectorFailure
  extends BitgetCollectorFailure {
  readonly planVersion: number;
}

/**
 * Options for createBitgetTradingRuntime.
 *
 * Extends TradingRuntimeOptions but replaces `collectorFactory` with a Bitget
 * V2 specific `bitget` options bag. The factory is constructed internally so
 * that the runtime can supply the exact captured SubscriptionPlan on each
 * (re)start.
 */
export interface BitgetTradingRuntimeOptions
  extends Omit<TradingRuntimeOptions, 'collectorFactory'> {

  /**
   * Bitget V2 Collector tuning. All fields optional except `plan` which is
   * supplied by the runtime on each restart. NEVER read `bitget.plan` even if
   * the caller injects it via `any` — the runtime plan always overrides.
   */
  readonly bitget?: Omit<BitgetV2PublicCollectorOptions, 'plan'>;

  /**
   * Optional Collector failure callback. Each Collector instance binds its
   * own handler; restart swaps the binding. The callback receives the
   * Collector's actual planVersion at the time of the failure.
   */
  readonly onBitgetCollectorError?: (
    failure: BitgetTradingRuntimeCollectorFailure
  ) => void;
}

/**
 * Compose a TradingRuntime with a Bitget V2 Public Collector factory.
 *
 * Since Stage 3B4A this function delegates to createBitgetMarketDataProvider.
 * Public API, types, and behavior are unchanged.
 *
 * The Provider:
 *   - Creates a NEW BitgetV2PublicCollector per restart (no caching, no
 *     singleton, no use of legacy createCollector/getCollector).
 *   - Sources all non-plan configuration from the snapshot taken at the
 *     time the Provider (and thus this function) is called. Caller mutations
 *     to the original `bitget` bag, `plannerOptions`, or `scheduler`
 *     (including bound `setTimeout`/`clearTimeout` swaps) cannot retroactively
 *     affect Collectors created later.
 *   - Passes the runtime-supplied SubscriptionPlan as the LAST field so
 *     caller-supplied `bitget.plan` (when injected via `any`) is overridden.
 *   - Binds onBitgetCollectorError with the live Collector's planVersion.
 *
 * Error propagation:
 *   - BitgetCollectorFailure stays at the Bitget layer (connect / subscribe /
 *     heartbeat / parse / reconnect).
 *   - MarketDataRuntimeFailure stays at the runtime layer (collector start /
 *     bus / store).
 *   - The two are NOT converted into each other.
 */
export function createBitgetTradingRuntime(
  options: BitgetTradingRuntimeOptions
): TradingRuntime {
  // Destructure WITHOUT mutating the original options bag. Do not retain any
  // mutable reference as hidden state.
  const {
    bitget,
    onBitgetCollectorError,
    ...tradingOptions
  } = options;

  // Build the Provider. It snapshots all Bitget configuration in ONE place.
  // After this point we never reference `bitget` again.
  const providerOptions: BitgetMarketDataProviderOptions = {
    bitget,
    onBitgetCollectorError,
  };
  const provider = createBitgetMarketDataProvider(providerOptions);

  // Pure TradingRuntimeOptions without bitget / onBitgetCollectorError.
  const runtimeOptions: Omit<TradingRuntimeOptions, 'collectorFactory'> = tradingOptions;

  return createTradingRuntime({
    ...runtimeOptions,
    collectorFactory: (plan) => provider.createCollector(plan),
  });
}
