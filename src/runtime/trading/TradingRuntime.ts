// Stage 3B1B: TradingRuntime — universe-aware composition root
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
  if (!prev) {
    // First application — no cleanup needed (Store starts empty)
    return stale;
  }
  // Same version → no diff
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

  // ── Lifecycle epoch ────────────────────────────────────────────────────
  // Every stop() bumps epoch; pending start/apply check epoch before
  // committing side effects (markApplied, appliedPlanVersion, Store cleanup).
  let epoch = 0;
  let pendingStartPromise: Promise<void> | null = null;
  let pendingStartEpoch = -1;  // epoch captured when start() was initiated
  let pendingApplyPromise: Promise<UniverseApplyResult> | null = null;
  let appliedPlanVersion: number | null = null;
  let appliedPlanSnapshot: PlanSnapshot | null = null;

  // Wrapped collector factory: snapshot current plan, build raw collector,
  // wrap with PlanAwareCollector. UniverseManager.getPlan returns defensive
  // copies — we re-snapshot to internal immutable form for diffing.
  function wrappedCollectorFactory(): MarketDataCollectorPort {
    const plan = universe.getPlan();
    const raw = options.collectorFactory(plan);
    return createPlanAwareCollector(raw, plan);
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

  function isMyEpoch(e: number): boolean {
    return e === epoch;
  }

  function cleanupStaleSymbols(prevSnap: PlanSnapshot | null, nextSnap: PlanSnapshot): void {
    const stale = computeStaleSymbols(prevSnap, nextSnap);
    for (const sym of stale) {
      try { marketData.store.removeSymbol(sym); } catch { /* synchronous API — ignore */ }
      try { marketData.candleStore.removeSymbol(sym); } catch { /* ignore */ }
    }
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
      // If a pending start exists, return the same Promise
      if (pendingStartPromise !== null) return pendingStartPromise;
      // If running and no pending start, idempotent no-op
      if (marketData.isRunning) return Promise.resolve();

      const startEpoch = epoch;
      pendingStartEpoch = startEpoch;
      const planAtStart = universe.getPlan();

      const p = (async () => {
        try {
          await marketData.start();
        } catch (err) {
          // start rejected: bump epoch-aware check, do not mark applied
          if (isMyEpoch(startEpoch)) {
            pendingStartPromise = null;
            pendingStartEpoch = -1;
          }
          throw err;
        }

        // Successful start — verify epoch still matches
        if (!isMyEpoch(startEpoch) || !marketData.isRunning) {
          // Stopped during start — do not commit side effects
          if (isMyEpoch(startEpoch)) {
            pendingStartPromise = null;
            pendingStartEpoch = -1;
          }
          return;
        }

        appliedPlanVersion = planAtStart.version;
        appliedPlanSnapshot = snapshotPlanEntries(planAtStart);

        // Mark applied only if Universe hasn't advanced past this version
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
      marketData.stop();
      slowPipeline.shutdown();
    },

    applyUniversePlan(): Promise<UniverseApplyResult> {
      // Concurrent calls share the same Promise — capture before any await
      if (pendingApplyPromise !== null) return pendingApplyPromise;

      // Build the apply pipeline immediately so concurrent callers share it
      const applyEpoch = epoch;
      const prevSnap = appliedPlanSnapshot;
      const nextPlan = universe.getPlan();

      const p = (async () => {
        // If a start is pending, wait for it to settle first
        if (pendingStartPromise !== null) {
          const startEpochAtCall = pendingStartEpoch;
          try {
            await pendingStartPromise;
          } catch {
            // start failed — fall through
          }
          // If start was invalidated by stop, return current state
          if (epoch !== startEpochAtCall && pendingStartEpoch !== startEpochAtCall) {
            return {
              applied: false,
              restarted: false,
              version: appliedPlanVersion,
              pending: universe.hasPendingPlan(),
            };
          }
        }

        // No pending plan → no-op
        if (!universe.hasPendingPlan()) {
          return {
            applied: false,
            restarted: false,
            version: appliedPlanVersion,
            pending: false,
          };
        }

        // Runtime not running — do not create Collector, do not mark applied
        if (!marketData.isRunning) {
          return {
            applied: false,
            restarted: false,
            version: appliedPlanVersion,
            pending: true,
          };
        }

        // Restart: stop → start
        try {
          marketData.stop();
        } catch {
          throw new Error('applyUniversePlan: marketData.stop failed during restart');
        }

        try {
          await marketData.start();
        } catch (err) {
          if (isMyEpoch(applyEpoch)) {
            pendingApplyPromise = null;
          }
          throw err;
        }

        if (!isMyEpoch(applyEpoch) || !marketData.isRunning) {
          if (isMyEpoch(applyEpoch)) {
            pendingApplyPromise = null;
          }
          return {
            applied: false,
            restarted: false,
            version: appliedPlanVersion,
            pending: true,
          };
        }

        const nextSnap = snapshotPlanEntries(nextPlan);
        cleanupStaleSymbols(prevSnap, nextSnap);

        appliedPlanVersion = nextPlan.version;
        appliedPlanSnapshot = nextSnap;

        if (universe.getPlan().version === nextPlan.version) {
          universe.markApplied(nextPlan.version);
        }

        pendingApplyPromise = null;
        return {
          applied: true,
          restarted: true,
          version: nextPlan.version,
          pending: universe.hasPendingPlan(),
        };
      })();

      pendingApplyPromise = p;
      return p;
    },
  };
}
