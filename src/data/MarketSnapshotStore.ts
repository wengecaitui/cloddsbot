// Stage 3A2 + 3B4C2: MarketSnapshotStore — exchange-isolated in-memory snapshot store
// Singleton-free. Clock injected. Defensive copy on write and read.
//
// Stage 3B4C2: All operations require exchange provenance. Internal Map keys
// use sourceKey(exchange, canonicalSymbol). Two exchanges reading the same
// canonical symbol (e.g. bitget:BTC/USDT vs binance:BTC/USDT) have independent
// ticker state, kline state, version, staleness, and lastUpdatedAt.

import type { ExchangeId } from './MarketIdentity';
import { sourceKey, isExchangeId } from './MarketIdentity';
import type { WsTicker, WsKline } from './types';
import type {
  Clock,
  MarketSnapshot,
  MarketSnapshotStore,
  ReceivedTicker,
  ReceivedClosedKline,
} from './MarketSnapshot';

// ── Options ─────────────────────────────────────────────────────────────────

export interface MarketSnapshotStoreOptions {
  clock?: Clock;
  staleAfterMs?: number;
}

// ── Internal symbol state (exchange-aware) ──────────────────────────────────

interface SymbolState {
  readonly exchange: ExchangeId;
  readonly symbol: string; // canonical
  ticker: ReceivedTicker | null;
  klines: Record<string, ReceivedClosedKline>;
  version: number;
  lastUpdatedAt: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function deepCloneTicker(input: { ticker: WsTicker; receivedAt: number }): ReceivedTicker {
  return {
    ticker: { ...input.ticker },
    receivedAt: input.receivedAt,
  };
}

function deepCloneKline(input: { kline: WsKline; receivedAt: number }): ReceivedClosedKline {
  return {
    kline: { ...input.kline },
    receivedAt: input.receivedAt,
  };
}

function cloneSnapshot(s: SymbolState, clock: Clock, staleAfterMs: number): MarketSnapshot {
  const now = clock.now();
  const ageMs = Math.max(0, now - s.lastUpdatedAt);

  const tickerCopy: ReceivedTicker | null = s.ticker
    ? { ticker: { ...s.ticker.ticker }, receivedAt: s.ticker.receivedAt }
    : null;

  const klinesCopy: Record<string, ReceivedClosedKline> = {};
  for (const [interval, rk] of Object.entries(s.klines)) {
    klinesCopy[interval] = {
      kline: { ...rk.kline },
      receivedAt: rk.receivedAt,
    };
  }

  return {
    exchange: s.exchange,
    symbol: s.symbol,
    ticker: tickerCopy,
    klines: klinesCopy,
    snapshotVersion: s.version,
    generatedAt: now,
    lastUpdatedAt: s.lastUpdatedAt,
    ageMs,
    isStale: ageMs > staleAfterMs,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createMarketSnapshotStore(
  options?: MarketSnapshotStoreOptions,
): MarketSnapshotStore {
  const clock: Clock = options?.clock ?? { now: () => Date.now() };
  const staleAfterMs: number = options?.staleAfterMs ?? 60_000;

  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('staleAfterMs must be a finite positive number');
  }

  const states = new Map<string, SymbolState>();

  // ── Internal read/create ─────────────────────────────────────────────────

  function getOrInit(exchange: ExchangeId, symbol: string): SymbolState {
    const key = sourceKey(exchange, symbol);
    let s = states.get(key);
    if (!s) {
      s = { exchange, symbol, ticker: null, klines: {}, version: 0, lastUpdatedAt: 0 };
      states.set(key, s);
    }
    return s;
  }

  // ── Ticker update ───────────────────────────────────────────────────────

  function updateTicker(input: {
    ticker: WsTicker;
    receivedAt: number;
  }): MarketSnapshot {
    const { ticker, receivedAt } = input;

    if (!isExchangeId(ticker.exchange)) {
      throw new Error(`MarketSnapshotStore: invalid ticker.exchange: ${JSON.stringify(ticker.exchange)}`);
    }
    if (typeof ticker.instId !== 'string' || ticker.instId.length === 0) {
      throw new Error('MarketSnapshotStore: ticker.instId must be a non-empty string');
    }
    if (ticker.channel !== 'ticker') {
      throw new Error(`MarketSnapshotStore: expected ticker.channel='ticker', got '${ticker.channel}'`);
    }
    if (!isFiniteNumber(ticker.ts)) {
      throw new Error(`MarketSnapshotStore: ticker.ts must be finite, got ${ticker.ts}`);
    }
    if (!isFiniteNumber(receivedAt)) {
      throw new Error(`MarketSnapshotStore: receivedAt must be finite, got ${receivedAt}`);
    }

    const exchange = ticker.exchange as ExchangeId;
    const symbol = ticker.instId;
    const state = getOrInit(exchange, symbol);

    // Reject if source ts is strictly older
    if (state.ticker !== null && ticker.ts < state.ticker.ticker.ts) {
      return cloneSnapshot(state, clock, staleAfterMs);
    }

    // Reject if same source ts but same or older receivedAt
    if (
      state.ticker !== null &&
      ticker.ts === state.ticker.ticker.ts &&
      receivedAt <= state.ticker.receivedAt
    ) {
      return cloneSnapshot(state, clock, staleAfterMs);
    }

    // Accept
    state.ticker = deepCloneTicker(input);
    state.version += 1;
    state.lastUpdatedAt = Math.max(state.lastUpdatedAt, receivedAt);

    return cloneSnapshot(state, clock, staleAfterMs);
  }

  // ── Kline update ─────────────────────────────────────────────────────────

  function updateClosedKline(input: {
    kline: WsKline;
    receivedAt: number;
  }): MarketSnapshot {
    const { kline, receivedAt } = input;

    if (!isExchangeId(kline.exchange)) {
      throw new Error(`MarketSnapshotStore: invalid kline.exchange: ${JSON.stringify(kline.exchange)}`);
    }
    if (typeof kline.instId !== 'string' || kline.instId.length === 0) {
      throw new Error('MarketSnapshotStore: kline.instId must be a non-empty string');
    }
    if (kline.channel !== 'kline') {
      throw new Error(`MarketSnapshotStore: expected kline.channel='kline', got '${kline.channel}'`);
    }
    if (kline.confirm !== true) {
      throw new Error(`MarketSnapshotStore: kline.confirm must be true, got ${kline.confirm}`);
    }
    if (!isFiniteNumber(kline.ts)) {
      throw new Error(`MarketSnapshotStore: kline.ts must be finite, got ${kline.ts}`);
    }
    if (!isFiniteNumber(receivedAt)) {
      throw new Error(`MarketSnapshotStore: receivedAt must be finite, got ${receivedAt}`);
    }

    const exchange = kline.exchange as ExchangeId;
    const symbol = kline.instId;
    const state = getOrInit(exchange, symbol);
    const interval = kline.interval;
    const existing = state.klines[interval];

    // Reject if source ts is strictly older (per-interval)
    if (existing !== undefined && kline.ts < existing.kline.ts) {
      return cloneSnapshot(state, clock, staleAfterMs);
    }

    // Reject if same source ts but same or older receivedAt
    if (
      existing !== undefined &&
      kline.ts === existing.kline.ts &&
      receivedAt <= existing.receivedAt
    ) {
      return cloneSnapshot(state, clock, staleAfterMs);
    }

    // Accept
    state.klines[interval] = deepCloneKline(input);
    state.version += 1;
    state.lastUpdatedAt = Math.max(state.lastUpdatedAt, receivedAt);

    return cloneSnapshot(state, clock, staleAfterMs);
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  function getSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot | undefined {
    const key = sourceKey(exchange, symbol);
    const state = states.get(key);
    if (!state) return undefined;
    return cloneSnapshot(state, clock, staleAfterMs);
  }

  function getAllSnapshots(): MarketSnapshot[] {
    const result: MarketSnapshot[] = [];
    for (const [, state] of states) {
      result.push(cloneSnapshot(state, clock, staleAfterMs));
    }
    return result;
  }

  function removeSymbol(exchange: ExchangeId, symbol: string): boolean {
    const key = sourceKey(exchange, symbol);
    return states.delete(key);
  }

  return {
    updateTicker,
    updateClosedKline,
    getAllSnapshots,
    getSnapshot,
    removeSymbol,
  } satisfies MarketSnapshotStore;
}
