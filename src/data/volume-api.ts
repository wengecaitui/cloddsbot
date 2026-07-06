// src/data/volume-api.ts
// Phase 5: 量能数据 MCP 工具接口 — 暴露给 AI Agent 调用

import { VolProfileParams, VolDeltaParams, BigTradesParams, BigTradesResult, VolumeDeltaSnapshot } from "./types";
import { VolumeDeltaEngine, VolumeProfileEngine, BigTradeScanner } from "./volume-engine";
import { BitgetCollector } from "./collector";

// ─── 全局实例（单例） ────────────────────────────────────────────────────────

let _collector: BitgetCollector | null = null;
let _deltaEng: VolumeDeltaEngine | null = null;
let _vpEng: VolumeProfileEngine | null = null;
let _bigScan: BigTradeScanner | null = null;

/** 初始化量能引擎（调用一次） */
export function initVolumeEngines(opts?: {
  instIds?: string[];
  deltaWindowMs?: number;
  vpMaxBars?: number;
  bigTradeThreshold?: number;
}): void {
  _collector = new BitgetCollector({
    instIds: opts?.instIds ?? ["BTCUSDT", "ETHUSDT"],
  });
  _deltaEng = new VolumeDeltaEngine(opts?.deltaWindowMs ?? 60_000);
  _vpEng = new VolumeProfileEngine(opts?.vpMaxBars ?? 200);
  _bigScan = new BigTradeScanner(opts?.bigTradeThreshold ?? 0.1);
  console.log("[VolumeAPI] engines initialized");
}

/** 停止采集 */
export function stopVolumeEngines(): void {
  _collector?.stop();
  _collector = null;
  _deltaEng = null; _vpEng = null; _bigScan = null;
}

// ─── MCP 工具：Volume Profile ────────────────────────────────────────────────

/**
 * 查询某交易对当前 Volume Profile（POC / VAH / VAL / VWAP）
 * @param params.instId — 交易对，如 "BTCUSDT"
 * @param params.lookback — 回看 K 线数（默认 200）
 * @param params.bins — 价格分桶数（默认 30）
 */
export async function getVolProfile(params: VolProfileParams): Promise<{
  instId: string;
  poc: { price: number; volume: number };
  vah: number; val: number;
  vwap: number;
  bins: { priceLow: number; priceHigh: number; volume: number; isPoc: boolean }[];
  ts: number;
}> {
  if (!_vpEng) throw new Error("VolumeProfileEngine not initialized — call initVolumeEngines() first");
  return _vpEng.calculate(params.instId, params.bins ?? 30);
}

// ─── MCP 工具：Volume Delta ─────────────────────────────────────────────────

/**
 * 查询某交易对当前 Volume Delta（主动买卖量差）
 * @param params.instId — 交易对
 * @param params.windowMs — 滚动窗口 ms（默认 60000 = 1min）
 */
export async function getVolumeDelta(params: VolDeltaParams): Promise<VolumeDeltaSnapshot> {
  if (!_deltaEng) throw new Error("VolumeDeltaEngine not initialized");
  return _deltaEng.snapshot(params.instId);
}

// ─── MCP 工具：大单扫描 ──────────────────────────────────────────────────────

/**
 * 查询某交易对近期大单
 * @param params.instId — 交易对
 * @param params.minQty — 最小量阈值（默认 0.1 BTC）
 * @param params.limit — 返回条数
 */
export async function getBigTrades(params: BigTradesParams): Promise<BigTradesResult> {
  if (!_bigScan) throw new Error("BigTradeScanner not initialized");
  const minQty = params.minQty ?? 0.1;
  const buf = _collector?.buffer;
  if (!buf) return { instId: params.instId, threshold: minQty, trades: [], totalBuy: 0, totalSell: 0, netDelta: 0 };

  const raw = buf.latest(1000);
  const trades: any[] = [];
  let buyQ = 0, sellQ = 0;

  for (const t of raw) {
    if ((t as any).channel !== "trade") continue;
    const tr = t as any;
    if (tr.qty >= minQty) {
      trades.push({ ...tr, isBig: true, threshold: minQty });
      tr.side === "buy" ? buyQ += tr.qty : sellQ += tr.qty;
    }
  }

  return {
    instId: params.instId,
    threshold: minQty,
    trades: trades.slice(-(params.limit ?? 50)),
    totalBuy: buyQ,
    totalSell: sellQ,
    netDelta: buyQ - sellQ,
  };
}

// ─── 工具清单 ────────────────────────────────────────────────────────────────

export const VOLUME_TOOLS = [
  { name: "getVolProfile", desc: "查询 Volume Profile（POC/VAH/VAL/VWAP）", params: {} },
  { name: "getVolumeDelta", desc: "查询 Volume Delta（滚动窗口主动买卖量差）", params: {} },
  { name: "getBigTrades", desc: "查询大单扫描（taker 方向 + 绝对量）", params: {} },
] as const;

export type VolumeToolName = typeof VOLUME_TOOLS[number]["name"];
