// Stage 3B2B: Bitget V2 Candle Close Detector
// Purely deterministic state machine that infers candle closure from
// startTs progression. Never uses snapshot/update action to decide confirm.

import type { BitgetCandleUpdate } from './PublicMessageParser';
import type { WsKline } from '../types';

export interface CandleCloseDetector {
  ingest(update: BitgetCandleUpdate): readonly WsKline[];
  ingestMany(updates: readonly BitgetCandleUpdate[]): readonly WsKline[];
  clear(): void;
}

interface CurrentCandle {
  readonly startTs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number; // baseVolume
}

interface DetectorState {
  current: CurrentCandle | null;
  lastEmittedStartTs: number | null;
}

type StateMap = Map<string, DetectorState>;

function stateKey(exchangeSymbol: string, interval: string): string {
  return `${exchangeSymbol}|${interval}`;
}

function isValidUpdate(u: BitgetCandleUpdate): boolean {
  if (!u) return false;
  if (typeof u.exchangeSymbol !== 'string' || u.exchangeSymbol.length === 0 || /\s/.test(u.exchangeSymbol)) return false;
  if (typeof u.interval !== 'string' || u.interval.length === 0 || /\s/.test(u.interval)) return false;
  if (typeof u.startTs !== 'number' || !Number.isSafeInteger(u.startTs) || u.startTs < 0) return false;
  for (const v of [u.open, u.high, u.low, u.close, u.baseVolume]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

function toWsKline(symbol: string, interval: string, c: CurrentCandle): WsKline {
  return {
    channel: 'kline',
    instId: symbol,
    interval,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    ts: c.startTs,
    confirm: true,
  };
}

export function createCandleCloseDetector(): CandleCloseDetector {
  const states: StateMap = new Map();

  function getState(key: string): DetectorState {
    let s = states.get(key);
    if (!s) { s = { current: null, lastEmittedStartTs: null }; states.set(key, s); }
    return s;
  }

  function ingestOne(state: DetectorState, u: BitgetCandleUpdate): WsKline[] {
    if (!isValidUpdate(u)) return [];
    const out: WsKline[] = [];

    if (state.current === null) {
      // First ever candle for this key: store, do not emit
      state.current = { startTs: u.startTs, open: u.open, high: u.high, low: u.low, close: u.close, volume: u.baseVolume };
      return out;
    }

    if (u.startTs === state.current.startTs) {
      // Same startTs: replace with latest OHLCV
      state.current = { startTs: u.startTs, open: u.open, high: u.high, low: u.low, close: u.close, volume: u.baseVolume };
      return out;
    }

    if (u.startTs > state.current.startTs) {
      // previous candle is closed — emit it
      const prev = state.current;
      // Skip emission if already emitted (dedup safety — shouldn't happen normally
      // because emitting moves current forward, but protects against logic regressions)
      if (state.lastEmittedStartTs !== prev.startTs) {
        out.push(toWsKline(u.exchangeSymbol, u.interval, prev));
        state.lastEmittedStartTs = prev.startTs;
      }
      state.current = { startTs: u.startTs, open: u.open, high: u.high, low: u.low, close: u.close, volume: u.baseVolume };
      return out;
    }

    // u.startTs < state.current.startTs: late or duplicate historical
    // Ignore. Do NOT roll back, do NOT re-emit, do NOT update state.
    return out;
  }

  function ingest(update: BitgetCandleUpdate): readonly WsKline[] {
    if (!isValidUpdate(update)) return [];
    const key = stateKey(update.exchangeSymbol, update.interval);
    const state = getState(key);
    return ingestOne(state, update);
  }

  function ingestMany(updates: readonly BitgetCandleUpdate[]): readonly WsKline[] {
    if (!Array.isArray(updates)) return [];
    // Group by key (exchangeSymbol|interval), preserving input ref integrity (no mutation)
    const groups = new Map<string, BitgetCandleUpdate[]>();
    for (const u of updates) {
      if (!isValidUpdate(u)) continue; // skip invalid
      const key = stateKey(u.exchangeSymbol, u.interval);
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(u);
    }
    // For each group: sort by startTs ascending; for equal startTs keep input order
    // (so the last entry wins because ingestOne replaces on equal startTs).
    const emitted: WsKline[] = [];
    for (const [key, arr] of groups) {
      const state = getState(key);
      const sorted = [...arr].sort((a, b) => a.startTs - b.startTs);
      for (const u of sorted) {
        const out = ingestOne(state, u);
        for (const k of out) emitted.push(k);
      }
    }
    // Deterministic output ordering: by startTs, then exchangeSymbol, then interval
    emitted.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.instId !== b.instId) return a.instId.localeCompare(b.instId);
      return a.interval.localeCompare(b.interval);
    });
    return emitted;
  }

  function clear(): void {
    states.clear();
  }

  return { ingest, ingestMany, clear };
}
