// Stage 3A4 + 3B4C2: CandleSeriesStore — exchange-isolated bounded OHLCV history
//
// Independent of MarketSnapshotStore (latest-state) and RingBuffer (generic).
// Designed purely for indicator input: keeps last N confirmed closed klines
// per (exchange, symbol, interval) in chronological order, oldest-first.
//
// Stage 3B4C2: All operations require exchange provenance. Internal key:
//   `${sourceKey(exchange, symbol)}::${interval}`
// Bitget BTC/USDT 1m and Binance BTC/USDT 1m use separate buffers.

import type { ExchangeId } from './MarketIdentity';
import { sourceKey } from './MarketIdentity';
import type { WsKline, Series } from './types';

export interface CandleSeriesStoreOptions {
  /** Max candles retained per (exchange, symbol, interval). Default 500. Must be positive int. */
  capacityPerSeries?: number;
}

export interface CandleSeriesStore {
  appendClosedKline(input: { kline: WsKline; receivedAt: number }): boolean;
  getSeries(exchange: ExchangeId, symbol: string, interval: string, count: number): Series[];
  hasMinimumSeries(exchange: ExchangeId, symbol: string, interval: string, minimum: number): boolean;
  removeSymbol(exchange: ExchangeId, symbol: string): boolean;
  removeInterval(exchange: ExchangeId, symbol: string, interval: string): boolean;
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

const SEP = '::';

function keyOf(exchange: ExchangeId, symbol: string, interval: string): string {
  return `${sourceKey(exchange, symbol)}${SEP}${interval}`;
}

export function createCandleSeriesStore(
  options?: CandleSeriesStoreOptions,
): CandleSeriesStore {
  const capacity = options?.capacityPerSeries ?? 500;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error('CandleSeriesStore: capacityPerSeries must be a positive integer');
  }

  const buffers = new Map<string, CandleEntry[]>();

  function getOrInit(exchange: ExchangeId, symbol: string, interval: string): CandleEntry[] {
    const k = keyOf(exchange, symbol, interval);
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

    const buf = getOrInit(
      kline.exchange as ExchangeId,
      kline.instId,
      kline.interval,
    );

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

  function getSeries(exchange: ExchangeId, symbol: string, interval: string, count: number): Series[] {
    if (!Number.isInteger(count) || count <= 0) return [];

    const buf = buffers.get(keyOf(exchange, symbol, interval));
    if (!buf || buf.length === 0) return [];

    const take = Math.min(count, buf.length);
    const start = buf.length - take;
    const result: Series[] = [];
    for (let i = start; i < buf.length; i++) {
      result.push(toSeries(buf[i]));
    }
    return result;
  }

  function hasMinimumSeries(exchange: ExchangeId, symbol: string, interval: string, minimum: number): boolean {
    if (!Number.isInteger(minimum) || minimum <= 0) return false;
    const buf = buffers.get(keyOf(exchange, symbol, interval));
    return buf !== undefined && buf.length >= minimum;
  }

  function removeSymbol(exchange: ExchangeId, symbol: string): boolean {
    let removed = false;
    const prefix = `${sourceKey(exchange, symbol)}${SEP}`;
    for (const [k] of buffers) {
      if (k.startsWith(prefix)) {
        buffers.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  function removeInterval(exchange: ExchangeId, symbol: string, interval: string): boolean {
    return buffers.delete(keyOf(exchange, symbol, interval));
  }

  return {
    appendClosedKline,
    getSeries,
    hasMinimumSeries,
    removeSymbol,
    removeInterval,
  } satisfies CandleSeriesStore;
}
