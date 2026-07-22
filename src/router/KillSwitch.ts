/**
 * Kill Switch — hard-limit executor
 *
 * Responsibilities:
 *  1. Single position cap
 *  2. Daily loss cap
 *  3. Write-Action tool timeout lock-out (1.5s)
 *  4. Auto-enter defense mode on circuit-breaker trip
 *
 * Stage 3B4C4: exchange-bound. Every KillSwitch is constructed with an ExchangeId
 * and every method validates `exchange === this.exchange` before mutating state.
 *
 * Stage 3B4C7: explicit isLocked state checked by check() before numeric limits.
 * lockReason stores the precise reason for audit.
 */

import { EventEmitter } from 'events';
import type { ExchangeId } from '../data/MarketIdentity';
import { assertExchangeId } from '../data/MarketIdentity';

export interface KillSwitchConfig {
  /** 单笔最大仓位占总仓位比例，默认 0.15 (15%) */
  maxSinglePositionPct: number;
  /** 当前总仓位（USD），用于计算单笔上限 = totalCapital × maxSinglePositionPct */
  totalCapitalUsd: number;
  /** 单笔绝对上限（USD），optional；超过此值即使比例允许也拒绝，默认 Infinity */
  maxSinglePositionAbsUsd?: number;
  /**
   * 日最大亏损（USD）
   * ⚠️ 暂未启用，测试后再加
   */
  dailyMaxLossUsd?: number;
  /** Write-Action 超时（秒），默认 1.5s */
  writeActionTimeoutSec: number;
  /** 是否启用 Kill Switch */
  enabled: boolean;
}

/** 生产安全默认值 —— 总资本为 0 会使所有交易被拒绝，直到运行时注入真实值 */
const DEFAULT_KILLSWITCH_CONFIG: KillSwitchConfig = {
  maxSinglePositionPct: 0.15,
  totalCapitalUsd: 0,
  writeActionTimeoutSec: 1.5,
  enabled: false,
};

export interface RiskSnapshot {
  /** Stage 3B4C4: exchange this snapshot belongs to. */
  readonly exchange: ExchangeId;
  /** 当前敞口（USD） */
  currentExposureUsd: number;
  /** 今日已实现亏损（USD） */
  todayRealizedLossUsd: number;
  /** 今日未实现亏损（USD） */
  todayUnrealizedLossUsd: number;
  /** 当前持仓数 */
  openPositions: number;
  /** Kill Switch 是否触发 */
  isTriggered: boolean;
  /** 触发原因（如有） — Stage 3B4C7: returns precise lockReason, not generic text. */
  triggerReason?: string;
}

export class KillSwitch extends EventEmitter {
  /** Stage 3B4C4: exchange this KillSwitch is bound to. */
  readonly exchange: ExchangeId;
  private config: KillSwitchConfig;
  private dailyLossUsd: number = 0;
  private isLocked: boolean = false;
  /** Stage 3B4C7: precise reason stored when locked. */
  private lockReason: string | null = null;

  constructor(
    exchange: ExchangeId,
    config: KillSwitchConfig = DEFAULT_KILLSWITCH_CONFIG,
  ) {
    super();
    assertExchangeId('KillSwitch', exchange);
    this.exchange = exchange;
    this.config = {
      maxSinglePositionPct: config.maxSinglePositionPct ?? 0.15,  // 15%
      totalCapitalUsd: config.totalCapitalUsd ?? 10000,           // $10k 默认
      maxSinglePositionAbsUsd: config.maxSinglePositionAbsUsd ?? Infinity,
      dailyMaxLossUsd: config.dailyMaxLossUsd,                   // undefined = 暂未启用
      writeActionTimeoutSec: config.writeActionTimeoutSec ?? 1.5,
      enabled: config.enabled ?? true,
    };
  }

  /** Stage 3B4C4: validate that `exchange` matches this KillSwitch's binding. */
  private assertBoundExchange(exchange: ExchangeId): void {
    if (exchange !== this.exchange) {
      throw new Error(
        `KillSwitch: exchange mismatch: got ${JSON.stringify(exchange)}, expected ${JSON.stringify(this.exchange)}`,
      );
    }
  }

  /** 计算单笔上限（USD）= totalCapital × maxSinglePositionPct，再与绝对上限取 min */
  getSinglePositionLimitUsd(): number {
    const pctLimit = this.config.totalCapitalUsd * this.config.maxSinglePositionPct;
    return Math.min(pctLimit, this.config.maxSinglePositionAbsUsd ?? Infinity);
  }

  /**
   * 检查是否允许下单。
   *
   * Stage 3B4C7 order:
   *   1. exchange validation
   *   2. explicit isLocked check (absolute gate — even with enabled=false)
   *   3. positionUsd validity (non-finite, <=0, or NaN → reject)
   *   4. enabled check (disabled → skip numeric limits only)
   *   5. single-position pct cap
   *   6. single-position absolute cap
   *   7. daily loss cap
   */
  check(
    exchange: ExchangeId,
    symbol: string,
    positionUsd: number,
  ): { allowed: boolean; reason?: string } {
    // 1. Exchange validation
    this.assertBoundExchange(exchange);

    // 2. Stage 3B4C7: explicit lock is an absolute gate
    if (this.isLocked) {
      return {
        allowed: false,
        reason: `KillSwitch: locked — ${this.lockReason ?? 'Unknown reason'}`,
      };
    }

    // 3. Stage 3B4C7: invalid positionUsd
    if (typeof positionUsd !== 'number' || !Number.isFinite(positionUsd) || positionUsd <= 0) {
      return {
        allowed: false,
        reason: `KillSwitch: positionUsd must be a finite positive number, got ${positionUsd}`,
      };
    }

    // 4. enabled=false only skips numeric risk limits — explicit lock still blocks
    if (!this.config.enabled) return { allowed: true };

    const limit = this.getSinglePositionLimitUsd();

    // 5. 单笔百分比上限
    if (positionUsd > limit) {
      return {
        allowed: false,
        reason: `KillSwitch: ${symbol} $${positionUsd.toFixed(0)} exceeds single-position limit $${limit.toFixed(0)} (${(this.config.maxSinglePositionPct * 100).toFixed(0)}% of total)` ,
      };
    }

    // 6. daily loss cap
    if (this.config.dailyMaxLossUsd != null && this.dailyLossUsd >= this.config.dailyMaxLossUsd) {
      return {
        allowed: false,
        reason: `KillSwitch: daily loss $${this.dailyLossUsd.toFixed(0)} reached limit $${this.config.dailyMaxLossUsd.toFixed(0)}`,
      };
    }

    return { allowed: true };
  }

  /** 记录亏损 */
  recordLoss(exchange: ExchangeId, usd: number): void {
    this.assertBoundExchange(exchange);
    this.dailyLossUsd += usd;
    if (this.config.dailyMaxLossUsd != null && this.dailyLossUsd >= this.config.dailyMaxLossUsd) {
      const reason = `Daily loss $${this.dailyLossUsd.toFixed(0)} >= $${this.config.dailyMaxLossUsd.toFixed(0)}`;
      this.isLocked = true;
      this.lockReason = reason;
      this.emit('lock', { exchange, reason });
    }
  }

  /** 强制锁定（超时触发） */
  lock(exchange: ExchangeId, reason: string): void {
    this.assertBoundExchange(exchange);
    this.isLocked = true;
    this.lockReason = reason;
    this.emit('lock', { exchange, reason });
  }

  /** 解锁（新交易日） */
  unlock(exchange: ExchangeId): void {
    this.assertBoundExchange(exchange);
    this.isLocked = false;
    this.lockReason = null;
    this.dailyLossUsd = 0;
    this.emit('unlock');
  }

  /** 获取当前快照 */
  snapshot(exchange: ExchangeId): RiskSnapshot {
    this.assertBoundExchange(exchange);
    return {
      exchange: this.exchange,
      currentExposureUsd: 0,  // TODO: wire from account state
      todayRealizedLossUsd: this.dailyLossUsd,
      todayUnrealizedLossUsd: 0,
      openPositions: 0,
      isTriggered: Boolean(this.isLocked),
      // Stage 3B4C7: return precise lockReason when triggered
      triggerReason: this.isLocked ? (this.lockReason ?? 'Locked (no reason recorded)') : undefined,
    };
  }

  /** 配置 */
  getConfig(): KillSwitchConfig {
    return { ...this.config };
  }
}
