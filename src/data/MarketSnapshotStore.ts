// Stage 3A2: MarketSnapshotStore — in-memory per-symbol snapshot store
// Singleton-free. Clock injected. Defensive copy on write and read.

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

// ── Internal symbol state ───────────────────────────────────────────────────

interface SymbolState {
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

function cloneSnapshot(s: SymbolState, clock: Clock, staleAfterMs: number, symbol: string): MarketSnapshot {
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
    symbol,
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

  function getOrInit(symbol: string): SymbolState {
    let s = states.get(symbol);
    if (!s) {
      s = { ticker: null, klines: {}, version: 0, lastUpdatedAt: 0 };
      states.set(symbol, s);
    }
    return s;
  }

  // ── Ticker update ───────────────────────────────────────────────────────

  function updateTicker(input: {
    ticker: WsTicker;
    receivedAt: number;
  }): MarketSnapshot {
    const { ticker, receivedAt } = input;

    if (ticker.channel !== 'ticker') {
      throw new Error(`MarketSnapshotStore: expected ticker.channel='ticker', got '${ticker.channel}'`);
    }
    if (!isFiniteNumber(ticker.ts)) {
      throw new Error(`MarketSnapshotStore: ticker.ts must be finite, got ${ticker.ts}`);
    }
    if (!isFiniteNumber(receivedAt)) {
      throw new Error(`MarketSnapshotStore: receivedAt must be finite, got ${receivedAt}`);
    }

    const symbol = ticker.instId;
    const state = getOrInit(symbol);

    // Reject if source ts is strictly older
    if (state.ticker !== null && ticker.ts < state.ticker.ticker.ts) {
      return cloneSnapshot(state, clock, staleAfterMs, symbol);
    }

    // Reject if same source ts but same or older receivedAt
    if (
      state.ticker !== null &&
      ticker.ts === state.ticker.ticker.ts &&
      receivedAt <= state.ticker.receivedAt
    ) {
      return cloneSnapshot(state, clock, staleAfterMs, symbol);
    }

    // Accept
    state.ticker = deepCloneTicker(input);
    state.version += 1;
    state.lastUpdatedAt = Math.max(state.lastUpdatedAt, receivedAt);

    return cloneSnapshot(state, clock, staleAfterMs, symbol);
  }

  // ── Kline update ─────────────────────────────────────────────────────────

  function updateClosedKline(input: {
    kline: WsKline;
    receivedAt: number;
  }): MarketSnapshot {
    const { kline, receivedAt } = input;

    if (kline.channel !== 'kline') {
      throw new Error(`MarketSnapshotStore: expected kline.channel='kline', got '${kline.channel}'`);
    }
    if (kline.confirm !== true) {
      throw new Error(
        `MarketSnapshotStore: kline.confirm must be true, got ${kline.confirm}`,
      );
    }
    if (!isFiniteNumber(kline.ts)) {
      throw new Error(`MarketSnapshotStore: kline.ts must be finite, got ${kline.ts}`);
    }
    if (!isFiniteNumber(receivedAt)) {
      throw new Error(`MarketSnapshotStore: receivedAt must be finite, got ${receivedAt}`);
    }

    const symbol = kline.instId;
    const state = getOrInit(symbol);
    const interval = kline.interval;
    const existing = state.klines[interval];

    // Reject if source ts is strictly older (per-interval)
    if (existing !== undefined && kline.ts < existing.kline.ts) {
      return cloneSnapshot(state, clock, staleAfterMs, symbol);
    }

    // Reject if same source ts but same or older receivedAt
    if (
      existing !== undefined &&
      kline.ts === existing.kline.ts &&
      receivedAt <= existing.receivedAt
    ) {
      return cloneSnapshot(state, clock, staleAfterMs, symbol);
    }

    // Accept
    state.klines[interval] = deepCloneKline(input);
    state.version += 1;
    state.lastUpdatedAt = Math.max(state.lastUpdatedAt, receivedAt);

    return cloneSnapshot(state, clock, staleAfterMs, symbol);
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  function getSnapshot(symbol: string): MarketSnapshot | undefined {
    const state = states.get(symbol);
    if (!state) return undefined;
    return cloneSnapshot(state, clock, staleAfterMs, symbol);
  }

  function getAllSnapshots(): MarketSnapshot[] {
    const result: MarketSnapshot[] = [];
    for (const [symbol, state] of states) {
      result.push(cloneSnapshot(state, clock, staleAfterMs, symbol));
    }
    return result;
  }

  function removeSymbol(symbol: string): boolean {
    return states.delete(symbol);
  }

  return {
    updateTicker,
    updateClosedKline,
    getSnapshot,
    getAllSnapshots,
    removeSymbol,
  };
}
