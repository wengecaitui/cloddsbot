// Stage 3B1B-R1: TradingRuntime — universe-aware composition root
// Hardened lifecycle: deferred plan capture, one-shot Collector plan override,
// unified apply-Promise cleanup with identity guard, no Store cleanup swallowing.

import type { Clock } from '../../data/MarketSnapshot';
import type { CandleSeriesStore } from '../../data/CandleSeriesStore';
import { createCandleSeriesStore } from '../../data/CandleSeriesStore';
import type { TradingEventBus } from '../../events';
import { createTradingEventBus } from '../../events';
import { KillSwitch } from '../../router/KillSwitch';
import { ExecutionRouter } from '../../router/ExecutionRouter';
import type { MarketDataCollectorPort, MarketDataRuntime } from '../market/MarketDataRuntime';
import { createMarketDataRuntime } from '../market/MarketDataRuntime';
import { FastPipeline } from '../../pipeline/FastPipeline';
import { SlowPipeline } from '../../pipeline/SlowPipeline';
import type { SlowPipelineConfig } from '../../pipeline/SlowPipeline';
import type { IndicatorService } from '../../pipeline/IndicatorService';
import type { UniverseManager, SubscriptionPlan, SubscriptionEntry } from '../market/UniverseManager';
import { createPlanAwareCollector } from './PlanAwareCollector';

export interface TradingRuntimeOptions {
  universe: UniverseManager;
  collectorFactory: (plan: SubscriptionPlan) => MarketDataCollectorPort;
  indicatorService: IndicatorService;
  bus?: TradingEventBus;
  clock?: Clock;
  router?: ExecutionRouter;
  routerConfig?: {
    fastPathTimeoutSec?: number;
    maxBiasReportAgeHours?: number;
    killSwitch?: KillSwitch;
  };
  candleCapacity?: number;
  staleAfterMs?: number;
  marketDataInterval?: string;
  minimumSeries?: number;
  seriesLimit?: number;
  maxKlineAgeMs?: number;
  slowPipelineConfig?: Pick<SlowPipelineConfig, 'model' | 'adapterScript' | 'timeoutMs' | 'adapterFactory'>;
}

export interface UniverseApplyResult {
  readonly applied: boolean;
  readonly restarted: boolean;
  readonly version: number | null;
  readonly pending: boolean;
}

export interface TradingRuntime {
  readonly bus: TradingEventBus;
  readonly router: ExecutionRouter;
  readonly marketData: MarketDataRuntime;
  readonly fastPipeline: FastPipeline;
  readonly slowPipeline: SlowPipeline;
  readonly universe: UniverseManager;
  readonly isRunning: boolean;
  readonly appliedPlanVersion: number | null;
  start(): Promise<void>;
  stop(): void;
  applyUniversePlan(): Promise<UniverseApplyResult>;
}

interface PlanSnapshot {
  readonly version: number;
  readonly entries: ReadonlyMap<string, SubscriptionEntry>;
}

// Deep-clone a SubscriptionPlan so callers cannot mutate internal state by
// holding onto the reference returned from universe.getPlan() or by modifying
// the plan they receive inside the collector factory.
function cloneSubscriptionPlan(plan: SubscriptionPlan): SubscriptionPlan {
  const clonedEntries: SubscriptionEntry[] = [];
  for (const e of plan.entries) {
    clonedEntries.push({
      symbol: e.symbol,
      exchangeSymbol: e.exchangeSymbol,
      intervals: [...e.intervals],
      ticker: e.ticker,
    });
  }
  return { version: plan.version, entries: clonedEntries };
}

function snapshotPlanEntries(plan: SubscriptionPlan): PlanSnapshot {
  const map = new Map<string, SubscriptionEntry>();
  for (const e of plan.entries) {
    map.set(e.symbol, {
      symbol: e.symbol,
      exchangeSymbol: e.exchangeSymbol,
      intervals: [...e.intervals].sort(),
      ticker: e.ticker,
    });
  }
  return { version: plan.version, entries: map };
}

function entriesEqualSemantic(a: SubscriptionEntry, b: SubscriptionEntry): boolean {
  if (a.symbol !== b.symbol) return false;
  if (a.exchangeSymbol !== b.exchangeSymbol) return false;
  if (a.ticker !== b.ticker) return false;
  const ai = [...a.intervals].sort();
  const bi = [...b.intervals].sort();
  if (ai.length !== bi.length) return false;
  for (let i = 0; i < ai.length; i++) {
    if (ai[i] !== bi[i]) return false;
  }
  return true;
}

function computeStaleSymbols(prev: PlanSnapshot | null, next: PlanSnapshot): string[] {
  const stale: string[] = [];
  if (!prev) return stale;
  if (prev.version === next.version) return stale;

  for (const [sym, prevEntry] of prev.entries) {
    const nextEntry = next.entries.get(sym);
    if (!nextEntry) {
      stale.push(sym);
    } else if (!entriesEqualSemantic(prevEntry, nextEntry)) {
      stale.push(sym);
    }
  }
  return stale.sort();
}

export function createTradingRuntime(options: TradingRuntimeOptions): TradingRuntime {
  if (options.router && options.routerConfig) {
    throw new Error('TradingRuntime: cannot provide both router and routerConfig');
  }
  if (!options.universe) {
    throw new Error('TradingRuntime: universe is required');
  }

  const universe = options.universe;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const bus: TradingEventBus = options.bus ?? createTradingEventBus();

  let router: ExecutionRouter;
  if (options.router) {
    router = options.router;
  } else {
    const rc = options.routerConfig ?? {};
    const ks = rc.killSwitch ?? new KillSwitch();
    router = new ExecutionRouter({
      fastPathTimeoutSec: rc.fastPathTimeoutSec ?? 1.5,
      maxBiasReportAgeHours: rc.maxBiasReportAgeHours ?? 2,
      killSwitch: ks,
    });
  }

  const candleStore: CandleSeriesStore = createCandleSeriesStore({
    capacityPerSeries: options.candleCapacity ?? 500,
  });

  // ── Lifecycle state ──────────────────────────────────────────────────────
  let epoch = 0;
  let pendingStartPromise: Promise<void> | null = null;
  let pendingStartEpoch = -1;
  let pendingApplyPromise: Promise<UniverseApplyResult> | null = null;
  let appliedPlanVersion: number | null = null;
  let appliedPlanSnapshot: PlanSnapshot | null = null;

  // One-shot override: set immediately before marketData.start() is invoked.
  // wrappedCollectorFactory consumes and clears it. If a stale call ever
  // reaches the factory with no override present, it throws — that's a bug.
  let pendingCollectorPlan: SubscriptionPlan | null = null;

  function isMyEpoch(e: number): boolean {
    return e === epoch;
  }

  // Wrapped collector factory: uses the one-shot captured plan override,
  // passes a defensive copy to the external factory, passes a separate
  // defensive copy to PlanAwareCollector. The two copies are independent —
  // external code cannot mutate the PlanAwareCollector's filter state.
  function wrappedCollectorFactory(): MarketDataCollectorPort {
    if (pendingCollectorPlan === null) {
      throw new Error('TradingRuntime: wrappedCollectorFactory called without a captured plan');
    }
    const captured = pendingCollectorPlan;
    pendingCollectorPlan = null;

    const forExternal = cloneSubscriptionPlan(captured);
    const raw = options.collectorFactory(forExternal);
    const forFilter = cloneSubscriptionPlan(captured);
    return createPlanAwareCollector(raw, forFilter);
  }

  const marketData: MarketDataRuntime = createMarketDataRuntime({
    collectorFactory: wrappedCollectorFactory,
    clock,
    staleAfterMs: options.staleAfterMs ?? 60_000,
    bus,
    candleStore,
  });

  const interval = options.marketDataInterval ?? '1m';
  const minimumSeries = options.minimumSeries ?? 100;
  const seriesLimit = options.seriesLimit ?? 200;
  const maxKlineAgeMs = options.maxKlineAgeMs ?? 120_000;

  const fastPipeline = new FastPipeline({
    router: router as any,
    indicatorService: options.indicatorService,
    marketData: {
      snapshotStore: marketData.store,
      candleStore: marketData.candleStore,
      interval, minimumSeries, seriesLimit, maxKlineAgeMs,
    },
  });

  const spc = options.slowPipelineConfig ?? {};
  const slowPipeline = new SlowPipeline({
    router: router as any,
    bus, clock,
    model: spc.model,
    adapterScript: spc.adapterScript,
    timeoutMs: spc.timeoutMs,
    adapterFactory: spc.adapterFactory as any,
  });

  // Store cleanup: do NOT swallow errors. Callers must propagate so that
  // appliedPlanVersion and markApplied stay consistent on cleanup failure.
  function cleanupStaleSymbols(prevSnap: PlanSnapshot | null, nextSnap: PlanSnapshot): void {
    const stale = computeStaleSymbols(prevSnap, nextSnap);
    for (const sym of stale) {
      marketData.store.removeSymbol(sym);
      marketData.candleStore.removeSymbol(sym);
    }
  }

  // ── Unified apply-promise cleanup ─────────────────────────────────────────
  // Single finally handler attached to every apply pipeline. The identity
  // guard ensures an old task can never clobber a new pendingApplyPromise.
  function registerApplyCleanup(p: Promise<UniverseApplyResult>): Promise<UniverseApplyResult> {
    p.then(() => {
      if (pendingApplyPromise === p) pendingApplyPromise = null;
    }).catch(() => {
      if (pendingApplyPromise === p) pendingApplyPromise = null;
    });
    return p;
  }

  return {
    get bus() { return bus; },
    get router() { return router; },
    get marketData() { return marketData; },
    get fastPipeline() { return fastPipeline; },
    get slowPipeline() { return slowPipeline; },
    get universe() { return universe; },
    get isRunning() { return marketData.isRunning; },
    get appliedPlanVersion(): number | null { return appliedPlanVersion; },

    start(): Promise<void> {
      if (pendingStartPromise !== null) return pendingStartPromise;
      if (marketData.isRunning) return Promise.resolve();

      const startEpoch = epoch;
      pendingStartEpoch = startEpoch;

      // Capture the plan synchronously at start invocation; install as one-shot
      // override so wrappedCollectorFactory uses this exact plan.
      const planAtStart = cloneSubscriptionPlan(universe.getPlan());
      pendingCollectorPlan = planAtStart;

      const p = (async () => {
        try {
          await marketData.start();
        } catch (err) {
          if (isMyEpoch(startEpoch)) {
            pendingStartPromise = null;
            pendingStartEpoch = -1;
            // Clear the one-shot override — start failed, do not leak it
            pendingCollectorPlan = null;
          }
          throw err;
        }

        if (!isMyEpoch(startEpoch) || !marketData.isRunning) {
          if (isMyEpoch(startEpoch)) {
            pendingStartPromise = null;
            pendingStartEpoch = -1;
            pendingCollectorPlan = null;
          }
          return;
        }

        // Capture the version that the live Collector is now running under.
        appliedPlanVersion = planAtStart.version;
        appliedPlanSnapshot = snapshotPlanEntries(planAtStart);

        // Only mark applied if Universe hasn't advanced past this version
        // during the async start window.
        if (universe.getPlan().version === planAtStart.version) {
          universe.markApplied(planAtStart.version);
        }

        pendingStartPromise = null;
        pendingStartEpoch = -1;
      })();

      pendingStartPromise = p;
      return p;
    },

    stop(): void {
      epoch += 1;
      pendingStartPromise = null;
      pendingStartEpoch = -1;
      pendingApplyPromise = null;
      pendingCollectorPlan = null;
      marketData.stop();
      slowPipeline.shutdown();
    },

    applyUniversePlan(): Promise<UniverseApplyResult> {
      // Concurrent calls return the exact same Promise — early return before
      // any await ensures identity preservation.
      if (pendingApplyPromise !== null) return pendingApplyPromise;

      // Capture only the lifecycle epoch up front. The plan snapshot must be
      // deferred until after any pending start has settled, otherwise we'd
      // diff against a stale previous snapshot and miss cleanup work.
      const applyEpoch = epoch;

      const p = (async (): Promise<UniverseApplyResult> => {
        // Wait for any pending start to settle first
        if (pendingStartPromise !== null) {
          try {
            await pendingStartPromise;
          } catch {
            // start failed — fall through; we may still apply if now running
          }
          // If stop() was called during the wait, epoch will have advanced.
          // Do NOT use pendingStartEpoch here — a successful start resets it
          // to -1, which would falsely invalidate this apply.
          if (epoch !== applyEpoch) {
            return {
              applied: false,
              restarted: false,
              version: appliedPlanVersion,
              pending: universe.hasPendingPlan(),
            };
          }
        }

        // No pending plan → idempotent no-op (start already markApplied)
        if (!universe.hasPendingPlan()) {
          return {
            applied: false,
            restarted: false,
            version: appliedPlanVersion,
            pending: false,
          };
        }

        // Runtime not running — cannot create Collector. Stay pending.
        if (!marketData.isRunning) {
          return {
            applied: false,
            restarted: false,
            version: appliedPlanVersion,
            pending: true,
          };
        }

        // ── Capture previous applied snapshot and exact next plan NOW ──────
        // (after the pending start settled). Universe may keep advancing
        // during the restart window; we still use this exact snapshot for
        // Collector activation, appliedPlanVersion, and Store cleanup diff.
        const prevSnap = appliedPlanSnapshot;
        const nextPlan = cloneSubscriptionPlan(universe.getPlan());

        // Restart: stop → install override → start
        try {
          marketData.stop();
        } catch {
          throw new Error('applyUniversePlan: marketData.stop failed during restart');
        }

        // Install one-shot override so wrappedCollectorFactory uses nextPlan
        // exactly. If a concurrent start already consumed pendingCollectorPlan
        // (shouldn't happen because we waited above), guard with a check.
        pendingCollectorPlan = nextPlan;

        try {
          await marketData.start();
        } catch (err) {
          // Restart failed — leave appliedPlanVersion/appliedPlanSnapshot
          // unchanged. Universe stays pending. Reject the Promise so caller
          // can retry.
          if (isMyEpoch(applyEpoch)) {
            pendingCollectorPlan = null;
          }
          throw err;
        }

        if (!isMyEpoch(applyEpoch) || !marketData.isRunning) {
          if (isMyEpoch(applyEpoch)) {
            pendingCollectorPlan = null;
          }
          return {
            applied: false,
            restarted: false,
            version: appliedPlanVersion,
            pending: true,
          };
        }

        // Cleanup stale Store / candle data BEFORE updating applied version.
        // Do NOT swallow — propagate to caller and leave applied unchanged.
        const nextSnap = snapshotPlanEntries(nextPlan);
        cleanupStaleSymbols(prevSnap, nextSnap);

        appliedPlanVersion = nextPlan.version;
        appliedPlanSnapshot = nextSnap;

        if (universe.getPlan().version === nextPlan.version) {
          universe.markApplied(nextPlan.version);
        }

        return {
          applied: true,
          restarted: true,
          version: nextPlan.version,
          pending: universe.hasPendingPlan(),
        };
      })();

      // Register unified cleanup — handles success, failure, and any other
      // rejection path. Identity guard prevents old tasks from clearing a
      // newer pendingApplyPromise.
      pendingApplyPromise = registerApplyCleanup(p);
      return pendingApplyPromise;
    },
  };
}
