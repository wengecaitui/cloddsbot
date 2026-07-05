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
  /** 单笔最大仓位（USD），默认 100 */
  maxSinglePositionUsd: number;
  /** 日最大亏损（USD），默认 500 */
  dailyMaxLossUsd: number;
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
      maxSinglePositionUsd: config.maxSinglePositionUsd ?? 100,
      dailyMaxLossUsd: config.dailyMaxLossUsd ?? 500,
      writeActionTimeoutSec: config.writeActionTimeoutSec ?? 1.5,
      enabled: config.enabled ?? true,
    };
  }

  /** 检查是否允许下单 */
  check(symbol: string, positionUsd: number): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };

    // 单笔上限
    if (positionUsd > this.config.maxSinglePositionUsd) {
      return {
        allowed: false,
        reason: `KillSwitch: ${symbol} 仓位 $${positionUsd} 超过单笔上限 $${this.config.maxSinglePositionUsd}`,
      };
    }

    // 日亏损上限
    if (this.dailyLossUsd >= this.config.dailyMaxLossUsd) {
      return {
        allowed: false,
        reason: `KillSwitch: 今日亏损 $${this.dailyLossUsd} 已达上限 $${this.config.dailyMaxLossUsd}`,
      };
    }

    return { allowed: true };
  }

  /** 记录亏损 */
  recordLoss(usd: number): void {
    this.dailyLossUsd += usd;
    if (this.dailyLossUsd >= this.config.dailyMaxLossUsd) {
      this.isLocked = true;
      this.emit('lock', { reason: `Daily loss $${this.dailyLossUsd} >= $${this.config.dailyMaxLossUsd}` } as { reason: string });
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
      isTriggered: this.isLocked as boolean,
      triggerReason: this.isLocked ? 'Daily loss limit reached' : undefined,
    };
  }

  /** 配置 */
  getConfig(): KillSwitchConfig {
    return { ...this.config };
  }
}
