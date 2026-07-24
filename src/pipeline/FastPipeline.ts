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
import type { ExecutionQuote } from '../types/execution-quote';
import { computePositionUsd } from './PositionSizer';
import type { TradeIntent } from '../types/trade-intent';
import { createTradeIntent } from '../types/trade-intent';
import { validateTradeCandidate } from './TradeIntentValidation';

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
  tradeIntent?: TradeIntent;
  /** Stage 3B4C14: execution quote from same-snapshot ticker (trade only). */
  executionQuote?: ExecutionQuote;
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

    // Stage 3B4C7-R1: explicit lock check BEFORE market data & indicator work.
    // Uses getLockState() — a read-only query that does NOT involve positionUsd.
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const lockState = killSwitch.getLockState(this.config.exchange);
      if (lockState.locked) {
        return {
          exchange: this.config.exchange,
          decision: 'defense',
          symbol: signal.symbol,
          reason: lockState.reason ?? 'KillSwitch locked',
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

      // ─── Stage 3B4C14: capture execution quote from same snapshot ───
      const tickerWrapper = snapshot.ticker;
      let executionQuote: ExecutionQuote | undefined;
      if (tickerWrapper && typeof tickerWrapper.ticker.last === 'number' && Number.isFinite(tickerWrapper.ticker.last) && tickerWrapper.ticker.last > 0 &&
          typeof tickerWrapper.ticker.ts === 'number' && Number.isFinite(tickerWrapper.ticker.ts) && tickerWrapper.ticker.ts >= 0) {
        executionQuote = {
          exchange: snapshot.exchange,
          symbol: snapshot.symbol,
          markPriceUsd: tickerWrapper.ticker.last,
          executedAtMs: tickerWrapper.ticker.ts,
          snapshotVersion: snapshot.snapshotVersion,
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

      return this.decide(signal, biasReport, indicatorResults, startTime, executionQuote);
    }

    const indicatorResults = await this.config.indicatorService.calculateAll({
      asset: signal.symbol,
    });

    return this.decide(signal, biasReport, indicatorResults, startTime, undefined);
  }

  /**
   * Decision Engine + position sizing + risk admission chain.
   *
   * Stage 3B4C7-R1: unified rejection helper, runtime direction validation,
   * bias.direction === deResult.direction gate, PositionSizer symbol+direction.
   * Stage 3B4C14: executionQuote attached to trade results only.
   */
  private decide(
    signal: { exchange: ExchangeId; source: string; symbol: string; signalData?: Record<string, unknown> },
    biasReport: MarketBiasReportFull,
    indicatorResults: import('../types/indicators').IndicatorResult[],
    startTime: number,
    executionQuote?: ExecutionQuote,
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

    // Not a trade decision — return immediately, no position, no TradeIntent.
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

    // ─── Stage 3B4C7-R1: unified rejection helper ───
    const emitRejected = (
      stage: 'direction_validation' | 'bias_validation' | 'position_sizing' | 'risk_admission' | 'intent_creation',
      reason: string,
      requestedPositionUsd?: number,
    ) => {
      this.emit('trade_intent_rejected', {
        exchange: this.config.exchange,
        symbol: signal.symbol,
        stage,
        reason,
        ...(requestedPositionUsd !== undefined ? { requestedPositionUsd } : {}),
      });
    };

    // ─── Stage 3B4C7-R2: candidate validation via pure function ───
    const candidate = validateTradeCandidate({
      engineDecision: deResult.decision,
      engineDirection: deResult.direction,
      biasDirection: bias?.direction,
      symbol: signal.symbol,
    });
    if (!candidate.ok) {
      emitRejected(candidate.stage, candidate.reason);
      return {
        exchange: this.config.exchange,
        decision: 'defense',
        direction: 'hold',
        symbol: signal.symbol,
        reason: candidate.reason,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }
    const dir: 'long' | 'short' = candidate.direction;
    // validateTradeCandidate guarantees bias exists and direction matches
    const asset = bias!;

    // Validate suggestedPositionPct
    const suggestedPct = asset.suggestedPositionPct;
    if (typeof suggestedPct !== 'number' || !Number.isFinite(suggestedPct) || suggestedPct <= 0 || suggestedPct > 1) {
      const reason = `[SIZER] ${signal.symbol}: invalid suggestedPositionPct=${suggestedPct}`;
      emitRejected('position_sizing', reason);
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

    // ─── Position sizing ───
    let requestedPositionUsd: number;
    try {
      const ksConfig = this.config.router.killSwitch?.getConfig() ?? { totalCapitalUsd: 0 };
      requestedPositionUsd = computePositionUsd({
        totalCapitalUsd: ksConfig.totalCapitalUsd,
        suggestedPositionPct: suggestedPct,
        symbol: signal.symbol,
        direction: dir,
      });
    } catch (err) {
      const reason = `[SIZER] ${signal.symbol}: position sizing error: ${err}`;
      emitRejected('position_sizing', reason);
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

    // ─── Risk admission ───
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const riskCheck = killSwitch.check(this.config.exchange, signal.symbol, requestedPositionUsd);
      if (!riskCheck.allowed) {
        const reason = `[RISK] ${riskCheck.reason ?? `${signal.symbol} rejected at $${requestedPositionUsd.toFixed(0)}`}`;
        emitRejected('risk_admission', riskCheck.reason ?? reason, requestedPositionUsd);
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

    // ─── Intent creation ───
    let tradeIntent: TradeIntent;
    try {
      tradeIntent = createTradeIntent({
        exchange: this.config.exchange,
        symbol: signal.symbol,
        direction: dir,
        positionUsd: requestedPositionUsd,
        source: signal.source,
        reason: deResult.reason,
        biasUpdatedAt: biasReport.updatedAt,
      });
    } catch (err) {
      const reason = `[INTENT] ${signal.symbol}: createTradeIntent error: ${err}`;
      emitRejected('intent_creation', reason, requestedPositionUsd);
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

    this.emit('trade_intent_created', {
      exchange: this.config.exchange,
      symbol: signal.symbol,
      tradeIntent,
    });

    return {
      exchange: this.config.exchange,
      decision: 'trade',
      direction: dir,
      symbol: signal.symbol,
      positionUsd: requestedPositionUsd,
      tradeIntent,
      executionQuote,
      reason: deResult.reason,
      elapsedMs: Date.now() - startTime,
      biasReport,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
