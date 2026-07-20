/**
 * FastPipeline — 快路径执行器
 *
 * 职责：执行 Execution Pipeline（秒级突击队）
 * - Spread-Scanner 信号触发，调用 providers.fastProvider
 * - 读取 MarketBiasReport + 技术分析 + 账户状态
 * - Risk Team 拦截 → 出决策
 *
 * 目标延迟：< 2 秒
 *
 * Stage 3B4C4: exchange-bound. Config requires exchange. Signal exchange validated
 * at method start. All fail-closed paths return decision='skip' with config.exchange.
 *
 * ⚠️ 当前为骨架（Mock）实现
 * Phase 3b: 替换为真实 Brale 技术分析
 * Phase 4: Python bridge for 精度关键指标
 *
 * Stage 3A4: 可选 marketData 注入 —— 在 IndicatorService 之前
 *   校验 Snapshot + CandleSeries 同步性，并把历史 OHLCV 喂给指标计算。
 *   未配置 marketData → 完全兼容旧行为。
 */

import { EventEmitter } from 'events';
import type { ExchangeId } from '../data/MarketIdentity';
import { assertExchangeId, isExchangeId } from '../data/MarketIdentity';
import { IndicatorService } from './IndicatorService';
import { ExecutionRouter } from '../router/ExecutionRouter';
import { MarketBiasReportFull } from '../types/market-bias';
import { evaluate as decisionEngineEvaluate } from './DecisionEngine';
import type { EngineInput } from './DecisionEngine';
import type { MarketSnapshotStore } from '../data/MarketSnapshot';
import type { CandleSeriesStore } from '../data/CandleSeriesStore';
import type { Series } from '../data/types';

export interface FastPipelineMarketData {
  /** Stage 3B4C2: exchange this pipeline is bound to (no fallback to other exchanges). */
  readonly exchange: ExchangeId;
  readonly snapshotStore: MarketSnapshotStore;
  readonly candleStore: CandleSeriesStore;
  /** 目标 K 线周期（默认 1m） */
  interval?: string;
  /** warm-up 最低 K 线数（默认 100） */
  minimumSeries?: number;
  /** 送计算的 K 线数上限（默认 200，必须 >= minimumSeries） */
  seriesLimit?: number;
  /** 单根 K 线最大年龄（默认 120000ms = 2min） */
  maxKlineAgeMs?: number;
}

export interface FastPipelineConfig {
  /** Stage 3B4C4: exchange this pipeline is bound to (required, authoritative). */
  readonly exchange: ExchangeId;
  router: ExecutionRouter;
  /** 抽象技术指标计算服务 — FastPipeline 不关心底层实现 */
  indicatorService: IndicatorService;
  /** 快路径模型 */
  model?: string;
  /** 模拟延迟（毫秒），仅用于测试/基准；生产默认 0 */
  mockLatencyMs?: number;
  /** Stage 3A4: 可选市场数据源（Snapshot + CandleSeries） */
  marketData?: FastPipelineMarketData;
}

export interface FastPipelineResult {
  /** Stage 3B4C4: exchange this result belongs to (always config.exchange). */
  readonly exchange: ExchangeId;
  /** 决策：交易或放弃 */
  decision: 'trade' | 'skip' | 'defense';
  /** 交易方向（如有） */
  direction?: 'long' | 'short' | 'hold';
  /** 交易符号 */
  symbol?: string;
  /** 仓位（USD） */
  positionUsd?: number;
  /** 决策原因 */
  reason: string;
  /** 执行耗时 */
  elapsedMs: number;
  /** MarketBiasReport 快照 */
  biasReport: MarketBiasReportFull | null;
}

export class FastPipeline extends EventEmitter {
  private config: FastPipelineConfig;

  constructor(config: FastPipelineConfig) {
    super();

    // Stage 3B4C4: validate exchange at construction
    assertExchangeId('FastPipeline', config.exchange);

    // Stage 3B4C4-R2: router must be bound to the same exchange
    if (config.router.exchange !== config.exchange) {
      throw new Error(
        `FastPipeline: router.exchange (${config.router.exchange}) !== config.exchange (${config.exchange})`,
      );
    }

    // Stage 3A5: validate marketData config at construction time
    if (config.marketData) {
      const md = config.marketData;
      // Stage 3B4C2: exchange must be a valid ExchangeId — fail fast at construction.
      if (!isExchangeId(md.exchange)) {
        throw new Error(`FastPipeline: marketData.exchange must be a valid ExchangeId, got ${JSON.stringify(md.exchange)}`);
      }
      // Stage 3B4C4-R2: marketData.exchange must match config.exchange
      if (md.exchange !== config.exchange) {
        throw new Error(
          `FastPipeline: marketData.exchange (${md.exchange}) !== config.exchange (${config.exchange})`,
        );
      }
      if (!md.interval || typeof md.interval !== 'string') {
        throw new Error('FastPipeline: marketData.interval must be a non-empty string');
      }
      if (md.minimumSeries !== undefined) {
        if (!Number.isInteger(md.minimumSeries) || md.minimumSeries <= 0) {
          throw new Error(`FastPipeline: marketData.minimumSeries must be a positive integer, got ${md.minimumSeries}`);
        }
      }
      if (md.seriesLimit !== undefined) {
        if (!Number.isInteger(md.seriesLimit) || md.seriesLimit <= 0) {
          throw new Error(`FastPipeline: marketData.seriesLimit must be a positive integer, got ${md.seriesLimit}`);
        }
        const min = md.minimumSeries ?? 100;
        if (md.seriesLimit < min) {
          throw new Error(`FastPipeline: marketData.seriesLimit (${md.seriesLimit}) < marketData.minimumSeries (${min})`);
        }
      }
      if (md.maxKlineAgeMs !== undefined) {
        if (typeof md.maxKlineAgeMs !== 'number' || !Number.isFinite(md.maxKlineAgeMs) || md.maxKlineAgeMs <= 0) {
          throw new Error(`FastPipeline: marketData.maxKlineAgeMs must be a finite positive number, got ${md.maxKlineAgeMs}`);
        }
      }
    }
    this.config = {
      model: config.model ?? 'glm-5.2-flash',
      mockLatencyMs: config.mockLatencyMs ?? 50,
      ...config,
    };
  }

  /**
   * 执行快路径决策
   *
   * Stage 3B4C4: validates signal.exchange === config.exchange at method start.
   * On mismatch, returns decision='skip' immediately — fail closed.
   */
  async execute(signal: {
    exchange: ExchangeId;
    source: string;
    symbol: string;
    signalData?: Record<string, unknown>;
  }): Promise<FastPipelineResult> {
    const startTime = Date.now();

    // Stage 3B4C4: validate signal exchange BEFORE any I/O, router reads, or events
    if (signal.exchange !== this.config.exchange) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: `exchange mismatch: signal has ${signal.exchange}, pipeline bound to ${this.config.exchange}`,
        elapsedMs: Date.now() - startTime,
        biasReport: null,
      };
    }

    const biasReport = this.config.router.getBiasReport();

    // Stage 3B4C4: defensive check — even if router returns a report, verify exchange
    if (biasReport && !isExchangeId((biasReport as { exchange?: unknown }).exchange)) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: 'Invalid report.exchange — fail closed',
        elapsedMs: Date.now() - startTime,
        biasReport: null,
      };
    }
    if (biasReport && (biasReport as { exchange: ExchangeId }).exchange !== this.config.exchange) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: `report.exchange mismatch: got ${(biasReport as { exchange: ExchangeId }).exchange}, expected ${this.config.exchange}`,
        elapsedMs: Date.now() - startTime,
        biasReport: null,
      };
    }

    // Step 1: 检查 MarketBiasReport
    if (!biasReport) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        reason: 'No MarketBiasReport available — wait for SlowPath to complete',
        elapsedMs: Date.now() - startTime,
        biasReport: null,
      };
    }

    // Step 1b: 僵尸报告检测（防止 SlowPipeline 挂掉后快路径盲目交易）
    const reportAgeMs = Date.now() - biasReport.updatedAt;
    const maxAgeMs = this.config.router.getConfig().maxBiasReportAgeHours * 60 * 60 * 1000;
    if (reportAgeMs > maxAgeMs) {
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        symbol: signal.symbol,
        reason: `Stale MarketBiasReport: ${Math.round(reportAgeMs / 3600000)}h > ${this.config.router.getConfig().maxBiasReportAgeHours}h — KillSwitch activated`,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }

    // Step 2: 检查白名单
    if (!biasReport.whitelist.includes(signal.symbol)) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        symbol: signal.symbol,
        reason: `${signal.symbol} not in MarketBiasReport whitelist`,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }

    // Step 3: Risk Team 拦截（硬限制）— Stage 3B4C4: pass exchange
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const riskCheck = killSwitch.check(this.config.exchange, signal.symbol, 0);
      if (!riskCheck.allowed) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: riskCheck.reason ?? 'KillSwitch triggered',
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }
    }

    // Step 4: [Stage 3A4] 市场数据守卫 + OHLCV 序列注入
    const md = this.config.marketData;
    let series: Series[] | null = null;

    if (md) {
      const interval = md.interval ?? '1m';
      const minimumSeries = md.minimumSeries ?? 100;
      const seriesLimit = md.seriesLimit ?? 200;
      const maxKlineAgeMs = md.maxKlineAgeMs ?? 120_000;
      const exchange = md.exchange;
      const symKey = `${exchange}:${signal.symbol}`;

      // 4a. Snapshot 必须存在 (exchange-isolated, no fallback)
      const snapshot = md.snapshotStore.getSnapshot(exchange, signal.symbol);
      if (!snapshot) {
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] no snapshot for ${symKey} — wait for market data`,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }

      // 4b. Snapshot 整体陈旧
      if (snapshot.isStale) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: `[MD] snapshot stale (${snapshot.ageMs}ms) for ${symKey}`,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }

      // 4c. 目标周期 K 线缺失
      const targetKline = snapshot.klines[interval];
      if (!targetKline) {
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] snapshot missing ${interval} kline for ${symKey}`,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }

      // 4d. 目标周期 K 线自身陈旧
      const klineAgeMs = snapshot.generatedAt - targetKline.receivedAt;
      if (klineAgeMs > maxKlineAgeMs) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: `[MD] ${interval} kline stale (${klineAgeMs}ms > ${maxKlineAgeMs}ms) for ${symKey}`,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }

      // 4e. CandleSeries warm-up 不足 (exchange-isolated, no fallback)
      if (!md.candleStore.hasMinimumSeries(exchange, signal.symbol, interval, minimumSeries)) {
        const available = md.candleStore.getSeries(exchange, signal.symbol, interval, seriesLimit).length;
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] insufficient candle history for ${symKey} ${interval}: ${available}/${minimumSeries}`,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }

      // 4f. 读取旧→新序列 (exchange-isolated)
      const pulled = md.candleStore.getSeries(exchange, signal.symbol, interval, seriesLimit);
      series = pulled;

      // 4g. Snapshot 与 CandleSeries 不同步（最后一根 ts 必须一致）
      const lastTs = pulled[pulled.length - 1]?.ts;
      if (typeof lastTs !== 'number' || lastTs !== targetKline.kline.ts) {
        return {
          exchange: this.config.exchange,
          decision: 'skip',
          symbol: signal.symbol,
          reason: `[MD] snapshot/candle desync for ${symKey} ${interval}: snapshotTs=${targetKline.kline.ts} candleTs=${lastTs ?? 'none'}`,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }

      // 4h. 调用指标服务（带 OHLCV 序列）
      const indicatorResults = await this.config.indicatorService.calculateAll({
        asset: signal.symbol,
        series,
      });

      return this.decide(signal, biasReport, indicatorResults, startTime);
    }

    // Step 4 (legacy / 无 marketData): 不传 series
    const indicatorResults = await this.config.indicatorService.calculateAll({
      asset: signal.symbol,
    });

    return this.decide(signal, biasReport, indicatorResults, startTime);
  }

  /**
   * Decision Engine 封装 —— 纯函数调用，语义不变。
   */
  private decide(
    signal: { exchange: ExchangeId; source: string; symbol: string; signalData?: Record<string, unknown> },
    biasReport: MarketBiasReportFull,
    indicatorResults: import('../types/indicators').IndicatorResult[],
    startTime: number,
  ): FastPipelineResult {
    const bias = biasReport.assets.find(a => a.symbol === signal.symbol);

    // Step 5: Decision Engine (replaceable rules — pure function, no hidden state)
    const deInput: EngineInput = {
      symbol: signal.symbol,
      indicators: indicatorResults,
      bias: bias ? { direction: bias.direction, confidence: bias.confidence } : null,
    };
    const deResult = decisionEngineEvaluate(deInput);

    this.emit('decision_made', {
      exchange: this.config.exchange,
      symbol: signal.symbol,
      bias: bias?.direction ?? 'hold',
      decision: deResult.decision,
      elapsedMs: Date.now() - startTime,
    });

    return {
      exchange: this.config.exchange,
      decision: deResult.decision,
      direction: deResult.direction,
      symbol: signal.symbol,
      reason: deResult.reason,
      elapsedMs: Date.now() - startTime,
      biasReport,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
