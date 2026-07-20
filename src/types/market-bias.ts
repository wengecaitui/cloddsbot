/**
 * MarketBiasReport Schema
 *
 * 慢路径（Research Pipeline）产出的标准格式市场偏向报告
 * 由 Hermes Cron 定时触发（默认每小时）生成
 * 快路径（Execution Pipeline）读取此报告作为决策依据
 */

import type { ExchangeId } from '../data/MarketIdentity';

export interface MarketBiasReport {
  /** Stage 3B4C4: exchange this report belongs to (required, provenance). */
  readonly exchange: ExchangeId;
  /** 报告生成时间戳（毫秒） */
  timestamp: number;
  /** 报告最后更新时间戳（毫秒）— 用于过期检测，防止僵尸报告 */
  updatedAt: number;
  /** 全局市场偏向：bullish | bearish | neutral */
  globalBias: 'bullish' | 'bearish' | 'neutral';
  /** 综合置信度 0-100 */
  confidence: number;
  /** 各币种详细分析 */
  assets: AssetBias[];
  /** 全局多空比（long positions / short positions） */
  globalLongShortRatio: number;
  /** 市场整体波动率预估（标准化 0-100） */
  globalVolatility: number;
  /** 当前全局恐惧贪婪指数 0-100 */
  fearGreedIndex: number;
  /** 资金费率状态：positive（多头付费）| negative（空头付费）| neutral */
  fundingStatus: 'positive' | 'negative' | 'neutral';
  /** 允许交易的币种白名单 */
  whitelist: string[];
  /** 黑名单（禁止交易的币种） */
  blacklist: string[];
  /** 关键风险事件（最近 24h） */
  riskEvents: string[];
}

/** 单币种分析 */
export interface AssetBias {
  /** 交易符号，如 BTC/USDT */
  symbol: string;
  /** 币种偏向：bullish | bearish | neutral */
  bias: 'bullish' | 'bearish' | 'neutral';
  /** 该币种置信度 0-100 */
  confidence: number;
  /** 波动率预估（标准化 0-100，越高越波动） */
  volatility: number;
  /** 建议方向：long | short | hold */
  direction: 'long' | 'short' | 'hold';
  /** 建议仓位（占最大仓位限制的比例） */
  suggestedPositionPct: number;
  /** 触发条件（如"RSI < 30 + 放量突破"） */
  entryCondition: string;
  /** 止损建议（USD 或 %） */
  stopLoss: string;
  /** 止盈建议（USD 或 %） */
  takeProfit: string;
}

/** 报告元数据 */
export interface MarketBiasMeta {
  /** 数据源：hermes_cron | spread_scanner | manual */
  source: 'hermes_cron' | 'spread_scanner' | 'manual';
  /** 模型版本 */
  modelVersion: string;
  /** 生成耗时（毫秒） */
  generationTimeMs: number;
  /** 输入数据摘要 */
  inputSummary: string;
}

/** 带元数据的完整报告 */
export interface MarketBiasReportFull extends MarketBiasReport {
  meta: MarketBiasMeta;
}
