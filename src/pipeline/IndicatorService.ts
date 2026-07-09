/**
 * IndicatorService — 技术指标计算抽象层
 *
 * 职责：
 *  - 屏蔽 PythonBridge 协议细节，向上层只暴露"算指标"语义
 *  - 拥有 14 个指标的清单（其中 CompositeMomentum / SmartOrderBlock 强制 pure_numeric_mode）
 *  - 拥有超时熔断（默认 1.5s），底层 PythonBridge 上不再由调用方传超时
 *  - 失败 fail-fast：Bridge 抛错 → IndicatorService 不吞不包装，直接 rethrow
 *
 * 不允许上层（FastPipeline / SlowPipeline）直接 import PythonBridgeDaemon。
 */

import { PythonBridgeDaemon } from '../router/PythonBridgeDaemon';
import type { Series } from '../data/types';
import type { IndicatorResult } from '../types/indicators';

// Re-export for consumers
export type { IndicatorResult };

export interface IndicatorCalcRequest {
  /** 资产符号 */
  asset: string;
  /** Step 2A.3: 用于指标计算的 OHLCV K 线序列 */
  series?: Series[];
}

export class IndicatorService {
  private bridge: PythonBridgeDaemon;
  private timeoutMs: number;

  constructor(bridge: PythonBridgeDaemon, timeoutMs: number = 1500) {
    this.bridge = bridge;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 计算 14 个固定指标，返回结果列表
   * 任何指标失败、Bridge 超时、Bridge 抛错 → 直接 rethrow（fail-fast）
   */
  async calculateAll(req: IndicatorCalcRequest): Promise<IndicatorResult[]> {
    // 指标清单封装在此处 — FastPipeline 不需要知道
    const indicators = [
      { name: 'HullSuite', params: {} },
      { name: 'ChandelierExit', params: {} },
      { name: 'UTBotAlerts', params: {} },
      { name: 'STC', params: {} },
      { name: 'StochasticOverlay', params: {} },
      { name: 'MeanReversion', params: {} },
      { name: 'TrendImpulse', params: {} },
      { name: 'DeltaFlow', params: {} },
      { name: 'ElliottWave', params: {} },
      { name: 'FibonacciEntryBands', params: {} },
      { name: 'SRRange', params: {} },
      { name: 'VolumeProfile', params: {} },
      // 精度关键指标：强制纯数值模式，避免 LLM 推理路径污染快道
      { name: 'CompositeMomentum', params: { pure_numeric_mode: true } },
      { name: 'SmartOrderBlock', params: { pure_numeric_mode: true } },
    ];

    // 超时由 IndicatorService 拥有，Bridge 一侧不再接受 timeoutMs
    const raw = await this.bridge.calculate(
      {
        asset: req.asset,
        series: req.series ?? [],      // Step 2A.3: 真实 K 线数据（来自 collector.ts）
        indicators,
      },
      this.timeoutMs,
    );

    // Bridge 返回的形状不予假设 — 直接透传给上层，由消费者解读
    // 这里仅做最小形状规范化：若 raw 是数组，原样返回；否则包装为单元素
    if (Array.isArray(raw?.indicators)) {
      return raw.indicators as IndicatorResult[];
    }
    if (Array.isArray(raw)) {
      return raw as IndicatorResult[];
    }
    // bridge 返回结构异常 — fail-fast
    throw new Error(`IndicatorService: unexpected bridge payload shape: ${typeof raw}`);
  }
}
