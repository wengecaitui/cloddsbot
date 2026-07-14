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
 *
 * Stage 2B-2P-B: Added canonical raw.data normalization (CALC_RES data dict)
 * that maps indicator name → result while preserving request order and injecting
 * the authoritative name from the map key. Legacy branches (raw.indicators,
 * raw array) are retained for backward compatibility.
 *
 * Stage 2B-2P-B-R1:
 *  - ALL_INDICATORS constrained by IndicatorName (satisfies pattern)
 *  - normalizeData distinguishes Failure result ({error:string}) from Success
 *    result (must carry inner `name`); both paths apply map-key authority.
 */

import { PythonBridgeDaemon } from '../router/PythonBridgeDaemon';
import type { Series } from '../data/types';
import type { IndicatorResult, IndicatorName } from '../types/indicators';

// Re-export for consumers
export type { IndicatorResult };

export interface IndicatorCalcRequest {
  /** 资产符号 */
  asset: string;
  /** Step 2A.3: 用于指标计算的 OHLCV K 线序列 */
  series?: Series[];
}

// ── 14 fixed indicators（唯一请求目录，IndicatorName 约束）───────────────

const ALL_INDICATORS = [
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
] as const satisfies ReadonlyArray<{
  name: IndicatorName;
  params: Record<string, unknown>;
}>;

// Mutable reference for bridge API
const ALL_IND_MUTABLE: Array<{ name: string; params: Record<string, unknown> }> =
  ALL_INDICATORS as unknown as typeof ALL_IND_MUTABLE;

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
   *
   * Stage 2B-2P-B: canonical raw.data normalization.
   *   Priority:
   *     1. raw.data object (map key → authority name)
   *     2. raw.indicators array (legacy)
   *     3. raw itself is array (legacy)
   *     4. throw (unexpected payload shape)
   */
  async calculateAll(req: IndicatorCalcRequest): Promise<IndicatorResult[]> {
    // 超时由 IndicatorService 拥有，Bridge 一侧不再接受 timeoutMs
    const raw = await this.bridge.calculate(
      {
        asset: req.asset,
        series: req.series ?? [],
        indicators: ALL_INDICATORS as unknown as Array<{ name: string; params: Record<string, unknown> }>,
      },
      this.timeoutMs,
    );

    // ── 1. Canonical raw.data object ──────────────────────────────────
    if (raw && typeof raw === 'object' && 'data' in raw) {
      return this.normalizeData(raw.data);
    }

    // ── 2. Legacy: raw.indicators is array ─────────────────────────────
    if (Array.isArray(raw?.indicators)) {
      return raw.indicators as IndicatorResult[];
    }

    // ── 3. Legacy: raw itself is array ────────────────────────────────
    if (Array.isArray(raw)) {
      return raw as IndicatorResult[];
    }

    // ── 4. Unrecognized — throw ──────────────────────────────────────
    throw new Error(`IndicatorService: unexpected bridge payload shape: ${typeof raw}`);
  }

  /**
   * Normalize CALC_RES.data (Record<indicatorName, rawResult>) into
   * an ordered IndicatorResult[] matching the request order of ALL_INDICATORS.
   *
   * Rules:
   *  - Map key is the authoritative indicator name (overrides inner `name`)
   *  - Missing key → contract error (throw)
   *  - null / non-object / array / number / string → contract error (throw)
   *
   *  Failure path (payload contains `error` field):
   *    - error must be string; if present but not a string → throw
   *    - { error: string } is a legitimate partial failure; name injected from map key
   *
   *  Success path (payload does NOT contain `error` field):
   *    - payload must carry a `name` field (typeof string)
   *    - map key overrides any inner name mismatch
   *    - no per-indicator schema validation (future contract hardening debt)
   */
  private normalizeData(data: unknown): IndicatorResult[] {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('IndicatorService: bridge payload data must be a non-null object');
    }

    const dict = data as Record<string, unknown>;

    return ALL_INDICATORS.map(({ name }) => {
      if (!Object.prototype.hasOwnProperty.call(dict, name)) {
        throw new Error(`IndicatorService: bridge payload missing result for ${name}`);
      }

      const value = dict[name];

      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`IndicatorService: invalid result payload for ${name}`);
      }

      const result = value as Record<string, unknown>;

      // ── Failure path ─────────────────────────────────────────────
      if (Object.prototype.hasOwnProperty.call(result, 'error')) {
        // error must be string
        if (typeof result.error !== 'string') {
          throw new Error(`IndicatorService: invalid error field for ${name}`);
        }
        // { error: string } is legitimate partial failure; name injected
        return { ...result, name } as IndicatorResult;
      }

      // ── Success path ─────────────────────────────────────────────
      // Must carry inner name field (otherwise it's an unrecognised empty payload)
      if (typeof result.name !== 'string') {
        throw new Error(`IndicatorService: successful result payload missing name for ${name}`);
      }

      // Map key overrides inner name
      return { ...result, name } as IndicatorResult;
    });
  }
}
