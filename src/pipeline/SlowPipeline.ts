/**
 * SlowPipeline — 慢路径执行器
 *
 * 职责：执行 Research Pipeline（离线状态机）
 * - Hermes Cron 触发，调用 tradingagents_adapter
 * - 运行 TradingAgents 多 Agent 系统（Analyst + Debate + Manager + Trader）
 * - 产出 MarketBiasReport.json 写入 store
 *
 * Sprint 2B: mock 替换为真实 TradingAgents 适配器调用。
 * TradingAgents 源码完全不修改，通过适配器通信。
 */

import { EventEmitter } from 'events';
import { ExecutionRouter } from '../router/ExecutionRouter';
import { MarketBiasReportFull } from '../types/market-bias';
import { PythonBridgeDaemon } from '../router/PythonBridgeDaemon';
import type { TradingEventBus } from '../events';
import { createTradingEventBus } from '../events';
import type { Clock } from '../data/MarketSnapshot';

export interface SlowPipelineConfig {
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
    this.config = {
      model: config.model ?? 'glm-5.2',
      adapterScript: config.adapterScript ?? 'quant_engine/tradingagents_adapter.py',
      timeoutMs: config.timeoutMs ?? 600_000,
      ...config,
    };
    this.bus = config.bus ?? createTradingEventBus();
    this.clock = config.clock ?? { now: () => Date.now() };
  }

  /**
   * 确保适配器进程已启动（惰性初始化，仅一次）
   */
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

    await this.bridgeInitPromise;
    return this.bridge!;
  }

  async run(symbol: string = 'BTC/USDT', tradeDate?: string): Promise<MarketBiasReportFull> {
    if (this.running) throw new Error('SlowPipeline already running');
    this.running = true;
    const startTime = Date.now();

    try {
      this.emit('run_start');

      // ── 1. 确保适配器进程 ──────────────────────────────────────────
      const bridge = await this.ensureAdapter();

      // ── 2. 构建 TradingAgents 请求 ──────────────────────────────────
      const payload: Record<string, unknown> = {
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
        await this.publishReport(fallbackReport, elapsedMs);
        return fallbackReport;
      }

      const report: MarketBiasReportFull = {
        ...raw.report,
        meta: {
          source: 'hermes_cron',
          modelVersion: this.config.model!,
          generationTimeMs: elapsedMs,
          inputSummary: `TradingAgents analysis: ${symbol}${tradeDate ? ' on ' + tradeDate : ''}`,
        },
      };

      // ── 5. 统一完成路径：持久化 + 发布事件 ────────────────────────────
      await this.publishReport(report, elapsedMs);

      return report;
    } catch (error: unknown) {
      const elapsedMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      const fallbackReport = this.buildFallbackReport(symbol, errorMsg, elapsedMs);

      // Fallback 报告也走统一完成路径
      await this.publishReport(fallbackReport, elapsedMs);

      return fallbackReport;
    } finally {
      this.running = false;
    }
  }

  /**
   * Stage 3A6: 统一报告完成路径
   * - router.updateBiasReport（持久化，非阻塞）
   * - bus.publish('research.bias.updated')
   * - emit('run_complete')
   */
  private async publishReport(report: MarketBiasReportFull, elapsedMs: number): Promise<void> {
    // 1. Router 持久化（保持现有非阻塞语义）
    try {
      await this.config.router.updateBiasReport(report);
    } catch (err) {
      this.emit('persistence_warning', { error: err });
    }

    // 2. 发布事件
    try {
      const receivedAt = this.clock.now();
      const result = this.bus.publish('research.bias.updated', { report, receivedAt });
      if (result.failures > 0) {
        this.emit('publish_warning', { failures: result.failures, delivered: result.delivered });
      }
    } catch (err) {
      // publish 自身抛错也不得使已生成报告失败
      this.emit('publish_warning', { error: err });
    }

    // 3. 保持原有完成事件
    this.emit('run_complete', { report, durationMs: elapsedMs });
  }

  /**
   * 当 TradingAgents 调用失败时构建降级报告。
   */
  private buildFallbackReport(symbol: string, error: string, elapsedMs: number): MarketBiasReportFull {
    const now = Date.now();
    return {
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
   * 关闭适配器进程。
   */
  shutdown(): void {
    this.bridge?.shutdown();
    this.bridge = null;
    this.bridgeInitPromise = null;
  }
}
