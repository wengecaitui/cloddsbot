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
 * Stage 3A4: 可选 marketData 注入 —— 在 IndicatorService 之前
 *
 * Stage 3B4C7: risk chain upgraded from `killSwitch.check(symbol, 0)` to
 *   DecisionEngine → PositionSizer → KillSwitch.check(realPositionUsd) → TradeIntent.
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
import { computePositionUsd } from './PositionSizer';
import type { TradeIntent } from '../types/trade-intent';
import { createTradeIntent } from '../types/trade-intent';

export interface FastPipelineMarketData {
  readonly exchange: ExchangeId;
  readonly snapshotStore: MarketSnapshotStore;
  readonly candleStore: CandleSeriesStore;
  interval?: string;
  minimumSeries?: number;
  seriesLimit?: number;
  maxKlineAgeMs?: number;
}

export interface FastPipelineConfig {
  readonly exchange: ExchangeId;
  router: ExecutionRouter;
  indicatorService: IndicatorService;
  model?: string;
  mockLatencyMs?: number;
  marketData?: FastPipelineMarketData;
}

export interface FastPipelineResult {
  readonly exchange: ExchangeId;
  decision: 'trade' | 'skip' | 'defense';
  direction?: 'long' | 'short' | 'hold';
  symbol?: string;
  positionUsd?: number;
  /** Stage 3B4C7: risk-admitted trade intent (only present when decision='trade'). */
  tradeIntent?: TradeIntent;
  reason: string;
  elapsedMs: number;
  biasReport: MarketBiasReportFull | null;
}

export class FastPipeline extends EventEmitter {
  private config: FastPipelineConfig;

  constructor(config: FastPipelineConfig) {
    super();

    assertExchangeId('FastPipeline', config.exchange);

    if (config.router.exchange !== config.exchange) {
      throw new Error(
        `FastPipeline: router.exchange (${config.router.exchange}) !== config.exchange (${config.exchange})`,
      );
    }

    if (config.marketData) {
      const md = config.marketData;
      if (!isExchangeId(md.exchange)) {
        throw new Error(`FastPipeline: marketData.exchange must be a valid ExchangeId, got ${JSON.stringify(md.exchange)}`);
      }
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

  async execute(signal: {
    exchange: ExchangeId;
    source: string;
    symbol: string;
    signalData?: Record<string, unknown>;
  }): Promise<FastPipelineResult> {
    const startTime = Date.now();

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

    if (!biasReport) {
      return {
        exchange: this.config.exchange,
        decision: 'skip',
        reason: 'No MarketBiasReport available — wait for SlowPath to complete',
        elapsedMs: Date.now() - startTime,
        biasReport: null,
      };
    }

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

    // Stage 3B4C7: KillSwitch.isLocked check BEFORE market data & indicator work.
    // If the switch is explicitly locked, stop here — zero I/O on further paths.
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const lockCheck = killSwitch.check(this.config.exchange, signal.symbol, 1); // 1 = placeholder to trigger lock gate
      if (!lockCheck.allowed) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: lockCheck.reason ?? 'KillSwitch triggered',
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }
    }

    // Step 4: 市场数据守卫 + OHLCV 序列注入
    const md = this.config.marketData;
    let series: Series[] | null = null;

    if (md) {
      const interval = md.interval ?? '1m';
      const minimumSeries = md.minimumSeries ?? 100;
      const seriesLimit = md.seriesLimit ?? 200;
      const maxKlineAgeMs = md.maxKlineAgeMs ?? 120_000;
      const exchange = md.exchange;
      const symKey = `${exchange}:${signal.symbol}`;

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

      const pulled = md.candleStore.getSeries(exchange, signal.symbol, interval, seriesLimit);
      series = pulled;

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

      const indicatorResults = await this.config.indicatorService.calculateAll({
        asset: signal.symbol,
        series,
      });

      return this.decide(signal, biasReport, indicatorResults, startTime);
    }

    const indicatorResults = await this.config.indicatorService.calculateAll({
      asset: signal.symbol,
    });

    return this.decide(signal, biasReport, indicatorResults, startTime);
  }

  /**
   * Decision Engine + position sizing + risk admission chain.
   *
   * Stage 3B4C7: after DecisionEngine returns 'trade', the fast path now:
   *   1. Extracts suggestedPositionPct from bias asset
   *   2. Computes requestedPositionUsd via PositionSizer
   *   3. Calls KillSwitch.check(exchange, symbol, requestedPositionUsd)
   *   4. If risk-rejected → returns defense, emits trade_intent_rejected
   *   5. If risk-allowed → creates TradeIntent, emits trade_intent_created
   */
  private decide(
    signal: { exchange: ExchangeId; source: string; symbol: string; signalData?: Record<string, unknown> },
    biasReport: MarketBiasReportFull,
    indicatorResults: import('../types/indicators').IndicatorResult[],
    startTime: number,
  ): FastPipelineResult {
    const bias = biasReport.assets.find(a => a.symbol === signal.symbol);

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

    // Stage 3B4C7: if decision is not 'trade', return immediately — no position, no TradeIntent.
    if (deResult.decision !== 'trade') {
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

    // ─── Stage 3B4C7: Trade decision — position sizing + risk check ───

    // Validate bias asset exists for this symbol
    if (!bias) {
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        symbol: signal.symbol,
        reason: `[SIZER] ${signal.symbol}: no bias asset — fail closed`,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }

    // Validate suggestedPositionPct
    const suggestedPct = bias.suggestedPositionPct;
    if (typeof suggestedPct !== 'number' || !Number.isFinite(suggestedPct) || suggestedPct <= 0 || suggestedPct > 1) {
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        symbol: signal.symbol,
        reason: `[SIZER] ${signal.symbol}: invalid suggestedPositionPct=${suggestedPct} — fail closed`,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }

    let requestedPositionUsd: number;
    try {
      const ksConfig = this.config.router.killSwitch?.getConfig() ?? { totalCapitalUsd: 0 };
      requestedPositionUsd = computePositionUsd({
        totalCapitalUsd: ksConfig.totalCapitalUsd,
        suggestedPositionPct: suggestedPct,
      });
    } catch (err) {
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        symbol: signal.symbol,
        reason: `[SIZER] ${signal.symbol}: position sizing error: ${err}`,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }

    // Run KillSwitch risk admission with real USD amount
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const riskCheck = killSwitch.check(this.config.exchange, signal.symbol, requestedPositionUsd);
      if (!riskCheck.allowed) {
        const reason = `[RISK] ${riskCheck.reason ?? `KillSwitch rejected ${signal.symbol} at $${requestedPositionUsd.toFixed(0)}`}`;
        this.emit('trade_intent_rejected', {
          exchange: this.config.exchange,
          symbol: signal.symbol,
          requestedPositionUsd,
          reason: riskCheck.reason,
        });
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          direction: 'hold',
          symbol: signal.symbol,
          reason,
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }
    }

    // Risk admitted — create TradeIntent
    const tradeIntent = createTradeIntent({
      exchange: this.config.exchange,
      symbol: signal.symbol,
      direction: deResult.direction as 'long' | 'short',
      positionUsd: requestedPositionUsd,
      source: signal.source,
      reason: deResult.reason,
      biasUpdatedAt: biasReport.updatedAt,
    });

    this.emit('trade_intent_created', {
      exchange: this.config.exchange,
      symbol: signal.symbol,
      tradeIntent,
    });

    return {
      exchange: this.config.exchange,
      decision: 'trade',
      direction: deResult.direction,
      symbol: signal.symbol,
      positionUsd: requestedPositionUsd,
      tradeIntent,
      reason: deResult.reason,
      elapsedMs: Date.now() - startTime,
      biasReport,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
