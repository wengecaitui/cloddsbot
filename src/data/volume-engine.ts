// src/data/volume-engine.ts
// Phase 5: 量能计算引擎 — Volume Delta / Profile / 大单扫描 / 背离

import { WsTrade, WsKline, VolumeDeltaSnapshot, VolumeProfile, DivergenceSignal, BigTrade } from "./types";

// ─── Volume Delta（滚动窗口主动买卖量差） ──────────────────────────────────

export class VolumeDeltaEngine {
  private windowMs: number;
  private buyQty = 0;
  private sellQty = 0;
  private buyNotional = 0;
  private sellNotional = 0;
  private lastFlush = Date.now();

  constructor(windowMs = 60_000) { this.windowMs = windowMs; }

  onTrade(trade: WsTrade): void {
    if (trade.side === "buy") {
      this.buyQty += trade.qty;
      this.buyNotional += trade.price * trade.qty;
    } else {
      this.sellQty += trade.qty;
      this.sellNotional += trade.price * trade.qty;
    }
  }

  snapshot(instId: string): VolumeDeltaSnapshot {
    const now = Date.now();
    if (now - this.lastFlush > this.windowMs) {
      this.buyQty = 0; this.sellQty = 0;
      this.buyNotional = 0; this.sellNotional = 0;
      this.lastFlush = now;
    }
    const net = this.buyQty - this.sellQty;
    return {
      instId,
      windowMs: this.windowMs,
      totalBuyQty: this.buyQty,
      totalSellQty: this.sellQty,
      netDelta: net,
      buyNotional: this.buyNotional,
      sellNotional: this.sellNotional,
      netDeltaNotional: this.buyNotional - this.sellNotional,
      ratio: this.sellQty > 0 ? this.buyQty / this.sellQty : 0,
      ts: now,
    };
  }

  reset(): void {
    this.buyQty = 0; this.sellQty = 0;
    this.buyNotional = 0; this.sellNotional = 0;
    this.lastFlush = Date.now();
  }
}

// ─── Volume Profile（基于 K 线历史重建） ───────────────────────────────────

export class VolumeProfileEngine {
  private klines: WsKline[] = [];
  private maxBars: number;

  constructor(maxBars = 200) { this.maxBars = maxBars; }

  onKline(k: WsKline): void {
    if (k.confirm) {
      this.klines.push(k);
      if (this.klines.length > this.maxBars) this.klines.shift();
    }
  }

  calculate(instId: string, bins = 30): VolumeProfile {
    if (this.klines.length < 10) {
      return { instId, lookbackBars: 0, bins: [], poc: { price: 0, volume: 0 }, vah: 0, val: 0, vwap: 0, ts: Date.now() };
    }

    const closes = this.klines.map(k => k.close);
    const volumes = this.klines.map(k => k.volume);
    const allPrices = [...closes, ...this.klines.map(k => k.high), ...this.klines.map(k => k.low)];

    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const step = (maxP - minP) / bins || 0.01;
    const binData: { lo: number; hi: number; vol: number }[] = Array.from({ length: bins }, (_, i) => ({
      lo: minP + i * step,
      hi: minP + (i + 1) * step,
      vol: 0,
    }));

    for (const k of this.klines) {
      const avg = (k.open + k.high + k.low + k.close) / 4;
      const idx = Math.floor((avg - minP) / step);
      const bin = binData[Math.max(0, Math.min(bins - 1, idx))];
      if (bin) bin.vol += k.volume;
    }

    const totalVol = binData.reduce((s, b) => s + b.vol, 0);
    const vwap = closes.reduce((s, p, i) => s + p * volumes[i], 0) / (volumes.reduce((s, v) => s + v, 0) || 1);

    // POC
    let pocBin = binData[0];
    for (const b of binData) if (b.vol > pocBin.vol) pocBin = b;

    // VAH/VAL: 70% volume 区间
    const sorted = [...binData].sort((a, b) => b.vol - a.vol);
    let cum = 0, vahVal = 0;
    for (let i = 0; i < bins; i++) { cum += sorted[i].vol; if (cum >= totalVol * 0.3) { vahVal = sorted[i].hi; break; } }
    cum = 0;
    let valVal = minP;
    for (let i = bins - 1; i >= 0; i--) { cum += binData[i].vol; if (cum >= totalVol * 0.3) { valVal = binData[i].lo; break; } }

    return {
      instId,
      lookbackBars: this.klines.length,
      bins: binData.map(b => ({
        priceLow: b.lo, priceHigh: b.hi, volume: b.vol,
        delta: 0, isPoc: b === pocBin,
      })),
      poc: { price: (pocBin.lo + pocBin.hi) / 2, volume: pocBin.vol },
      vah: vahVal || maxP,
      val: valVal || minP,
      vwap,
      ts: Date.now(),
    };
  }
}

// ─── 大单扫描器 ─────────────────────────────────────────────────────────────

export class BigTradeScanner {
  private threshold: number;

  constructor(thresholdQty = 0.1) { this.threshold = thresholdQty; }

  scan(trade: WsTrade): BigTrade | null {
    if (trade.qty >= this.threshold) {
      return { ...trade, isBig: true, threshold: this.threshold };
    }
    return null;
  }

  setThreshold(qty: number): void { this.threshold = qty; }
}

// ─── 量价背离检测 ───────────────────────────────────────────────────────────

export class DivergenceDetector {
  private priceWindow: number[] = [];
  private volWindow: number[] = [];
  private maxLen = 50;

  check(price: number, volNotional: number): DivergenceSignal | null {
    this.priceWindow.push(price);
    this.volWindow.push(volNotional);
    if (this.priceWindow.length > this.maxLen) { this.priceWindow.shift(); this.volWindow.shift(); }
    if (this.priceWindow.length < 10) return null;

    const p1 = this.priceWindow[this.priceWindow.length - 10];
    const p2 = this.priceWindow[this.priceWindow.length - 1];
    const v1 = this.volWindow[this.volWindow.length - 10];
    const v2 = this.volWindow[this.volWindow.length - 1];

    const pChg = p1 !== 0 ? (p2 - p1) / p1 : 0;
    const vChg = v1 > 0 && v2 > 0 ? (v2 - v1) / v1 : 0;

    if (pChg < -0.02 && vChg > 0.3) {
      return { instId: "BTCUSDT", type: "bullish_div", priceChange: pChg * 100, volumeChange: vChg * 100, confidence: "medium", ts: Date.now() };
    }
    if (pChg > 0.02 && vChg < -0.3) {
      return { instId: "BTCUSDT", type: "bearish_div", priceChange: pChg * 100, volumeChange: vChg * 100, confidence: "medium", ts: Date.now() };
    }
    return null;
  }
}
