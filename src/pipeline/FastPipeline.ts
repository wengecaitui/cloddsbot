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
import { providers } from '../providers';
import { ExecutionRouter } from '../router/ExecutionRouter';
import { MarketBiasReportFull } from '../types/market-bias';

export interface FastPipelineConfig {
  router: ExecutionRouter;
  /** 快路径模型 */
  model?: string;
  /** 模拟延迟（毫秒，默认 50ms，Phase 3b 改为真实调用） */
  mockLatencyMs?: number;
}

export interface FastPipelineResult {
  /** 决策：交易或放弃 */
  decision: 'trade' | 'skip' | 'defense';
  /** 交易方向（如有） */
  direction?: 'long' | 'short';
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
    const killSwitch = (this.config.router as any).config?.killSwitch;
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

    // Step 4: Mock 决策（Phase 3b → 真实 AI 推理 + Brale 指标）
    await this.delay(this.config.mockLatencyMs);

    const bias = biasReport.assets.find(a => a.symbol === signal.symbol);
    this.emit('decision_made', {
      symbol: signal.symbol,
      bias: bias?.direction ?? 'hold',
      elapsedMs: Date.now() - startTime,
    });

    return {
      decision: 'skip',
      symbol: signal.symbol,
      direction: 'hold',
      reason: `FastPath mock — no real execution in skeleton (${signal.symbol})`,
      elapsedMs: Date.now() - startTime,
      biasReport,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
