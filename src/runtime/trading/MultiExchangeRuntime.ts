// Stage 3B4C3: MultiExchangeRuntime — dual-exchange coordinator
//
// Orchestrates exactly one Bitget TradingRuntime and one Binance
// TradingRuntime under a single coordinator with independent failure and
// lifecycle domains. Does NOT replace or wrap createTradingRuntime;
// callers that need only one exchange use createExchangeTradingRuntime
// (or the per-exchange factories) directly.
//
// Architecture:
//   MultiExchangeRuntime
//     ├── Bitget TradingRuntime       (exchangeIsolated — Store/Bus/Universe/Pipeline)
//     └── Binance TradingRuntime      (exchangeIsolated — Store/Bus/Universe/Pipeline)
//
// Lifecycle states (parent):
//   running   → both children running
//   degraded  → exactly one child running
//   failed    → neither running, at least one failed
//   stopped   → neither stopped, no failures
//
// Per-child states:
//   running | stopped | failed  (no "degraded" at child level)
//
// Rules:
//   - Construction does NOT open any socket.
//   - start() runs both children concurrently; partial success → degraded.
//   - stop() always stops both children (second even if first throws).
//   - applyUniversePlan(exchange) targets exactly one child.
//   - epoch/fencing prevents stale completions from reviving state.
//   - Router/KillSwitch are NOT shared (not yet exchange-aware).
//   - IndicatorService MAY be shared (pure function, no exchange state).

import type { TradingRuntime, UniverseApplyResult } from './TradingRuntime';
import { createExchangeTradingRuntime } from './ExchangeTradingRuntime';
import type {
  ExchangeTradingRuntimeOptions,
} from './ExchangeTradingRuntime';
import type { ExchangeId } from '../../data/MarketIdentity';
import { isExchangeId } from '../../data/MarketIdentity';

// ─── Public types ──────────────────────────────────────────────────────────

export type MultiExchangeRuntimeState =
  | 'stopped'
  | 'running'
  | 'degraded'
  | 'failed';

export type PerExchangeRuntimeState =
  | 'stopped'
  | 'running'
  | 'failed';

export interface PerExchangeStatus {
  readonly exchange: ExchangeId;
  readonly state: PerExchangeRuntimeState;
  readonly planVersion: number | null;
  readonly lastError?: string;
}

export interface MultiExchangeStartResult {
  readonly started: ReadonlyArray<ExchangeId>;
  readonly failed: ReadonlyArray<{
    exchange: ExchangeId;
    error: string;
  }>;
  readonly partial: boolean;
}

export class MultiExchangeStartError extends Error {
  readonly result: MultiExchangeStartResult;
  constructor(result: MultiExchangeStartResult) {
    const msg = `MultiExchangeRuntime: start failed — ${result.failed.length} exchange(s) failed, ${result.started.length} started`;
    super(msg);
    this.name = 'MultiExchangeStartError';
    this.result = result;
    Object.setPrototypeOf(this, MultiExchangeStartError.prototype);
  }
}

export class MultiExchangeLifecycleCancelledError extends Error {
  constructor(msg = 'MultiExchangeRuntime: lifecycle cancelled (stop during start)') {
    super(msg);
    this.name = 'MultiExchangeLifecycleCancelledError';
    Object.setPrototypeOf(this, MultiExchangeLifecycleCancelledError.prototype);
  }
}

// ─── Derived option types ──────────────────────────────────────────────────

type BitgetChildOptions =
  Omit<
    Extract<ExchangeTradingRuntimeOptions, { exchange: 'bitget' }>,
    'exchange'
  >;

type BinanceChildOptions =
  Omit<
    Extract<ExchangeTradingRuntimeOptions, { exchange: 'binance' }>,
    'exchange'
  >;

export interface MultiExchangeRuntimeOptions {
  readonly bitget: BitgetChildOptions;
  readonly binance: BinanceChildOptions;
}

// ─── Coordinator ───────────────────────────────────────────────────────────

export interface MultiExchangeRuntime {
  readonly state: MultiExchangeRuntimeState;
  readonly runtimes: ReadonlyMap<ExchangeId, TradingRuntime>;
  readonly statuses: ReadonlyMap<ExchangeId, PerExchangeStatus>;

  start(): Promise<MultiExchangeStartResult>;
  stop(): void;

  applyUniversePlan(
    exchange: ExchangeId,
  ): Promise<UniverseApplyResult>;

  getRuntime(exchange: ExchangeId): TradingRuntime;
  getStatus(exchange: ExchangeId): PerExchangeStatus;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const ALL_EXCHANGES: ExchangeId[] = ['bitget', 'binance'];
const ORDERED: ExchangeId[] = ['bitget', 'binance'];

function computeParentState(
  bitgetState: PerExchangeRuntimeState,
  binanceState: PerExchangeRuntimeState,
): MultiExchangeRuntimeState {
  if (bitgetState === 'running' && binanceState === 'running') return 'running';
  if (bitgetState === 'running' || binanceState === 'running') return 'degraded';
  if (bitgetState === 'failed' || binanceState === 'failed') return 'failed';
  return 'stopped';
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createMultiExchangeRuntime(
  options: MultiExchangeRuntimeOptions,
): MultiExchangeRuntime {
  // ── Build children ───────────────────────────────────────────────────────
  // exchange is injected AFTER spread of caller data so that a caller injecting
  // an 'exchange' field via `any` cannot override the coordinator's fixed value.
  const bitgetRuntime: TradingRuntime = createExchangeTradingRuntime({
    ...options.bitget,
    exchange: 'bitget',
  });
  const binanceRuntime: TradingRuntime = createExchangeTradingRuntime({
    ...options.binance,
    exchange: 'binance',
  });

  // ── Children map ─────────────────────────────────────────────────────────
  const children = new Map<ExchangeId, TradingRuntime>([
    ['bitget', bitgetRuntime],
    ['binance', binanceRuntime],
  ]);

  // ── Per-exchange status state ────────────────────────────────────────────
  // Stopped initially; no failures; no applied version.
  let bitgetStatus: PerExchangeRuntimeState = 'stopped';
  let binanceStatus: PerExchangeRuntimeState = 'stopped';
  let bitgetPlanVersion: number | null = null;
  let binancePlanVersion: number | null = null;
  let bitgetLastError: string | undefined;
  let binanceLastError: string | undefined;

  let epoch = 0;

  // ── Start Promise identity ──────────────────────────────────────────────
  let pendingStartPromise: Promise<MultiExchangeStartResult> | null = null;
  let pendingStartEpoch = -1;

  // ── Per-exchange apply Promise identity ──────────────────────────────────
  const pendingApplyPromises = new Map<ExchangeId, Promise<UniverseApplyResult>>();

  // ── Epoch guard ──────────────────────────────────────────────────────────
  function isMyEpoch(e: number): boolean {
    return e === epoch;
  }

  // ── Read statuses helper ────────────────────────────────────────────────
  function readPerExchangeStatus(
    exchange: ExchangeId,
    child: TradingRuntime,
    childState: PerExchangeRuntimeState,
    planVersion: number | null,
    lastError: string | undefined,
  ): PerExchangeStatus {
    // Runtime may be running even if coordinator hasn't tracked it yet
    // (e.g. after restart). Prefer the child's live isRunning for state unless
    // a failure was explicitly recorded.
    const liveState: PerExchangeRuntimeState =
      child.isRunning && childState !== 'failed'
        ? 'running'
        : childState === 'failed'
          ? 'failed'
          : 'stopped';
    return {
      exchange,
      state: liveState,
      planVersion: child.appliedPlanVersion ?? planVersion,
      lastError,
    };
  }

  function buildStatuses(): Map<ExchangeId, PerExchangeStatus> {
    const map = new Map<ExchangeId, PerExchangeStatus>();
    map.set('bitget', readPerExchangeStatus('bitget', bitgetRuntime, bitgetStatus, bitgetPlanVersion, bitgetLastError));
    map.set('binance', readPerExchangeStatus('binance', binanceRuntime, binanceStatus, binancePlanVersion, binanceLastError));
    return map;
  }

  function computeParentStateFromStatuses(): MultiExchangeRuntimeState {
    const s = buildStatuses();
    return computeParentState(
      s.get('bitget')!.state,
      s.get('binance')!.state,
    );
  }

  // ── Async: start a single child with epoch guard ─────────────────────────
  async function startChild(
    exchange: ExchangeId,
    rt: TradingRuntime,
    myEpoch: number,
  ): Promise<void> {
    try {
      if (rt.isRunning) return; // idempotent per child
      await rt.start();
      if (!isMyEpoch(myEpoch)) {
        // Stop was called — don't track status
        return;
      }
      // Success — clear lastError for this exchange
      if (exchange === 'bitget') {
        bitgetStatus = 'running';
        bitgetPlanVersion = rt.appliedPlanVersion;
        bitgetLastError = undefined;
      } else {
        binanceStatus = 'running';
        binancePlanVersion = rt.appliedPlanVersion;
        binanceLastError = undefined;
      }
    } catch (err) {
      if (!isMyEpoch(myEpoch)) return; // stale
      if (exchange === 'bitget') {
        bitgetStatus = 'failed';
        bitgetLastError = errorToString(err);
      } else {
        binanceStatus = 'failed';
        binanceLastError = errorToString(err);
      }
      throw err; // re-throw so caller knows which one failed
    }
  }

  // ── Factory object ───────────────────────────────────────────────────────

  return {
    get state(): MultiExchangeRuntimeState {
      return computeParentStateFromStatuses();
    },

    get runtimes(): ReadonlyMap<ExchangeId, TradingRuntime> {
      return new Map(children);
    },

    get statuses(): ReadonlyMap<ExchangeId, PerExchangeStatus> {
      return buildStatuses();
    },

    start(): Promise<MultiExchangeStartResult> {
      if (pendingStartPromise !== null) return pendingStartPromise;

      const myEpoch = epoch;
      pendingStartEpoch = myEpoch;

      const p = (async (): Promise<MultiExchangeStartResult> => {
        const started: ExchangeId[] = [];
        const failed: Array<{ exchange: ExchangeId; error: string }> = [];

        // Run both concurrently
        const results = await Promise.allSettled(
          ORDERED.map(ex => startChild(ex, children.get(ex)!, myEpoch)),
        );

        // Always ordered [bitget, binance]
        for (let i = 0; i < ORDERED.length; i++) {
          const ex = ORDERED[i];
          const r = results[i];
          if (r.status === 'fulfilled') {
            // Success — started (or was already running)
            if (ex === 'bitget') {
              if (bitgetStatus === 'running') started.push(ex);
            } else {
              if (binanceStatus === 'running') started.push(ex);
            }
          } else {
            failed.push({ exchange: ex, error: errorToString(r.reason) });
          }
        }

        if (!isMyEpoch(myEpoch)) {
          // stop() was called during start — reject with cancelled
          throw new MultiExchangeLifecycleCancelledError();
        }

        const partial = failed.length > 0 && started.length > 0;
        const result: MultiExchangeStartResult = { started, failed, partial };

        if (failed.length === 2) {
          // Both failed — reject
          throw new MultiExchangeStartError(result);
        }

        // At least one succeeded → resolve with result (partial=true if one failed)
        return result;
      })();

      pendingStartPromise = p;

      // Cleanup identity guard on settle
      const cleanup = p.then(() => {
        if (pendingStartPromise === p) {
          pendingStartPromise = null;
          pendingStartEpoch = -1;
        }
      }).catch(() => {
        if (pendingStartPromise === p) {
          pendingStartPromise = null;
          pendingStartEpoch = -1;
        }
      });

      return p;
    },

    stop(): void {
      epoch += 1;
      pendingStartPromise = null;
      pendingStartEpoch = -1;
      pendingApplyPromises.clear();

      // Always try both children — second side attempts even if first throws
      let firstErr: unknown;
      try {
        bitgetRuntime.stop();
        bitgetStatus = 'stopped';
      } catch (err) {
        firstErr = err;
      }
      try {
        binanceRuntime.stop();
        binanceStatus = 'stopped';
      } catch (err) {
        if (firstErr === undefined) firstErr = err;
      }
      // Do NOT clear lastError — retain diagnostic info
      // (cleared only on next successful start)
    },

    applyUniversePlan(exchange: ExchangeId): Promise<UniverseApplyResult> {
      if (!isExchangeId(exchange)) {
        throw new Error(`MultiExchangeRuntime: applyUniversePlan called with invalid exchange: ${JSON.stringify(exchange)}`);
      }
      // Identity guard for concurrent calls to the SAME exchange
      if (pendingApplyPromises.has(exchange)) {
        return pendingApplyPromises.get(exchange)!;
      }

      const myEpoch = epoch;
      const rt = children.get(exchange)!;
      const ex = exchange;

      const p = (async (): Promise<UniverseApplyResult> => {
        try {
          const result = await rt.applyUniversePlan();
          if (!isMyEpoch(myEpoch)) {
            // stop during apply — don't update status
            return {
              applied: false,
              restarted: false,
              version: null,
              pending: true,
            };
          }
          // Success
          if (ex === 'bitget') {
            bitgetStatus = 'running';
            bitgetPlanVersion = rt.appliedPlanVersion;
            bitgetLastError = undefined;
          } else {
            binanceStatus = 'running';
            binancePlanVersion = rt.appliedPlanVersion;
            binanceLastError = undefined;
          }
          return result;
        } catch (err) {
          if (!isMyEpoch(myEpoch)) {
            // Stale — suppress
            return {
              applied: false,
              restarted: false,
              version: null,
              pending: true,
            };
          }
          // Failure — mark this exchange failed
          if (ex === 'bitget') {
            bitgetStatus = 'failed';
            bitgetLastError = errorToString(err);
          } else {
            binanceStatus = 'failed';
            binanceLastError = errorToString(err);
          }
          throw err;
        }
      })();

      pendingApplyPromises.set(exchange, p);
      const cleanup = p.then(() => {
        if (pendingApplyPromises.get(exchange) === p) {
          pendingApplyPromises.delete(exchange);
        }
      }).catch(() => {
        if (pendingApplyPromises.get(exchange) === p) {
          pendingApplyPromises.delete(exchange);
        }
      });

      return p;
    },

    getRuntime(exchange: ExchangeId): TradingRuntime {
      if (!isExchangeId(exchange)) {
        throw new Error(`MultiExchangeRuntime: getRuntime called with invalid exchange: ${JSON.stringify(exchange)}`);
      }
      const rt = children.get(exchange);
      if (!rt) {
        throw new Error(`MultiExchangeRuntime: runtime not found for exchange: ${exchange}`);
      }
      return rt;
    },

    getStatus(exchange: ExchangeId): PerExchangeStatus {
      if (!isExchangeId(exchange)) {
        throw new Error(`MultiExchangeRuntime: getStatus called with invalid exchange: ${JSON.stringify(exchange)}`);
      }
      const rt = children.get(exchange);
      if (!rt) {
        throw new Error(`MultiExchangeRuntime: runtime not found for exchange: ${exchange}`);
      }
      const childState = exchange === 'bitget' ? bitgetStatus : binanceStatus;
      const planVersion = exchange === 'bitget' ? bitgetPlanVersion : binancePlanVersion;
      const lastError = exchange === 'bitget' ? bitgetLastError : binanceLastError;
      return readPerExchangeStatus(exchange, rt, childState, planVersion, lastError);
    },
  };
}
