/**
 * SlowPipeline — 慢路径执行器
 *
 * 职责：执行 Research Pipeline（离线状态机）
 * - Hermes Cron 触发，调用 providers.slowProvider
 * - 运行 4 Analyst + 2 轮辩论 + Research Manager
 * - 产出 MarketBiasReport.json 写入 store
 *
 * ⚠️ 当前为骨架（Mock）实现
 * Phase 3b: 替换为真实 TradingAgents 辩论
 * Phase 6: 移植 4 Analyst 多 Agent 系统
 */

import { EventEmitter } from 'events';
import { providers } from '../providers';
import { ExecutionRouter } from '../router/ExecutionRouter';
import { MarketBiasReportFull } from '../types/market-bias';

export interface SlowPipelineConfig {
  router: ExecutionRouter;
  /** 慢路径模型 */
  model?: string;
  /** 模拟延迟（毫秒，默认 100ms，Phase 3b 改为真实调用） */
  mockLatencyMs?: number;
}

export class SlowPipeline extends EventEmitter {
  private config: SlowPipelineConfig;
  private running: boolean = false;

  constructor(config: SlowPipelineConfig) {
    super();
    this.config = {
      model: config.model ?? 'glm-5.2',
      mockLatencyMs: config.mockLatencyMs ?? 100,
      ...config,
    };
  }

  async run(): Promise<MarketBiasReportFull> {
    if (this.running) throw new Error('SlowPipeline already running');
    this.running = true;
    const startTime = Date.now();

    try {
      this.emit('run_start');

      // Mock: simulate 4 Analyst calls (Phase 3b → real TradingAgents calls)
      await this.delay(this.config.mockLatencyMs);

      const now = Date.now();
      const report: MarketBiasReportFull = {
        timestamp: now,
        globalBias: 'neutral',
        confidence: 50,
        assets: [
          {
            symbol: 'BTC/USDT',
            bias: 'neutral',
            confidence: 50,
            volatility: 35,
            direction: 'hold',
            suggestedPositionPct: 0,
            entryCondition: 'N/A (mock → Phase 3b)',
            stopLoss: '-',
            takeProfit: '-',
          },
          {
            symbol: 'ETH/USDT',
            bias: 'neutral',
            confidence: 50,
            volatility: 50,
            direction: 'hold',
            suggestedPositionPct: 0,
            entryCondition: 'N/A (mock → Phase 3b)',
            stopLoss: '-',
            takeProfit: '-',
          },
        ],
        globalLongShortRatio: 1.0,
        globalVolatility: 40,
        fearGreedIndex: 50,
        fundingStatus: 'neutral',
        whitelist: ['BTC/USDT', 'ETH/USDT'],
        blacklist: [],
        riskEvents: ['Mock report — no real analysis loaded'],
        meta: {
          source: 'hermes_cron',
          modelVersion: this.config.model ?? 'glm-5.2',
          generationTimeMs: Date.now() - startTime,
          inputSummary: 'MOCK — Replace in Phase 3b with real debate output',
        },
      };

      this.config.router.updateBiasReport(report);
      this.emit('run_complete', { report, durationMs: Date.now() - startTime });
      return report;
    } finally {
      this.running = false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
