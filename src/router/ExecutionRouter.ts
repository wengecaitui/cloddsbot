/**
 * ExecutionRouter — 快慢分道路由引擎
 *
 * 职责：
 *  1. 根据信号来源（Hermes Cron / Spread-Scanner）硬分流
 *  2. 1.5s 超时中断 → KillSwitch
 *  3. 读取 MarketBiasReport 并注入快路径
 */

import { EventEmitter } from 'events';
import { providers } from '../providers';
import { KillSwitch } from './KillSwitch';
import { MarketBiasReport, MarketBiasReportFull } from '../types/market-bias';

export enum SignalSource {
  /** Hermes Cron 定时扫描（每小时） */
  HERMES_CRON = 'hermes_cron',
  /** Spread-Scanner 突发差价信号 */
  SPREAD_SCANNER = 'spread_scanner',
  /** 手动触发 */
  MANUAL = 'manual',
}

export enum ExecutionPath {
  /** 慢路径：Research Pipeline（多 Agent 深度辩论） */
  SLOW = 'slow',
  /** 快路径：Execution Pipeline（秒级执行） */
  FAST = 'fast',
}

export interface RouteDecision {
  /** 选定的执行路径 */
  path: ExecutionPath;
  /** 信号来源 */
  source: SignalSource;
  /** 路由原因 */
  reason: string;
  /** MarketBiasReport（如有） */
  biasReport?: MarketBiasReportFull;
  /** 是否强制进入防守模式 */
  defensiveMode: boolean;
}

export interface RouterConfig {
  /** 快路径超时（秒），默认 1.5s */
  fastPathTimeoutSec: number;
  /** MarketBiasReport 最大年龄（小时），默认 2 小时 */
  maxBiasReportAgeHours: number;
  /** Kill Switch 配置 */
  killSwitch: KillSwitch;
}

/**
 * ExecutionRouter — 双轨路由引擎
 *
 * 分流逻辑（硬核判定，无自动选择）：
 *
 * ┌─────────────────────────────┬──────────────┬─────────────┐
 * │ 信号来源                     │ 路由结果     │ 超时        │
 * ├─────────────────────────────┼──────────────┼─────────────┤
 * │ Hermes Cron                 │ → Slow Path  │ 300s        │
 * │ Spread-Scanner              │ → Fast Path  │ 5s / 1.5s熔断│
 * │ Write-Action 工具触发 Slow   │ → 1.5s 熔断   │ → KillSwitch│
 * └─────────────────────────────┴──────────────┴─────────────┘
 */
export class ExecutionRouter extends EventEmitter {
  private config: RouterConfig;
  private biasReport: MarketBiasReportFull | null = null;

  constructor(config: RouterConfig) {
    super();
    this.config = config;
  }

  /** 暴露 KillSwitch（供 FastPipeline / SlowPipeline 调用） */
  get killSwitch(): KillSwitch {
    return this.config.killSwitch;
  }

  // =============================================
  // 核心路由逻辑
  // =============================================

  /**
   * 根据信号来源决定执行路径
   *
   * 这是唯一的入口点，所有调用必须通过此方法
   */
  route(signal: {
    source: SignalSource;
    symbol?: string;
    signalData?: Record<string, unknown>;
  }): RouteDecision {
    // 硬分流规则 1：Cron → Slow
    if (signal.source === SignalSource.HERMES_CRON) {
      return {
        path: ExecutionPath.SLOW,
        source: signal.source,
        reason: 'Cron-triggered → mandatory Slow Path (research pipeline)',
        biasReport: this.biasReport ?? undefined,
        defensiveMode: this.isBiasReportStale(),
      };
    }

    // 硬分流规则 2：Spread-Scanner → Fast
    if (signal.source === SignalSource.SPREAD_SCANNER) {
      return {
        path: ExecutionPath.FAST,
        source: signal.source,
        reason: 'Spread signal → mandatory Fast Path (execution pipeline)',
        biasReport: this.biasReport ?? undefined,
        defensiveMode: this.isBiasReportStale(),
      };
    }

    // 兜底：手动触发 → 根据上下文选择
    return {
      path: this.hasActivePositions() ? ExecutionPath.FAST : ExecutionPath.SLOW,
      source: signal.source,
      reason: 'Manual trigger → context-based routing',
      biasReport: this.biasReport ?? undefined,
      defensiveMode: this.isBiasReportStale(),
    };
  }

  // =============================================
  // MarketBiasReport 管理
  // =============================================

  /**
   * 更新 MarketBiasReport（由慢路径写入）
   */
  updateBiasReport(report: MarketBiasReportFull): void {
    this.biasReport = report;
    this.emit('bias_updated', { report, ageHours: 0 });
  }

  /**
   * 获取当前 MarketBiasReport
   */
  getBiasReport(): MarketBiasReportFull | null {
    return this.biasReport;
  }

  /**
   * 检查 MarketBiasReport 是否过期
   */
  private isBiasReportStale(): boolean {
    if (!this.biasReport) return true;
    const ageHours = (Date.now() - this.biasReport.timestamp) / (1000 * 60 * 60);
    return ageHours > this.config.maxBiasReportAgeHours;
  }

  private hasActivePositions(): boolean {
    return this.config.killSwitch.snapshot().openPositions > 0;
  }

  // =============================================
  // 1.5s 超时熔断 + KillSwitch 集成
  // =============================================

  /**
   * 检查 Write-Action 工具是否超时
   * 快路径执行时调用，超过 1.5s 无响应 → 触发 KillSwitch
   */
  checkFastPathTimeout(startTime: number): { timedOut: boolean; elapsedMs: number } {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > this.config.fastPathTimeoutSec * 1000) {
      this.config.killSwitch.lock(
        `Fast path timeout: ${elapsedMs}ms > ${this.config.fastPathTimeoutSec * 1000}ms`
      );
      return { timedOut: true, elapsedMs };
    }
    return { timedOut: false, elapsedMs };
  }

  // =============================================
  // 配置
  // =============================================

  getConfig(): RouterConfig {
    return { ...this.config };
  }
}
