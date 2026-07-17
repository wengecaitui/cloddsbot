// Stage 3B3B-R2: Binance USD-M Subscription Planner with route partitioning
//
// Pure function — no network, no API keys, no side effects.
// Converts a SubscriptionPlan into Binance USD-M Futures SUBSCRIBE / UNSUBSCRIBE
// requests with deterministic ordering, route-aware batching, and global
// sequential request identifiers.
//
// Routes (see Binance USD-M WebSocket endpoints):
//   public  – bookTicker streams (via wss://fstream.binance.com:443/ws)
//   market  – ticker + kline streams (via wss://fstream.binance.com:443/ws)
// Each request contains only a single route. Mixed-route requests are never
// produced. Requests are ordered: market first, then public.
// Request IDs are globally unique and sequential across all routes.

import type { SubscriptionPlan } from '../../runtime/market/UniverseManager';

export type BinanceRoute = 'public' | 'market';

/** One Binance WebSocket subscription request. */
export interface BinanceSubscriptionRequest {
  readonly route: BinanceRoute;
  readonly method: 'SUBSCRIBE' | 'UNSUBSCRIBE';
  readonly params: readonly string[];
  readonly id: number;
}

export interface BinanceSubscriptionPlannerOptions {
  /** Max streams per SUBSCRIBE request. Default 50. */
  readonly maxStreamsPerRequest?: number;
  /** Start id for the first request. Default 1. */
  readonly startId?: number;
}

// ── Supported intervals (candle intervals) ────────────────────────────────

const SUPPORTED_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

// ── Deterministic interval rank ───────────────────────────────────────────

const INTERVAL_RANK: Record<string, number> = {
  '1m': 0, '3m': 1, '5m': 2, '15m': 3, '30m': 4,
  '1h': 5, '2h': 6, '4h': 7, '6h': 8, '8h': 9, '12h': 10,
  '1d': 11, '3d': 12, '1w': 13, '1M': 14,
};

function sortIntervals(intervals: readonly string[]): string[] {
  const unique = [...new Set(intervals)];
  for (const iv of unique) {
    if (!SUPPORTED_INTERVALS.has(iv)) {
      throw new Error(
        `BinanceSubscriptionPlanner: unsupported interval "${iv}". ` +
        `Supported: ${[...SUPPORTED_INTERVALS].join(', ')}`,
      );
    }
  }
  unique.sort((a, b) => (INTERVAL_RANK[a] ?? 99) - (INTERVAL_RANK[b] ?? 99));
  return unique;
}

function validatePlan(plan: SubscriptionPlan): void {
  if (typeof plan.version !== 'number' || !Number.isInteger(plan.version) || plan.version < 1) {
    throw new Error('BinanceSubscriptionPlanner: plan.version must be a positive integer');
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error('BinanceSubscriptionPlanner: plan.entries must be an array');
  }

  const seenCanonical = new Set<string>();
  const seenExchangeLower = new Set<string>();

  for (const e of plan.entries) {
    if (typeof e.symbol !== 'string' || e.symbol.length === 0) {
      throw new Error('BinanceSubscriptionPlanner: entry.symbol must be non-empty string');
    }
    if (typeof e.exchangeSymbol !== 'string' || e.exchangeSymbol.length === 0 || /\s/.test(e.exchangeSymbol)) {
      throw new Error('BinanceSubscriptionPlanner: entry.exchangeSymbol must be non-empty with no whitespace');
    }
    if (!Array.isArray(e.intervals) || e.intervals.length === 0) {
      throw new Error(`BinanceSubscriptionPlanner: entry.intervals must be non-empty array for "${e.symbol}"`);
    }
    if (seenCanonical.has(e.symbol)) {
      throw new Error(`BinanceSubscriptionPlanner: duplicate canonical symbol "${e.symbol}"`);
    }
    const lowerEx = e.exchangeSymbol.toLowerCase();
    if (seenExchangeLower.has(lowerEx)) {
      throw new Error(`BinanceSubscriptionPlanner: duplicate exchange symbol "${e.exchangeSymbol}" (case-insensitive)`);
    }
    seenCanonical.add(e.symbol);
    seenExchangeLower.add(lowerEx);

    sortIntervals(e.intervals);
  }
}

// ── Stream → route mapping ────────────────────────────────────────────────

function classifyStream(stream: string): BinanceRoute {
  if (stream.endsWith('@bookTicker')) return 'public';
  return 'market'; // @ticker, @kline_*
}

/**
 * Build Binance USD-M Futures subscription requests.
 *
 * Stream naming (all lowercase):
 *   ticker     → <exchangeSymbol>@ticker      (route: market)
 *   bookTicker → <exchangeSymbol>@bookTicker  (route: public)
 *   kline      → <exchangeSymbol>@kline_<iv>  (route: market)
 *
 * Routing rules:
 *   - bookTicker → public endpoint
 *   - ticker + kline → market endpoint
 *   - A single request never mixes routes
 *   - Requests are ordered: market first, then public
 *   - Request ids are globally unique and sequential
 */
export function planBinanceSubscriptionRequests(
  plan: SubscriptionPlan,
  op: 'SUBSCRIBE' | 'UNSUBSCRIBE' = 'SUBSCRIBE',
  options?: BinanceSubscriptionPlannerOptions,
): readonly BinanceSubscriptionRequest[] {
  if (op !== 'SUBSCRIBE' && op !== 'UNSUBSCRIBE') {
    throw new Error(`BinanceSubscriptionPlanner: op must be SUBSCRIBE or UNSUBSCRIBE, got "${op}"`);
  }
  validatePlan(plan);

  const maxStreams = options?.maxStreamsPerRequest ?? 50;
  const startId = options?.startId ?? 1;

  if (!Number.isInteger(maxStreams) || maxStreams < 1) {
    throw new Error('BinanceSubscriptionPlanner: maxStreamsPerRequest must be a positive integer');
  }
  if (!Number.isInteger(startId) || startId < 1 || !Number.isSafeInteger(startId)) {
    throw new Error('BinanceSubscriptionPlanner: startId must be a positive safe integer');
  }

  // ── Build all stream names tagged by route ──────────────────────────
  const marketStreams: string[] = [];
  const publicStreams: string[] = [];

  const sorted = [...plan.entries].sort((a, b) =>
    a.exchangeSymbol.localeCompare(b.exchangeSymbol),
  );

  for (const entry of sorted) {
    const sym = entry.exchangeSymbol.toLowerCase();
    if (entry.ticker) {
      marketStreams.push(`${sym}@ticker`);
      publicStreams.push(`${sym}@bookTicker`);
    }
    const ordered = sortIntervals(entry.intervals);
    for (const iv of ordered) {
      marketStreams.push(`${sym}@kline_${iv}`);
    }
  }

  // ── Batch by route, maintaining global id sequence ───────────────────
  const requests: BinanceSubscriptionRequest[] = [];
  let currentId = startId;
  const maxSafe = Number.MAX_SAFE_INTEGER;

  function flushRoute(route: BinanceRoute, streams: readonly string[]): void {
    for (let i = 0; i < streams.length; i += maxStreams) {
      if (!Number.isSafeInteger(currentId)) {
        throw new Error('BinanceSubscriptionPlanner: id overflow (not safe integer)');
      }
      const chunk = streams.slice(i, i + maxStreams);
      requests.push({
        route,
        method: op,
        params: [...chunk], // defensive copy
        id: currentId,
      });
      currentId++;
      if (currentId > maxSafe) {
        throw new Error('BinanceSubscriptionPlanner: id overflow');
      }
    }
  }

  // market first, public second
  flushRoute('market', marketStreams);
  flushRoute('public', publicStreams);

  return requests;
}
