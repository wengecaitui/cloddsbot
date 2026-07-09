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
 * ⚠️ 当前为骨架（Mock）实现
 * Phase 3b: 替换为真实 Brale 技术分析
 * Phase 4: Python bridge for 精度关键指标
 */

import { EventEmitter } from 'events';
import { IndicatorService } from './IndicatorService';
import { ExecutionRouter } from '../router/ExecutionRouter';
import { MarketBiasReportFull } from '../types/market-bias';
import { evaluate as decisionEngineEvaluate } from './DecisionEngine';
import type { EngineInput } from './DecisionEngine';

export interface FastPipelineConfig {
  router: ExecutionRouter;
  /** 抽象技术指标计算服务 — FastPipeline 不关心底层实现 */
  indicatorService: IndicatorService;
  /** 快路径模型 */
  model?: string;
  /** 模拟延迟（毫秒），仅用于测试/基准；生产默认 0 */
  mockLatencyMs?: number;
}

export interface FastPipelineResult {
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
    this.config = {
      model: config.model ?? 'glm-5.2-flash',
      mockLatencyMs: config.mockLatencyMs ?? 50,
      ...config,
    };
  }

  /**
   * 执行快路径决策
   *
   * 流程：
   *  1. 读取 MarketBiasReport（路由层已注入）
   *  2. 注入技术分析（mock → Phase 3b 真实 Brale）
   *  3. Risk Team 硬限制拦截
   *  4. 返回决策
   */
  async execute(signal: {
    source: string;
    symbol: string;
    signalData?: Record<string, unknown>;
  }): Promise<FastPipelineResult> {
    const startTime = Date.now();
    const biasReport = this.config.router.getBiasReport();

    // Step 1: 检查 MarketBiasReport
    if (!biasReport) {
      return {
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
        decision: 'skip',
        symbol: signal.symbol,
        reason: `${signal.symbol} not in MarketBiasReport whitelist`,
        elapsedMs: Date.now() - startTime,
        biasReport,
      };
    }

    // Step 3: Risk Team 拦截（硬限制）
    const killSwitch = this.config.router.killSwitch;
    if (killSwitch) {
      const riskCheck = killSwitch.check(signal.symbol, 0);
      if (!riskCheck.allowed) {
        return {
          decision: 'defense',
          symbol: signal.symbol,
          reason: riskCheck.reason ?? 'KillSwitch triggered',
          elapsedMs: Date.now() - startTime,
          biasReport,
        };
      }
    }

    // Step 4: 技术指标计算（通过 IndicatorService 抽象 — 底层可以是 PythonBridge、mock 或任何实现）
    const indicatorResults = await this.config.indicatorService.calculateAll({
      asset: signal.symbol,
    });

    const bias = biasReport.assets.find(a => a.symbol === signal.symbol);

    // Step 5: Decision Engine (replaceable rules — pure function, no hidden state)
    const deInput: EngineInput = {
      symbol: signal.symbol,
      indicators: indicatorResults,
      bias: bias ? { direction: bias.direction, confidence: bias.confidence } : null,
    };
    const deResult = decisionEngineEvaluate(deInput);

    this.emit('decision_made', {
      symbol: signal.symbol,
      bias: bias?.direction ?? 'hold',
      decision: deResult.decision,
      elapsedMs: Date.now() - startTime,
    });

    return {
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
