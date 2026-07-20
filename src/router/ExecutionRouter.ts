/**
 * ExecutionRouter — 快慢分道路由引擎
 *
 * Stage 3B4C4: exchange-bound. Each ExecutionRouter is constructed with an ExchangeId
 * and every signal/report/decision carries the exchange. Exchange-scoped ReportStore
 * writes to bias.${exchange}.json. Mismatched exchange throws synchronously.
 *
 * 职责：
 *  1. 根据信号来源（Hermes Cron / Spread-Scanner）硬分流
 *  2. 1.5s 超时中断 → KillSwitch
 *  3. 读取 MarketBiasReport 并注入快路径
 */

import { EventEmitter } from 'events';
import { providers } from '../providers';
import type { ExchangeId } from '../data/MarketIdentity';
import { assertExchangeId, isExchangeId } from '../data/MarketIdentity';
import { KillSwitch } from './KillSwitch';
import type { ReportStoreConfig } from '../store/ReportStore';
import type { MarketBiasReport, MarketBiasReportFull } from '../types/market-bias';

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
  /** Stage 3B4C4: exchange this decision belongs to. */
  readonly exchange: ExchangeId;
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
  /** Stage 3B4C4: exchange this router is bound to (required). */
  readonly exchange: ExchangeId;
  /** 快路径超时（秒），默认 1.5s */
  readonly fastPathTimeoutSec: number;
  /** MarketBiasReport 最大年龄（小时），默认 2 小时 */
  readonly maxBiasReportAgeHours: number;
  /** Kill Switch 配置 */
  readonly killSwitch: KillSwitch;
  /** Stage 3B4C4-R2: Optional ReportStore directory/tmpSuffix (NOT filename). */
  readonly reportStoreConfig?: Omit<ReportStoreConfig, 'filename'>;
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
  /** Stage 3B4C4: exchange this router is bound to. */
  readonly exchange: ExchangeId;
  private config: RouterConfig;
  private biasReport: MarketBiasReportFull | null = null;

  constructor(config: RouterConfig) {
    super();
    assertExchangeId('ExecutionRouter', config.exchange);

    // Stage 3B4C4-R2: killSwitch must be bound to the same exchange
    if (config.killSwitch.exchange !== config.exchange) {
      throw new Error(
        `ExecutionRouter: killSwitch.exchange (${config.killSwitch.exchange}) !== config.exchange (${config.exchange})`,
      );
    }

    this.exchange = config.exchange;
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
   * Stage 3B4C4: validates signal.exchange === this.exchange before routing.
   * Mismatched exchange throws synchronously (fail closed).
   */
  route(signal: {
    exchange: ExchangeId;
    source: SignalSource;
    symbol?: string;
    signalData?: Record<string, unknown>;
  }): RouteDecision {
    // Stage 3B4C4: exchange mismatch — fail closed before routing
    if (signal.exchange !== this.exchange) {
      throw new Error(
        `ExecutionRouter.route: signal.exchange (${signal.exchange}) !== router.exchange (${this.exchange})`,
      );
    }

    // 硬分流规则 1：Cron → Slow
    if (signal.source === SignalSource.HERMES_CRON) {
      return {
        exchange: this.exchange,
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
        exchange: this.exchange,
        path: ExecutionPath.FAST,
        source: signal.source,
        reason: 'Spread signal → mandatory Fast Path (execution pipeline)',
        biasReport: this.biasReport ?? undefined,
        defensiveMode: this.isBiasReportStale(),
      };
    }

    // 兜底：手动触发 → 根据上下文选择
    return {
      exchange: this.exchange,
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
   *
   * Stage 3B4C4: validates report.exchange === this.exchange BEFORE updating
   * memory, emitting events, or writing to disk. Exchange-scoped filename.
   */
  async updateBiasReport(report: MarketBiasReportFull): Promise<void> {
    // Stage 3B4C4: validate exchange provenance before ANY mutation
    if (!isExchangeId((report as { exchange?: unknown }).exchange)) {
      throw new Error(
        `ExecutionRouter.updateBiasReport: report.exchange is not a valid ExchangeId: ${JSON.stringify((report as { exchange?: unknown }).exchange)}`,
      );
    }
    if ((report as { exchange: ExchangeId }).exchange !== this.exchange) {
      throw new Error(
        `ExecutionRouter.updateBiasReport: report.exchange (${report.exchange}) !== router.exchange (${this.exchange})`,
      );
    }

    this.biasReport = report;
    this.emit('bias_updated', { exchange: this.exchange, report, ageHours: 0 });

    // Stage 3B4C4: exchange-scoped atomic write to bias.${exchange}.json
    try {
      const { ReportStore } = await import('../store/ReportStore');
      const store = new ReportStore({
        ...this.config.reportStoreConfig,
        filename: `bias.${this.exchange}.json`,
      });
      await store.write(report);
    } catch (err) {
      // 磁盘写入失败不影响内存流程
      this.emit('bias_write_error', { error: err });
    }
  }

  /**
   * 从磁盘读取 MarketBiasReport（FastPipeline 启动时或内存为空时调用）
   *
   * Stage 3B4C4: reads exchange-scoped file. Returns null if file missing,
   * report missing exchange, invalid exchange, or mismatched exchange.
   */
  async loadBiasReportFromDisk(): Promise<MarketBiasReportFull | null> {
    try {
      const { ReportStore } = await import('../store/ReportStore');
      const store = new ReportStore({
        ...this.config.reportStoreConfig,
        filename: `bias.${this.exchange}.json`,
      });
      const raw = await store.read<MarketBiasReportFull>();
      if (!raw) return null;

      // Stage 3B4C4: validate exchange on disk-loaded report
      if (!isExchangeId((raw as { exchange?: unknown }).exchange)) return null;
      if ((raw as { exchange: ExchangeId }).exchange !== this.exchange) return null;

      return raw;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前 MarketBiasReport
   */
  getBiasReport(): MarketBiasReportFull | null {
    return this.biasReport;
  }

  /**
   * 检查 MarketBiasReport 是否过期（僵尸报告检测）
   * 使用 updatedAt 而非 timestamp，防止 SlowPipeline 挂掉后快路径拿到过期报告盲目交易
   */
  private isBiasReportStale(): boolean {
    if (!this.biasReport) return true;
    const ageMs = Date.now() - this.biasReport.updatedAt;
    const ageHours = ageMs / (1000 * 60 * 60);
    return ageHours > this.config.maxBiasReportAgeHours;
  }

  private hasActivePositions(): boolean {
    return this.config.killSwitch.snapshot(this.exchange).openPositions > 0;
  }

  // =============================================
  // 1.5s 超时熔断 + KillSwitch 集成
  // =============================================

  /**
   * 检查 Write-Action 工具是否超时
   * Stage 3B4C4: passes `this.exchange` to killSwitch.lock
   */
  checkFastPathTimeout(startTime: number): { timedOut: boolean; elapsedMs: number } {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > this.config.fastPathTimeoutSec * 1000) {
      this.config.killSwitch.lock(
        this.exchange,
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
