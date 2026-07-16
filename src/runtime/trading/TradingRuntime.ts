// Stage 3A7: TradingRuntime — shared composition root
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

export interface TradingRuntimeOptions {
  collectorFactory: () => MarketDataCollectorPort;
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

export interface TradingRuntime {
  readonly bus: TradingEventBus;
  readonly router: ExecutionRouter;
  readonly marketData: MarketDataRuntime;
  readonly fastPipeline: FastPipeline;
  readonly slowPipeline: SlowPipeline;
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): void;
}

export function createTradingRuntime(options: TradingRuntimeOptions): TradingRuntime {
  if (options.router && options.routerConfig) {
    throw new Error('TradingRuntime: cannot provide both router and routerConfig');
  }

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

  const marketData: MarketDataRuntime = createMarketDataRuntime({
    collectorFactory: options.collectorFactory,
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

  return {
    get bus() { return bus; },
    get router() { return router; },
    get marketData() { return marketData; },
    get fastPipeline() { return fastPipeline; },
    get slowPipeline() { return slowPipeline; },
    get isRunning() { return marketData.isRunning; },
    start(): Promise<void> { return marketData.start(); },
    stop(): void {
      marketData.stop();
      slowPipeline.shutdown();
    },
  };
}
