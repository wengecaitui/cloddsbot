/**
 * SlowPipeline — 慢路径执行器
 *
 * 职责：执行 Research Pipeline（离线状态机）
 * - Hermes Cron 触发，调用 tradingagents_adapter
 * - 运行 TradingAgents 多 Agent 系统（Analyst + Debate + Manager + Trader）
 * - 产出 MarketBiasReport.json 写入 store
 *
 * Stage 3B4C4: exchange-bound. Config requires exchange. Adapter exchange is
 * overridden. Mismatched exchange at construction or runtime throws synchronously.
 *
 * Sprint 2B: mock 替换为真实 TradingAgents 适配器调用。
 * TradingAgents 源码完全不修改，通过适配器通信。
 */

import { EventEmitter } from 'events';
import type { ExchangeId } from '../data/MarketIdentity';
import { assertExchangeId } from '../data/MarketIdentity';
import { ExecutionRouter } from '../router/ExecutionRouter';
import { MarketBiasReportFull } from '../types/market-bias';
import { PythonBridgeDaemon } from '../router/PythonBridgeDaemon';
import type { TradingEventBus } from '../events';
import { createTradingEventBus } from '../events';
import type { Clock } from '../data/MarketSnapshot';

export interface SlowPipelineConfig {
  /** Stage 3B4C4: exchange this pipeline is bound to (required). */
  readonly exchange: ExchangeId;
  router: ExecutionRouter;
  /** 慢路径模型（传递给 TradingAgents） */
  model?: string;
  /** 适配器脚本路径（默认 quant_engine/tradingagents_adapter.py） */
  adapterScript?: string;
  /** 执行超时（毫秒，默认 120s） */
  timeoutMs?: number;
  /** Stage 3A6: 事件总线（可选注入，默认创建隔离 bus） */
  bus?: TradingEventBus;
  /** Stage 3A6: 时钟（可选注入，默认 Date.now） */
  clock?: Clock;
  /** Stage 3A6: 适配器工厂（测试用，默认创建 PythonBridgeDaemon） */
  adapterFactory?: () => PythonBridgeDaemon;
}

export class SlowPipeline extends EventEmitter {
  private config: SlowPipelineConfig;
  private running: boolean = false;
  private bridge: PythonBridgeDaemon | null = null;
  private bridgeInitPromise: Promise<void> | null = null;
  public readonly bus: TradingEventBus;
  private clock: Clock;

  constructor(config: SlowPipelineConfig) {
    super();

    // Stage 3B4C4: validate exchange at construction
    assertExchangeId('SlowPipeline', config.exchange);

    // Stage 3B4C4-R2: router must be bound to the same exchange
    if (config.router.exchange !== config.exchange) {
      throw new Error(
        `SlowPipeline: router.exchange (${config.router.exchange}) !== config.exchange (${config.exchange})`,
      );
    }

    this.config = {
      model: config.model ?? 'glm-5.2',
      adapterScript: config.adapterScript ?? 'quant_engine/tradingagents_adapter.py',
      timeoutMs: config.timeoutMs ?? 600_000,
      ...config,
    };
    this.bus = config.bus ?? createTradingEventBus();
    this.clock = config.clock ?? { now: () => Date.now() };
  }

  /** 确保适配器进程已启动（惰性初始化，支持 init 失败后重试） */
  private async ensureAdapter(): Promise<PythonBridgeDaemon> {
    if (this.bridge) return this.bridge;

    if (!this.bridgeInitPromise) {
      this.bridgeInitPromise = (async () => {
        const bridge = this.config.adapterFactory
          ? this.config.adapterFactory()
          : new PythonBridgeDaemon(this.config.adapterScript!);
        await bridge.init();
        this.bridge = bridge;
      })();
    }

    try {
      await this.bridgeInitPromise;
      return this.bridge!;
    } catch (err) {
      // Stage 3B4C6: clear init promise so next run() retries
      this.bridgeInitPromise = null;
      throw err;
    }
  }

  async run(
    exchange: ExchangeId,
    symbol: string = 'BTC/USDT',
    tradeDate?: string,
  ): Promise<MarketBiasReportFull> {
    // Stage 3B4C4: validate exchange BEFORE any I/O, adapter call, or event emit
    if (exchange !== this.config.exchange) {
      return Promise.reject(
        new Error(
          `SlowPipeline.run: exchange mismatch: got ${JSON.stringify(exchange)}, expected ${JSON.stringify(this.config.exchange)}`,
        ),
      );
    }

    if (this.running) throw new Error('SlowPipeline already running');
    this.running = true;
    const startTime = Date.now();

    try {
      this.emit('run_start', { exchange: this.config.exchange, symbol });

      // ── 1. 确保适配器进程 ──────────────────────────────────────────
      const bridge = await this.ensureAdapter();

      // ── 2. 构建 TradingAgents 请求 ──────────────────────────────────
      const payload: Record<string, unknown> = {
        exchange: this.config.exchange,  // Stage 3B4C4: adapter payload carries exchange
        asset: symbol,
        symbol,
      };
      if (tradeDate) {
        payload.timestamp = tradeDate;
      }

      // ── 3. 调用 TradingAgents（通过适配器） ────────────────────────
      const raw = await bridge.calculate(payload as any, this.config.timeoutMs!);

      // ── 4. 从原始响应中提取报告 ────────────────────────────────────
      const elapsedMs = Date.now() - startTime;

      // 适配器返回 { success, report, metrics, elapsed_ms, ... }
      if (!raw || !raw.success) {
        const errorMsg = raw?.error ?? '未知适配器错误';
        const fallbackReport = this.buildFallbackReport(symbol, errorMsg, elapsedMs);
        this.publishReport(fallbackReport, elapsedMs);
        return fallbackReport;
      }

      // Stage 3B4C4: override adapter exchange with bound exchange AFTER spread
      const report: MarketBiasReportFull = {
        ...raw.report,
        exchange: this.config.exchange,
        meta: {
          source: 'hermes_cron',
          modelVersion: this.config.model!,
          generationTimeMs: elapsedMs,
          inputSummary: `TradingAgents analysis: ${symbol}${tradeDate ? ' on ' + tradeDate : ''}`,
        },
      };

      // ── 5. 统一完成路径：持久化 + 发布事件 ────────────────────────────
      this.publishReport(report, elapsedMs);

      return report;
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const fallbackReport = this.buildFallbackReport(symbol, errorMsg, elapsedMs);

      // Fallback 报告也走统一完成路径
      this.publishReport(fallbackReport, elapsedMs);

      return fallbackReport;
    } finally {
      this.running = false;
    }
  }

  /**
   * Stage 3A6-R1 + 3B4C4: 统一报告完成路径（非阻塞持久化）
   * - router.updateBiasReport（fire-and-observe，不 await）
   * - bus.publish('research.bias.updated')
   * - emit('run_complete')
   */
  private publishReport(report: MarketBiasReportFull, elapsedMs: number): void {
    // 1. Router 持久化（fire-and-observe，不阻塞）
    const persistPromise = this.config.router.updateBiasReport(report);
    
    // 同步 throw 捕获
    if (persistPromise && typeof persistPromise.catch === 'function') {
      persistPromise.catch((err) => {
        this.emit('persistence_warning', { exchange: this.config.exchange, error: err });
      });
    }

    // 2. 发布事件（立即执行，不等待持久化）
    try {
      const receivedAt = this.clock.now();
      const result = this.bus.publish('research.bias.updated', { report, receivedAt });
      if (result.failures > 0) {
        this.emit('publish_warning', { exchange: this.config.exchange, failures: result.failures, delivered: result.delivered });
      }
    } catch (err) {
      // publish 自身抛错也不得使已生成报告失败
      this.emit('publish_warning', { exchange: this.config.exchange, error: err });
    }

    // 3. 保持原有完成事件
    this.emit('run_complete', { exchange: this.config.exchange, report, durationMs: elapsedMs });
  }

  /**
   * 当 TradingAgents 调用失败时构建降级报告。
   * Stage 3B4C4: includes exchange.
   */
  private buildFallbackReport(symbol: string, error: string, elapsedMs: number): MarketBiasReportFull {
    const now = Date.now();
    return {
      exchange: this.config.exchange,
      timestamp: now,
      updatedAt: now,
      globalBias: 'neutral',
      confidence: 0,
      assets: [{
        symbol,
        bias: 'neutral',
        confidence: 0,
        volatility: 50,
        direction: 'hold',
        suggestedPositionPct: 0,
        entryCondition: `TradingAgents error: ${error}`,
        stopLoss: '-',
        takeProfit: '-',
      }],
      globalLongShortRatio: 1.0,
      globalVolatility: 50,
      fearGreedIndex: 50,
      fundingStatus: 'neutral',
      whitelist: [symbol],
      blacklist: [],
      riskEvents: [`TradingAgents adapter failed: ${error}`],
      meta: {
        source: 'hermes_cron',
        modelVersion: this.config.model ?? 'glm-5.2',
        generationTimeMs: elapsedMs,
        inputSummary: `FALLBACK — TradingAgents unavailable: ${error}`,
      },
    };
  }
  /**
   * 关闭适配器进程（同步、幂等）。
   * Stage 3B4C6-R1: 先清空内部引用再调用 bridge.shutdown()。
   * 支持 shutdown → run(新bridge) → shutdown(再关闭) 完整生命周期。
   */
  shutdown(): void {
    const bridge = this.bridge;
    this.bridge = null;
    this.bridgeInitPromise = null;
    bridge?.shutdown();
  }
}
