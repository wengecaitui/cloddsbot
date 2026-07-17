// Stage 3B2C: Bitget Trading Runtime composition root
//
// Composes createTradingRuntime with a per-plan BitgetV2PublicCollector factory.
// Layer responsibilities (must NOT cross):
//   UniverseManager         → SubscriptionPlan (canonical symbols)
//   TradingRuntime          → plan defensive copy, PlanAwareCollector, lifecycle
//   BitgetV2PublicCollector → V2 protocol, ack/heartbeat/reconnect, candle close
//   PlanAwareCollector      → exchange symbol → canonical symbol normalization
//
// This module only wires the Bitget V2 Collector into the generic TradingRuntime.
// It does NOT duplicate TradingRuntime logic, does NOT touch the legacy V1
// collector, and does NOT migrate volume-api.

import type { TradingRuntime, TradingRuntimeOptions } from './TradingRuntime';
import { createTradingRuntime } from './TradingRuntime';
import {
  BitgetV2PublicCollector,
  type BitgetV2PublicCollectorOptions,
  type BitgetCollectorFailure,
} from '../../data/bitget/BitgetV2PublicCollector';

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
 * The factory:
 *   - Creates a NEW BitgetV2PublicCollector per restart (no caching, no
 *     singleton, no use of legacy createCollector/getCollector).
 *   - Passes the exact plan captured by the TradingRuntime as the LAST field
 *     so caller-supplied `bitget` options cannot override it.
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

  // Pure TradingRuntimeOptions without bitget / onBitgetCollectorError.
  // We do NOT include collectorFactory here — it is supplied in the spread
  // below. The cast through `as TradingRuntimeOptions` is unnecessary because
  // the merged object satisfies the interface once collectorFactory is added.
  const runtimeOptions: Omit<TradingRuntimeOptions, 'collectorFactory'> = tradingOptions;

  return createTradingRuntime({
    ...runtimeOptions,
    collectorFactory: (plan) => {
      // Plan must come LAST so caller-supplied `bitget` cannot override it.
      // Even if a caller injects `bitget.plan` via `any`, this `plan` wins.
      const collector = new BitgetV2PublicCollector({
        ...bitget,
        plan,
      });

      // Bind per-instance error handler. `collector.planVersion` is read at
      // failure time so stale callbacks from a previous Collector instance
      // carry the previous plan version (the Collector itself already guards
      // stale generation via internal generation token).
      collector.onError((failure: BitgetCollectorFailure) => {
        onBitgetCollectorError?.({
          ...failure,
          planVersion: collector.planVersion,
        });
      });

      return collector;
    },
  });
}
