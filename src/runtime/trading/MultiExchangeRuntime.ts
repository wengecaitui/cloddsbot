// Stage 3B4C3: MultiExchangeRuntime — dual-exchange coordinator
//
// Orchestrates exactly one Bitget TradingRuntime and one Binance
// TradingRuntime under a single coordinator with independent fail
// isolation. Per-exchange state lives on each child runtime; the
// coordinator never aggregates, prefixes, or projects data across
// exchanges.
//
//   ┌──────────────────────── MultiExchangeRuntime ────────────────────────┐
//   │                                                                       │
//   │   ┌──────────────┐                      ┌──────────────┐             │
//   │   │ Bitget RT     │                      │ Binance RT    │             │
//   │   │  - universe   │                      │  - universe   │             │
//   │   │  - marketData │                      │  - marketData │             │
//   │   │  - router     │                      │  - router     │             │
//   │   │  - killSwitch │                      │  - killSwitch │             │
//   │   │  - bus        │                      │  - bus        │             │
//   │   │  - fastPipe   │                      │  - fastPipe   │             │
//   │   │  - slowPipe   │                      │  - slowPipe   │             │
//   │   └──────────────┘                      └──────────────┘             │
//   └───────────────────────────────────────────────────────────────────────┘
//
// Hard isolation invariants (enforced after construction, before return):
//   - bitgetRuntime !== binanceRuntime (by identity)
//   - no shared universe / bus / store / candleStore
//   - no shared fastPipeline / slowPipeline
//   - no shared router / killSwitch
//
// Allowed to share: IndicatorService, Clock, pure functional deps.
// Any violation throws MultiExchangeIsolationError synchronously at create time.

import type { UniverseApplyResult, TradingRuntime } from './TradingRuntime';
import { createExchangeTradingRuntime } from './ExchangeTradingRuntime';
import type { ExchangeTradingRuntimeOptions } from './ExchangeTradingRuntime';
import type { ExchangeId } from '../../data/MarketIdentity';
import { isExchangeId } from '../../data/MarketIdentity';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Stage 3B4C3-R1: Child option types derived from {@link ExchangeTradingRuntimeOptions}
 * via `Extract`, so a caller cannot accidentally pass a Binance-shaped options
 * bag to the Bitget side (or vice versa). The discriminated `exchange` field
 * is removed from the call-site bag and re-injected at construction so that
 * callers cannot override the coordinator's fixed exchange identity.
 */
type BitgetChildOptions = Omit<
  Extract<ExchangeTradingRuntimeOptions, { exchange: 'bitget' }>,
  'exchange'
>;
type BinanceChildOptions = Omit<
  Extract<ExchangeTradingRuntimeOptions, { exchange: 'binance' }>,
  'exchange'
>;

export interface MultiExchangeRuntimeOptions {
  bitget: BitgetChildOptions;
  binance: BinanceChildOptions;
}

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
  exchange: ExchangeId;
  state: PerExchangeRuntimeState;
  planVersion: number | null;
  lastError: string | undefined;
}

export interface MultiExchangeStartResult {
  started: ExchangeId[];
  failed: { exchange: ExchangeId; error: string }[];
  partial: boolean;
}

export interface MultiExchangeRuntime {
  readonly state: MultiExchangeRuntimeState;
  readonly runtimes: ReadonlyMap<ExchangeId, TradingRuntime>;
  readonly statuses: ReadonlyMap<ExchangeId, PerExchangeStatus>;
  start(): Promise<MultiExchangeStartResult>;
  stop(): void;
  applyUniversePlan(exchange: ExchangeId): Promise<UniverseApplyResult>;
  getRuntime(exchange: ExchangeId): TradingRuntime;
  getStatus(exchange: ExchangeId): PerExchangeStatus;
}

// ─── Errors ────────────────────────────────────────────────────────────────

export class MultiExchangeStartError extends Error {
  readonly result: MultiExchangeStartResult;
  constructor(result: MultiExchangeStartResult, message = 'MultiExchangeRuntime: start failed') {
    super(message);
    this.name = 'MultiExchangeStartError';
    this.result = result;
  }
}

export class MultiExchangeLifecycleCancelledError extends Error {
  constructor(msg = 'MultiExchangeRuntime: lifecycle cancelled (stop during start)') {
    super(msg);
    this.name = 'MultiExchangeLifecycleCancelledError';
  }
}

/**
 * Stage 3B4C3-R1: Thrown synchronously by {@link createMultiExchangeRuntime}
 * when child-runtime isolation invariants are violated (shared universe/bus/
 * store/router/killSwitch/pipeline). The `resource` field names the offending
 * resource only — no configuration data is leaked into the message.
 */
export class MultiExchangeIsolationError extends Error {
  readonly resource: string;
  constructor(resource: string) {
    super(`MultiExchangeRuntime: isolation violation — shared resource: ${resource}`);
    this.name = 'MultiExchangeIsolationError';
    this.resource = resource;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Stage 3B4C3-R1: Safe error-message redaction.
 *
 * Contract:
 *   - Error: capture `name + ': ' + message`; never stringify arbitrary objects.
 *   - Non-Error: fixed text "Unknown lifecycle error".
 *   - Strip newlines / control chars.
 *   - Truncate to 256 chars (on Unicode code-point boundary).
 *   - Case-insensitively redact secrets matching: apiKey, api_key, secret,
 *     token, authorization, password — replace with the token name plus
 *     "[REDACTED]" so the failure phase remains identifiable.
 *   - Strip obvious Windows (C:\...) and POSIX (/home/..., /Users/...) absolute
 *     paths; replace with the leading absolute-path marker only.
 *   - Never include raw WS payloads or full configuration objects.
 */
function safeErrorMessage(error: unknown): string {
  let raw: string;
  if (error instanceof Error) {
    const name = (error.name ?? 'Error').toString();
    const msg = (error.message ?? '').toString();
    raw = msg ? `${name}: ${msg}` : name;
  } else {
    raw = 'Unknown lifecycle error';
  }

  // Strip newlines and control characters (replace with space; collapse runs).
  let cleaned = raw.replace(/[\u0000-\u001F\u007F\u0080-\u009F]+/g, ' ');

  // Redact secrets. Match `name=value` or `name: value` (case-insensitive)
  // for the listed secret names. Value is anything up to whitespace, comma,
  // semicolon, quote, or end of string.
  const secretNames = [
    'apiKey', 'api_key', 'secret', 'token', 'authorization', 'password',
  ];
  const secretPattern = new RegExp(
    '(' + secretNames.map(escapeRegex).join('|') + ')' +
      '(?:\\s*[:=]\\s*)' +
      '([^\\s,;\'"]+)',
    'gi',
  );
  cleaned = cleaned.replace(secretPattern, (_m, name: string) => {
    return `${name}=[REDACTED]`;
  });

  // Strip Windows absolute paths: drive letter + colon + single-backslash path.
  // Also strip UNC paths: \\server\share\...
  cleaned = cleaned.replace(/\b[A-Za-z]:\\[^\s"')\],;]*/g, '[path]');
  cleaned = cleaned.replace(/\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+(?:\.[A-Za-z0-9]+)*(?:\\[A-Za-z0-9._-]+)*/g, '[path]');
  // Strip POSIX absolute paths (/home/..., /Users/..., /var/..., /opt/..., etc.).
  cleaned = cleaned.replace(/(?:^|[^A-Za-z0-9])(\/(?:home|Users|var|etc|root|tmp|opt|private)[A-Za-z0-9_./-]*)/g,
    (_m, _g1?: string) => '[path]');

  // Collapse multiple whitespace runs.
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Truncate to 256 chars on a Unicode code-point boundary.
  const MAX = 256;
  const len = [...cleaned].length;
  if (len > MAX) {
    cleaned = [...cleaned].slice(0, MAX).join('');
  }

  return cleaned;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Total state recomposition: child states → parent state.
//
// Canonical truth table (Stage 3B4C3-R2):
//   both running              → running
//   exactly one running       → degraded
//   neither running, ≥1 failed → failed
//   both stopped              → stopped
function computeParentState(
  bitgetState: PerExchangeRuntimeState,
  binanceState: PerExchangeRuntimeState,
): MultiExchangeRuntimeState {
  const runningCount =
    Number(bitgetState === 'running') +
    Number(binanceState === 'running');
  if (runningCount === 2) return 'running';
  if (runningCount === 1) return 'degraded';
  if (bitgetState === 'failed' || binanceState === 'failed') return 'failed';
  return 'stopped';
}

// ─── Isolation enforcement ─────────────────────────────────────────────────
//
// Run after both children are constructed; throw synchronously (before any
// runtime is started) if any invariant is violated.

function assertIsolation(
  bitget: TradingRuntime,
  binance: TradingRuntime,
): void {
  // Identity: child runtimes must be distinct instances.
  if (bitget === binance) throw new MultiExchangeIsolationError('runtime');

  // Universe must NOT be shared.
  if (bitget.universe === binance.universe) {
    throw new MultiExchangeIsolationError('universe');
  }

  // Event bus must NOT be shared.
  if (bitget.bus === binance.bus) {
    throw new MultiExchangeIsolationError('bus');
  }

  // Market data store and candle store must NOT be shared.
  if (bitget.marketData.store === binance.marketData.store) {
    throw new MultiExchangeIsolationError('marketData.store');
  }
  if (bitget.marketData.candleStore === binance.marketData.candleStore) {
    throw new MultiExchangeIsolationError('marketData.candleStore');
  }

  // Pipelines must NOT be shared.
  if (bitget.fastPipeline === binance.fastPipeline) {
    throw new MultiExchangeIsolationError('fastPipeline');
  }
  if (bitget.slowPipeline === binance.slowPipeline) {
    throw new MultiExchangeIsolationError('slowPipeline');
  }

  // Router and router.killSwitch must NOT be shared.
  if (bitget.router === binance.router) {
    throw new MultiExchangeIsolationError('router');
  }
  if (bitget.router.killSwitch === binance.router.killSwitch) {
    throw new MultiExchangeIsolationError('router.killSwitch');
  }
  // Note: IndicatorService, Clock, and pure-functional deps are allowed
  // to be shared — by design — and are NOT checked here.
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

  // ── Isolation enforcement (Stage 3B4C3-R1) ──────────────────────────────
  // Throws BEFORE returning the coordinator — no shared state can leak.
  assertIsolation(bitgetRuntime, binanceRuntime);

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
      if (!isMyEpoch(myEpoch)) {
        // Stale — suppress status update; the start was cancelled by stop().
        return;
      }
      // Record failure bookkeeping before rethrowing so the parent can
      // compute partial/degraded state from per-exchange status.
      const safe = safeErrorMessage(err);
      if (exchange === 'bitget') {
        bitgetStatus = 'failed';
        bitgetLastError = safe;
      } else {
        binanceStatus = 'failed';
        binanceLastError = safe;
      }
      throw err;
    }
  }

  // Backfill a successful side's status when its sibling failed.
  function recordSuccess(ex: ExchangeId, rt: TradingRuntime) {
    if (ex === 'bitget') {
      bitgetStatus = 'running';
      bitgetPlanVersion = rt.appliedPlanVersion;
      bitgetLastError = undefined;
    } else {
      binanceStatus = 'running';
      binancePlanVersion = rt.appliedPlanVersion;
      binanceLastError = undefined;
    }
  }

  return {
    get state(): MultiExchangeRuntimeState {
      return computeParentStateFromStatuses();
    },

    get runtimes(): ReadonlyMap<ExchangeId, TradingRuntime> {
      // Return a defensive copy so callers cannot mutate the internal map.
      return new Map(children);
    },

    get statuses(): ReadonlyMap<ExchangeId, PerExchangeStatus> {
      // Return a defensive copy so callers cannot mutate the internal map.
      return buildStatuses();
    },

    start(): Promise<MultiExchangeStartResult> {
      // ── Promise identity: identical promise for concurrent callers ──────
      if (pendingStartPromise !== null) {
        return pendingStartPromise;
      }

      // Idempotency: if both children are already running, succeed fast.
      if (bitgetRuntime.isRunning && binanceRuntime.isRunning) {
        return Promise.resolve({
          started: ['bitget', 'binance'],
          failed: [],
          partial: false,
        } satisfies MultiExchangeStartResult);
      }

      const myEpoch = epoch;
      pendingStartEpoch = myEpoch;

      const p = (async (): Promise<MultiExchangeStartResult> => {
        const results = await Promise.allSettled([
          startChild('bitget', bitgetRuntime, myEpoch),
          startChild('binance', binanceRuntime, myEpoch),
        ]);

        // Bail-out: stop() was called during start → cancel.
        if (!isMyEpoch(myEpoch)) {
          throw new MultiExchangeLifecycleCancelledError();
        }

        const started: ExchangeId[] = [];
        const failed: { exchange: ExchangeId; error: string }[] = [];

        // Iterate in fixed order: bitget, binance (deterministic)
        if (results[0].status === 'fulfilled') {
          // Mark bitget success only if it actually ended up running.
          if (bitgetRuntime.isRunning) recordSuccess('bitget', bitgetRuntime);
          started.push('bitget');
        } else {
          // results[0].status === 'rejected' — status already set by startChild.
          const err = (results[0] as PromiseRejectedResult).reason;
          failed.push({ exchange: 'bitget', error: safeErrorMessage(err) });
        }
        if (results[1].status === 'fulfilled') {
          if (binanceRuntime.isRunning) recordSuccess('binance', binanceRuntime);
          started.push('binance');
        } else {
          const err = (results[1] as PromiseRejectedResult).reason;
          failed.push({ exchange: 'binance', error: safeErrorMessage(err) });
        }

        const result: MultiExchangeStartResult = {
          started,
          failed,
          partial: failed.length > 0 && started.length > 0,
        };

        // Final state check: if no side started AND no side failed (both
        // already stopped, e.g. due to epoch cancellation while pending) —
        // surface as cancel rather than resurrecting running.
        if (!isMyEpoch(myEpoch)) {
          throw new MultiExchangeLifecycleCancelledError();
        }

        // If both sides failed → throw MultiExchangeStartError.
        if (failed.length === 2 && started.length === 0) {
          throw new MultiExchangeStartError(result, 'MultiExchangeRuntime: all child starts failed');
        }

        // Clear pendingStartPromise synchronously with success.
        if (pendingStartEpoch === myEpoch) {
          pendingStartPromise = null;
          pendingStartEpoch = -1;
        }

        return result;
      })();

      pendingStartPromise = p;
      // Defensive: clear pendingStartPromise on terminal settle so a later
      // start() after stop()/failure starts fresh.
      p.then(() => {
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

      // Always attempt both children — second side runs even if the first throws.
      // Failures are recorded into per-exchange status (state=failed + lastError)
      // rather than re-thrown: stop() remains void as per stage contract.
      try {
        bitgetRuntime.stop();
        bitgetStatus = 'stopped';
      } catch (err) {
        bitgetStatus = 'failed';
        bitgetLastError = safeErrorMessage(err);
      }
      try {
        binanceRuntime.stop();
        binanceStatus = 'stopped';
      } catch (err) {
        binanceStatus = 'failed';
        binanceLastError = safeErrorMessage(err);
      }
      // parent state is derived from per-exchange status — recomputed on next read.
      // lastError is preserved until a subsequent successful start clears it.
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
            bitgetLastError = safeErrorMessage(err);
          } else {
            binanceStatus = 'failed';
            binanceLastError = safeErrorMessage(err);
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
