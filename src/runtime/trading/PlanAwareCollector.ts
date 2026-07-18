// Stage 3B1B-R1 + 3B4C1-R1: Plan-aware collector wrapper with deep defensive snapshot
// Translates exchange-level market events into canonical symbols using a
// defensive snapshot of the SubscriptionPlan. Filters unsupported symbols
// and intervals. Does not touch BitgetCollector — works at the port boundary.
//
// Stage 3B4C1-R1: exchange provenance is validated via isExchangeId() guard.
// Any value not equal to 'bitget' or 'binance' (case-sensitive) is silently
// dropped — never thrown, never re-emitted with a fabricated exchange.

import type { WsTicker, WsKline } from '../../data/types';
import type { MarketDataCollectorPort } from '../market/MarketDataRuntime';
import type { SubscriptionPlan, SubscriptionEntry } from '../market/UniverseManager';
import { isExchangeId } from '../../data/MarketIdentity';

interface PlanSnapshot {
  readonly version: number;
  readonly byExchange: ReadonlyMap<string, SubscriptionEntry>;
  readonly byCanonical: ReadonlyMap<string, SubscriptionEntry>;
}

function deepCloneEntry(e: SubscriptionEntry): SubscriptionEntry {
  return {
    symbol: e.symbol,
    exchangeSymbol: e.exchangeSymbol,
    intervals: [...e.intervals],
    ticker: e.ticker,
  };
}

function snapshotPlan(plan: SubscriptionPlan): PlanSnapshot {
  const byExchange = new Map<string, SubscriptionEntry>();
  const byCanonical = new Map<string, SubscriptionEntry>();

  for (const e of plan.entries) {
    if (byExchange.has(e.exchangeSymbol)) {
      throw new Error(`PlanAwareCollector: duplicate exchange symbol "${e.exchangeSymbol}"`);
    }
    if (byCanonical.has(e.symbol)) {
      throw new Error(`PlanAwareCollector: duplicate canonical symbol "${e.symbol}"`);
    }
    const cloned = deepCloneEntry(e);
    byExchange.set(e.exchangeSymbol, cloned);
    byCanonical.set(e.symbol, cloned);
  }

  return { version: plan.version, byExchange, byCanonical };
}

export function createPlanAwareCollector(
  inner: MarketDataCollectorPort,
  plan: SubscriptionPlan,
): MarketDataCollectorPort {
  const snap = snapshotPlan(plan);

  return {
    start(): Promise<void> {
      return inner.start();
    },

    stop(): void {
      inner.stop();
    },

    onTicker(handler: (ticker: WsTicker) => void): void {
      inner.onTicker((ticker) => {
        if (!ticker || typeof ticker.instId !== 'string') return;
        // Stage 3B4C1-R1: hard exchange provenance guard — fail closed on invalid.
        if (!isExchangeId((ticker as { exchange?: unknown }).exchange)) return;
        const entry = snap.byExchange.get(ticker.instId);
        if (!entry) return;
        if (entry.ticker === false) return;

        // Stage 3B4C1: preserve exchange provenance from source Collector.
        // Only instId is rewritten; exchange is passed through unchanged.
        const clone: WsTicker = { ...ticker, instId: entry.symbol };
        handler(clone);
      });
    },

    onKline(handler: (kline: WsKline) => void): void {
      inner.onKline((kline) => {
        if (!kline || typeof kline.instId !== 'string') return;
        // Stage 3B4C1-R1: hard exchange provenance guard — fail closed on invalid.
        if (!isExchangeId((kline as { exchange?: unknown }).exchange)) return;
        const entry = snap.byExchange.get(kline.instId);
        if (!entry) return;
        if (!entry.intervals.includes(kline.interval)) return;

        // Stage 3B4C1: preserve exchange provenance from source Collector.
        // Only instId is rewritten; exchange is passed through unchanged.
        const clone: WsKline = { ...kline, instId: entry.symbol };
        handler(clone);
      });
    },
  };
}
