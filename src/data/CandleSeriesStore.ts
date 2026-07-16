// Stage 3A4: CandleSeriesStore — bounded per-symbol+interval OHLCV history
//
// Independent of MarketSnapshotStore (latest-state) and RingBuffer (generic).
// Designed purely for indicator input: keeps last N confirmed closed klines
// per (symbol, interval) in chronological order, oldest-first.

import type { WsKline, Series } from './types';

export interface CandleSeriesStoreOptions {
  /** Max candles retained per (symbol, interval). Default 500. Must be positive int. */
  capacityPerSeries?: number;
}

export interface CandleSeriesStore {
  /**
   * Append a confirmed closed kline. Returns true if accepted.
   * Rejects: confirm !== true, non-finite ts/receivedAt, older ts,
   * or same ts with non-newer receivedAt. Same ts with newer receivedAt
   * replaces the last entry WITHOUT growing the count.
   */
  appendClosedKline(input: { kline: WsKline; receivedAt: number }): boolean;

  /**
   * Return the most recent `count` candles as Series[], ordered oldest → newest.
   * Returns defensive copies. Never returns more than available.
   */
  getSeries(symbol: string, interval: string, count: number): Series[];

  /** True iff at least `minimum` candles are stored for (symbol, interval). */
  hasMinimumSeries(symbol: string, interval: string, minimum: number): boolean;
}

interface CandleEntry {
  kline: WsKline;
  receivedAt: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toSeries(entry: CandleEntry): Series {
  return {
    open: entry.kline.open,
    high: entry.kline.high,
    low: entry.kline.low,
    close: entry.kline.close,
    volume: entry.kline.volume,
    ts: entry.kline.ts,
  };
}

export function createCandleSeriesStore(
  options?: CandleSeriesStoreOptions,
): CandleSeriesStore {
  const capacity = options?.capacityPerSeries ?? 500;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error('CandleSeriesStore: capacityPerSeries must be a positive integer');
  }

  const buffers = new Map<string, CandleEntry[]>();

  function keyOf(symbol: string, interval: string): string {
    return `${symbol}::${interval}`;
  }

  function getOrInit(symbol: string, interval: string): CandleEntry[] {
    const k = keyOf(symbol, interval);
    let buf = buffers.get(k);
    if (!buf) {
      buf = [];
      buffers.set(k, buf);
    }
    return buf;
  }

  function appendClosedKline(input: { kline: WsKline; receivedAt: number }): boolean {
    const { kline, receivedAt } = input;

    if (kline.confirm !== true) return false;
    if (!isFiniteNumber(kline.ts)) return false;
    if (!isFiniteNumber(receivedAt)) return false;

    const buf = getOrInit(kline.instId, kline.interval);

    if (buf.length === 0) {
      buf.push({ kline: { ...kline }, receivedAt });
      return true;
    }

    const last = buf[buf.length - 1];

    // Older ts → reject
    if (kline.ts < last.kline.ts) return false;

    // Same ts: only accept if receivedAt is strictly newer (replace, no growth)
    if (kline.ts === last.kline.ts) {
      if (receivedAt <= last.receivedAt) return false;
      buf[buf.length - 1] = { kline: { ...kline }, receivedAt };
      return true;
    }

    // Newer ts → append (evict oldest if at capacity)
    buf.push({ kline: { ...kline }, receivedAt });
    if (buf.length > capacity) buf.shift();
    return true;
  }

  function getSeries(symbol: string, interval: string, count: number): Series[] {
    if (!Number.isInteger(count) || count <= 0) return [];

    const buf = buffers.get(keyOf(symbol, interval));
    if (!buf || buf.length === 0) return [];

    const take = Math.min(count, buf.length);
    const start = buf.length - take;
    const result: Series[] = [];
    for (let i = start; i < buf.length; i++) {
      result.push(toSeries(buf[i]));
    }
    return result;
  }

  function hasMinimumSeries(symbol: string, interval: string, minimum: number): boolean {
    if (!Number.isInteger(minimum) || minimum <= 0) return false;
    const buf = buffers.get(keyOf(symbol, interval));
    return buf !== undefined && buf.length >= minimum;
  }

  return {
    appendClosedKline,
    getSeries,
    hasMinimumSeries,
  };
}
