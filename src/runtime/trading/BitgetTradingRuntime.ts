// Stage 3B2C + 3B2C-R1: Bitget Trading Runtime composition root
//
// Composes createTradingRuntime with a per-plan BitgetV2PublicCollector factory.
// Layer responsibilities (must NOT cross):
//   UniverseManager         → SubscriptionPlan (canonical symbols)
//   TradingRuntime          → plan defensive copy, PlanAwareCollector, lifecycle
//   BitgetV2PublicCollector → V2 protocol, ack/heartbeat/reconnect, candle close
//   PlanAwareCollector      → exchange symbol → canonical symbol normalization
//
// Stage 3B2C-R1 — Runtime Option Snapshot:
//   At createBitgetTradingRuntime() call time we copy every Bitget
//   configuration field out of the caller-owned `bitget` bag into a private
//   snapshot. The collectorFactory closure then references ONLY the snapshot.
//   Subsequent caller mutations to the original `bitget` object, its
//   `plannerOptions`, or its `scheduler` (including replaced
//   `scheduler.setTimeout` / `scheduler.clearTimeout`) cannot affect any
//   Collector created after the Runtime was constructed.
//   The Runtime-supplied SubscriptionPlan is always written LAST and overrides
//   any caller-injected `bitget.plan` (even if injected via `any`).

import type { TradingRuntime, TradingRuntimeOptions } from './TradingRuntime';
import { createTradingRuntime } from './TradingRuntime';
import {
  BitgetV2PublicCollector,
  type BitgetV2PublicCollectorOptions,
  type BitgetCollectorFailure,
  type BitgetWebSocketFactory,
  type BitgetTimerScheduler,
} from '../../data/bitget/BitgetV2PublicCollector';
import type { BitgetSubscriptionPlannerOptions } from '../../data/bitget/SubscriptionPlanner';

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

// ── Internal snapshot types ────────────────────────────────────────────────

interface SnapshotPlannerOptions {
  readonly maxArgsPerBatch?: number;
  readonly maxPayloadBytes?: number;
}

interface SnapshotBitgetConfig {
  readonly endpoint?: string;
  readonly webSocketFactory?: BitgetWebSocketFactory;
  readonly scheduler?: BitgetTimerScheduler;
  readonly ackTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly reconnectDelayMs: number;
  readonly plannerOptions: SnapshotPlannerOptions;
}

const DEFAULTS = {
  ackTimeoutMs: 3000,
  heartbeatIntervalMs: 30000,
  pongTimeoutMs: 10000,
  reconnectDelayMs: 3000,
} as const;

/**
 * Build a private snapshot of all Bitget collector configuration the Runtime
 * needs to construct a Collector on demand.
 *
 * Returns null if no `bitget` bag was supplied so the Collector can fall back
 * to its built-in defaults (only useful for tests). The caller's original
 * objects are NOT retained by reference except for `webSocketFactory` (a
 * function — we capture the function value at snapshot time) and the bound
 * `scheduler.setTimeout` / `scheduler.clearTimeout` methods.
 */
function snapshotBitgetConfig(
  bitget: BitgetTradingRuntimeOptions['bitget'],
): SnapshotBitgetConfig | null {
  if (!bitget) return null;

  // ── endpoint ────────────────────────────────────────────────────────────
  // Defensive copy: string is immutable but the caller can re-assign
  // `bitget.endpoint` later. We capture the value at snapshot time.
  const endpoint = bitget.endpoint;

  // ── webSocketFactory ───────────────────────────────────────────────────
  // Capture the function value at snapshot time. If the caller replaces
  // `bitget.webSocketFactory` later, our snapshot still references the
  // originally supplied function.
  const webSocketFactory = bitget.webSocketFactory;
  if (typeof webSocketFactory !== 'function' && webSocketFactory !== undefined) {
    throw new TypeError('BitgetTradingRuntime: bitget.webSocketFactory must be a function when provided');
  }

  // ── scheduler ──────────────────────────────────────────────────────────
  // Bind the scheduler methods at snapshot time. A wrapper object ensures
  // that replacing `scheduler.setTimeout` / `scheduler.clearTimeout` on the
  // caller's object after Runtime construction cannot affect Collectors
  // created subsequently.
  //
  // If the caller does not supply a scheduler we pass `undefined` through and
  // let the Collector use its own default scheduler.
  const userScheduler = bitget.scheduler;
  let scheduler: BitgetTimerScheduler;
  if (userScheduler) {
    const setTimeoutRef = userScheduler.setTimeout.bind(userScheduler);
    const clearTimeoutRef = userScheduler.clearTimeout.bind(userScheduler);
    scheduler = {
      setTimeout: setTimeoutRef,
      clearTimeout: clearTimeoutRef,
    };
  } else {
    // Defer to Collector default scheduler
    scheduler = (undefined as unknown) as BitgetTimerScheduler;
  }

  // ── timeout / delay fields ─────────────────────────────────────────────
  const ackTimeoutMs = bitget.ackTimeoutMs ?? DEFAULTS.ackTimeoutMs;
  const heartbeatIntervalMs = bitget.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
  const pongTimeoutMs = bitget.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;
  const reconnectDelayMs = bitget.reconnectDelayMs ?? DEFAULTS.reconnectDelayMs;

  // ── plannerOptions ─────────────────────────────────────────────────────
  // Create a NEW object. Only copy the two known fields. This severs the
  // link to the caller's `plannerOptions` so later mutations (e.g. caller
  // changes `bitget.plannerOptions.maxArgsPerBatch`) cannot influence
  // already-configured Collectors.
  const userPlanner = bitget.plannerOptions;
  const plannerOptions: SnapshotPlannerOptions = {
    maxArgsPerBatch: userPlanner?.maxArgsPerBatch,
    maxPayloadBytes: userPlanner?.maxPayloadBytes,
  };

  return {
    endpoint,
    webSocketFactory,
    scheduler,
    ackTimeoutMs,
    heartbeatIntervalMs,
    pongTimeoutMs,
    reconnectDelayMs,
    plannerOptions,
  };
}

/**
 * Compose a TradingRuntime with a Bitget V2 Public Collector factory.
 *
 * The factory:
 *   - Creates a NEW BitgetV2PublicCollector per restart (no caching, no
 *     singleton, no use of legacy createCollector/getCollector).
 *   - Sources all non-plan configuration from the snapshot taken at the
 *     time this function is called. Caller mutations to the original
 *     `bitget` bag, `plannerOptions`, or `scheduler` (including bound
 *     `setTimeout`/`clearTimeout` swaps) cannot retroactively affect
 *     Collectors created later.
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

  // Snapshot all Bitget collector configuration in ONE place. After this
  // point the closure NEVER references `bitget` again.
  const snapshot = snapshotBitgetConfig(bitget);

  // Pure TradingRuntimeOptions without bitget / onBitgetCollectorError.
  // We do NOT include collectorFactory here — it is supplied in the spread
  // below.
  const runtimeOptions: Omit<TradingRuntimeOptions, 'collectorFactory'> = tradingOptions;

  return createTradingRuntime({
    ...runtimeOptions,
    collectorFactory: (plan) => {
      let collector: BitgetV2PublicCollector;
      if (snapshot) {
        collector = new BitgetV2PublicCollector({
          plan,
          ...snapshot,
        });
      } else {
        collector = new BitgetV2PublicCollector({ plan });
      }

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
