// Stage 3B3B: Binance USD-M Subscription Planner
//
// Pure function — no network, no API keys, no side effects.
// Converts a SubscriptionPlan into Binance USD-M Futures SUBSCRIBE / UNSUBSCRIBE
// requests with deterministic ordering and payload batching.

import type { SubscriptionPlan } from '../../runtime/market/UniverseManager';

/** One Binance WebSocket subscription request. */
export interface BinanceSubscriptionRequest {
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
        `Supported: ${[...SUPPORTED_INTERVALS].join(', ')}`
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
  const seenExchangeLower = new Set<string>(); // case-insensitive

  for (const e of plan.entries) {
    if (typeof e.symbol !== 'string' || e.symbol.length === 0) {
      throw new Error('BinanceSubscriptionPlanner: entry.symbol must be non-empty string');
    }
    if (typeof e.exchangeSymbol !== 'string' || e.exchangeSymbol.length === 0 || /\s/.test(e.exchangeSymbol)) {
      throw new Error(`BinanceSubscriptionPlanner: entry.exchangeSymbol must be non-empty with no whitespace`);
    }
    if (!Array.isArray(e.intervals) || e.intervals.length === 0) {
      throw new Error(`BinanceSubscriptionPlanner: entry.intervals must be non-empty array for "${e.symbol}"`);
    }
    if (seenCanonical.has(e.symbol)) {
      throw new Error(`BinanceSubscriptionPlanner: duplicate canonical symbol "${e.symbol}"`);
    }
    // Case-insensitive duplicate exchange detection
    const lowerEx = e.exchangeSymbol.toLowerCase();
    if (seenExchangeLower.has(lowerEx)) {
      throw new Error(`BinanceSubscriptionPlanner: duplicate exchange symbol "${e.exchangeSymbol}" (case-insensitive)`);
    }
    seenCanonical.add(e.symbol);
    seenExchangeLower.add(lowerEx);

    // Validate intervals early
    sortIntervals(e.intervals);
  }
}

/**
 * Build Binance USD-M Futures subscription requests.
 *
 * Stream naming (all lowercase):
 *   ticker     → <exchangeSymbol>@ticker
 *   bookTicker → <exchangeSymbol>@bookTicker
 *   kline      → <exchangeSymbol>@kline_<interval>
 *
 * Planner uses lowercase for stream names (official Binance convention).
 * exchangeSymbol is write-captured from plan (uppercase input preserved
 * for the parser, but stream names are always lowercase).
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

  // ── Build all stream names ──────────────────────────────────────────────
  const streams: string[] = [];

  // Sort entries by exchangeSymbol for determinism
  const sorted = [...plan.entries].sort((a, b) =>
    a.exchangeSymbol.localeCompare(b.exchangeSymbol),
  );

  for (const entry of sorted) {
    const sym = entry.exchangeSymbol.toLowerCase();
    if (entry.ticker) {
      streams.push(`${sym}@ticker`);
      streams.push(`${sym}@bookTicker`);
    }
    const ordered = sortIntervals(entry.intervals);
    for (const iv of ordered) {
      streams.push(`${sym}@kline_${iv}`);
    }
  }

  // ── Defensive copy of streams ──────────────────────────────────────────
  const allStreams = [...streams];

  // ── Batch ───────────────────────────────────────────────────────────────
  const requests: BinanceSubscriptionRequest[] = [];
  let currentId = startId;
  const maxSafe = Number.MAX_SAFE_INTEGER;

  for (let i = 0; i < allStreams.length; i += maxStreams) {
    if (!Number.isSafeInteger(currentId)) {
      throw new Error('BinanceSubscriptionPlanner: id overflow (not safe integer)');
    }
    const chunk = allStreams.slice(i, i + maxStreams);
    requests.push({
      method: op,
      params: chunk,
      id: currentId,
    });
    currentId++;
    if (currentId > maxSafe) {
      throw new Error('BinanceSubscriptionPlanner: id overflow');
    }
  }

  return requests;
}
