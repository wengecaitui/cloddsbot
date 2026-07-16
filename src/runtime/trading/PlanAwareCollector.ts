// Stage 3B1B: Plan-aware collector wrapper
// Translates exchange-level market events into canonical symbols using a
// defensive snapshot of the SubscriptionPlan. Filters unsupported symbols
// and intervals. Does not touch BitgetCollector — works at the port boundary.

import type { WsTicker, WsKline } from '../../data/types';
import type { MarketDataCollectorPort } from '../market/MarketDataRuntime';
import type { SubscriptionPlan, SubscriptionEntry } from '../market/UniverseManager';

interface PlanSnapshot {
  readonly version: number;
  readonly byExchange: ReadonlyMap<string, SubscriptionEntry>;
  readonly byCanonical: ReadonlyMap<string, SubscriptionEntry>;
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
    byExchange.set(e.exchangeSymbol, e);
    byCanonical.set(e.symbol, e);
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
        const entry = snap.byExchange.get(ticker.instId);
        if (!entry) return;                 // unknown exchange symbol
        if (entry.ticker === false) return; // ticker disabled for symbol

        // Clone before rewriting instId to canonical — never mutate input
        const clone: WsTicker = { ...ticker, instId: entry.symbol };
        handler(clone);
      });
    },

    onKline(handler: (kline: WsKline) => void): void {
      inner.onKline((kline) => {
        if (!kline || typeof kline.instId !== 'string') return;
        const entry = snap.byExchange.get(kline.instId);
        if (!entry) return;                 // unknown exchange symbol

        // allowed interval check
        if (!entry.intervals.includes(kline.interval)) return;

        // Clone before rewriting instId to canonical — never mutate input
        const clone: WsKline = { ...kline, instId: entry.symbol };
        handler(clone);
      });
    },
  };
}
