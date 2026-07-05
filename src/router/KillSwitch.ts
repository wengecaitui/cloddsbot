/**
 * Kill Switch — 硬限制执行器
 *
 * 职责：
 *  1. 单笔仓位上限
 *  2. 日亏损上限
 *  3. Write-Action 工具超时强切（1.5s）
 *  4. 熔断后自动进入防守模式
 */

import { EventEmitter } from 'events';

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

export interface RiskSnapshot {
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
  /** 触发原因（如有） */
  triggerReason?: string;
}

export class KillSwitch extends EventEmitter {
  private config: KillSwitchConfig;
  private dailyLossUsd: number = 0;
  private isLocked: boolean = false;

  constructor(config: KillSwitchConfig = {}) {
    super();
    this.config = {
      maxSinglePositionPct: config.maxSinglePositionPct ?? 0.15,  // 15%
      totalCapitalUsd: config.totalCapitalUsd ?? 10000,           // $10k 默认
      maxSinglePositionAbsUsd: config.maxSinglePositionAbsUsd ?? Infinity,
      dailyMaxLossUsd: config.dailyMaxLossUsd,                   // undefined = 暂未启用
      writeActionTimeoutSec: config.writeActionTimeoutSec ?? 1.5,
      enabled: config.enabled ?? true,
    };
  }

  /** 计算单笔上限（USD）= totalCapital × maxSinglePositionPct，再与绝对上限取 min */
  getSinglePositionLimitUsd(): number {
    const pctLimit = this.config.totalCapitalUsd * this.config.maxSinglePositionPct;
    return Math.min(pctLimit, this.config.maxSinglePositionAbsUsd ?? Infinity);
  }

  /** 检查是否允许下单 */
  check(symbol: string, positionUsd: number): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };

    const limit = this.getSinglePositionLimitUsd();

    // 单笔上限
    if (positionUsd > limit) {
      return {
        allowed: false,
        reason: `KillSwitch: ${symbol} $${positionUsd.toFixed(0)} 超过单笔上限 $${limit.toFixed(0)} (${(this.config.maxSinglePositionPct * 100).toFixed(0)}% 总仓位)`,
      };
    }

    // 日亏损上限（⚠️ 暂未启用，dailyMaxLossUsd = undefined 时跳过）
    if (this.config.dailyMaxLossUsd != null && this.dailyLossUsd >= this.config.dailyMaxLossUsd) {
      return {
        allowed: false,
        reason: `KillSwitch: 今日亏损 $${this.dailyLossUsd.toFixed(0)} 已达上限 $${this.config.dailyMaxLossUsd.toFixed(0)}`,
      };
    }

    return { allowed: true };
  }

  /** 记录亏损 */
  recordLoss(usd: number): void {
    this.dailyLossUsd += usd;
    if (this.config.dailyMaxLossUsd != null && this.dailyLossUsd >= this.config.dailyMaxLossUsd) {
      this.isLocked = true;
      this.emit('lock', { reason: `Daily loss $${this.dailyLossUsd.toFixed(0)} >= $${this.config.dailyMaxLossUsd.toFixed(0)}` });
    }
  }

  /** 强制锁定（超时触发） */
  lock(reason: string): void {
    this.isLocked = true;
    this.emit('lock', { reason });
  }

  /** 解锁（新交易日） */
  unlock(): void {
    this.isLocked = false;
    this.dailyLossUsd = 0;
    this.emit('unlock');
  }

  /** 获取当前快照 */
  snapshot(): RiskSnapshot {
    return {
      currentExposureUsd: 0,  // TODO: 从账户状态读取
      todayRealizedLossUsd: this.dailyLossUsd,
      todayUnrealizedLossUsd: 0,
      openPositions: 0,
      isTriggered: Boolean(this.isLocked),
      triggerReason: this.isLocked ? 'Daily loss limit reached' : undefined,
    };
  }

  /** 配置 */
  getConfig(): KillSwitchConfig {
    return { ...this.config };
  }
}
