// src/data/types.ts
// Phase 5: 统一数据层 — 行情服务数据结构

// ─── WebSocket 原始行情 ────────────────────────────────────────────────────

/** Bitget WebSocket 订阅频道类型 */
export type WsChannel = "trade" | "ticker" | "kline" | "depth";

// ─── 指标计算引擎输入 ──────────────────────────────────────────────────────

/** 单根 OHLCV K 线（Python Bridge 指标计算的原始输入） */
export interface Series {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 可选：Bar 开盘时间（Unix ms），用于对齐 */
  ts?: number;
}

/** Bitget WS trade 推送（逐笔成交） */
export interface WsTrade {
  channel: "trade";
  instId: string;
  price: number;
  qty: number;
  side: "buy" | "sell";
  ts: number;
  tradeId: string;
}

/** Bitget WS ticker 推送（1s 快照） */
export interface WsTicker {
  channel: "ticker";
  instId: string;
  last: number;
  bestBid: number;
  bestAsk: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  ts: number;
}

/** Bitget WS kline 推送 */
export interface WsKline {
  channel: "kline";
  instId: string;
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ts: number;
  confirm: boolean;
}

/** Bitget WS depth delta 推送 */
export interface WsDepth {
  channel: "depth";
  instId: string;
  bids: [number, number][]; // [price, qty][]
  asks: [number, number][];
  checksum: number;
  ts: number;
  isSnapshot: boolean;     // true = 全量快照，false = 增量
}

/** 统一原始行情 union（parser 输出） */
export type RawTick = WsTrade | WsTicker | WsKline | WsDepth;

// ─── 内存环形队列 ──────────────────────────────────────────────────────────

/** 固定大小环形缓冲 */
export class RingBuffer<T> {
  private buf: T[];
  private head: number = 0;
  private size: number = 0;

  constructor(private capacity: number = 20000) {
    this.buf = new Array(capacity);
  }

  push(val: T): void {
    this.buf[this.head] = val;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  /** 取最近 N 条 */
  latest(n: number): T[] {
    const len = Math.min(n, this.size);
    const result: T[] = [];
    for (let i = 0; i < len; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      result.unshift(this.buf[idx]);
    }
    return result;
  }

  /** 取全部 */
  all(): T[] {
    return this.latest(this.size);
  }

  get length(): number { return this.size; }

  /** Step 2A.3: Return all elements and reset buffer (atomic — no iteration window) */
  drain(): T[] {
    const result = this.all();
    this.head = 0;
    this.size = 0;
    return result;
  }
}

// ─── 量能计算引擎 ──────────────────────────────────────────────────────────

/** 大单标记 */
export interface BigTrade extends WsTrade {
  /** > 阈值标记 */
  isBig: boolean;
  threshold: number;  // base asset 阈值
}

/** Volume Delta 快照 */
export interface VolumeDeltaSnapshot {
  instId: string;
  windowMs: number;          // 滚动窗口（如 60_000 = 1min）
  totalBuyQty: number;
  totalSellQty: number;
  netDelta: number;          // totalBuy - totalSell
  buyNotional: number;       // 主动买入 USDT 总额
  sellNotional: number;
  netDeltaNotional: number;
  ratio: number;             // buy / sell
  ts: number;
}

/** Volume Profile（价格区间成交量分布） */
export interface VolumeProfile {
  instId: string;
  lookbackBars: number;
  /** 价格-成交量分 bin */
  bins: {
    priceLow: number;
    priceHigh: number;
    volume: number;
    delta: number;           // 买卖差
    isPoc: boolean;          // Point of Control
  }[];
  poc: {                     // Point of Control
    price: number;
    volume: number;
  };
  vah: number;                // Value Area High (70% volume)
  val: number;                // Value Area Low
  vwap: number;               // 成交量加权均价
  ts: number;
}

/** 量价背离信号 */
export interface DivergenceSignal {
  instId: string;
  type: "bullish_div" | "bearish_div" | "regular_bull_div" | "regular_bear_div";
  /** 价格在下降但成交量或 delta 在上升 = 势头好转 */
  priceChange: number;   // %
  volumeChange: number;  // %
  confidence: "high" | "medium" | "low";
  ts: number;
}

// ─── MCP 工具接口 ──────────────────────────────────────────────────────────

/** getVolProfile 参数 */
export interface VolProfileParams {
  instId: string;
  lookback?: number;   // 默认 200
  bins?: number;       // 默认 30
}

/** getVolumeDelta 参数 */
export interface VolDeltaParams {
  instId: string;
  windowMs?: number;   // 默认 60000 (1min)
}

/** getBigTrades 参数 */
export interface BigTradesParams {
  instId: string;
  minQty?: number;     // 最小量（BTC 默认 0.1）
  limit?: number;      // 返回条数
}

/** 大单查询结果 */
export interface BigTradesResult {
  instId: string;
  threshold: number;
  trades: BigTrade[];
  totalBuy: number;
  totalSell: number;
  netDelta: number;
}
