// Stage 3B2A: Bitget V2 Subscription Planner
// Pure function — no WebSocket, no network, no side effects.
// Converts a SubscriptionPlan into deterministic Bitget V2 subscription requests.

import type { SubscriptionPlan } from '../../runtime/market/UniverseManager';

export interface BitgetSubscriptionArg {
  readonly instType: 'USDT-FUTURES';
  readonly channel: string;
  readonly instId: string;
}

export interface BitgetSubscriptionRequest {
  readonly op: 'subscribe' | 'unsubscribe';
  readonly args: readonly BitgetSubscriptionArg[];
}

export interface BitgetSubscriptionPlannerOptions {
  readonly instType?: 'USDT-FUTURES';
  readonly maxArgsPerBatch?: number;
  readonly maxPayloadBytes?: number;
}

const CANONICAL_TO_CANDLE: Record<string, string> = {
  '1m':  'candle1m',
  '5m':  'candle5m',
  '15m': 'candle15m',
  '30m': 'candle30m',
  '1h':  'candle1H',
  '4h':  'candle4H',
  '6h':  'candle6H',
  '12h': 'candle12H',
  '1d':  'candle1D',
  '3d':  'candle3D',
  '1w':  'candle1W',
  '1M':  'candle1M',
};

function validatePlan(plan: SubscriptionPlan): void {
  if (!plan) throw new Error('SubscriptionPlanner: plan is required');
  if (typeof plan.version !== 'number' || !Number.isInteger(plan.version) || plan.version <= 0) {
    throw new Error(`SubscriptionPlanner: plan.version must be a positive integer, got ${plan.version}`);
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error('SubscriptionPlanner: plan.entries must be an array');
  }
  const seenCanonical = new Set<string>();
  for (const e of plan.entries) {
    if (typeof e.symbol !== 'string' || e.symbol.length === 0) {
      throw new Error('SubscriptionPlanner: entry.symbol must be non-empty string');
    }
    if (typeof e.exchangeSymbol !== 'string' || e.exchangeSymbol.length === 0 || /\s/.test(e.exchangeSymbol)) {
      throw new Error(`SubscriptionPlanner: entry.exchangeSymbol must be non-empty with no whitespace, got "${e.exchangeSymbol}"`);
    }
    if (!Array.isArray(e.intervals) || e.intervals.length === 0) {
      throw new Error(`SubscriptionPlanner: entry.intervals must be non-empty array for "${e.symbol}"`);
    }
    if (seenCanonical.has(e.symbol)) {
      throw new Error(`SubscriptionPlanner: duplicate canonical symbol "${e.symbol}"`);
    }
    // Note: duplicate exchange symbols may legitimately appear (e.g. two
    // canonical names mapping to the same Bitget instId). The dedup phase
    // in the planner handles this gracefully.
    seenCanonical.add(e.symbol);
  }
}

function encodeUtf8(text: string): number {
  // Node.js/Web TextEncoder
  return new (globalThis as any).TextEncoder().encode(text).length;
}

export function planBitgetSubscriptionRequests(
  plan: SubscriptionPlan,
  op: 'subscribe' | 'unsubscribe' = 'subscribe',
  options?: BitgetSubscriptionPlannerOptions,
): readonly BitgetSubscriptionRequest[] {
  validatePlan(plan);

  const instType = (options?.instType ?? 'USDT-FUTURES') as 'USDT-FUTURES';
  const maxArgs = options?.maxArgsPerBatch ?? 50;
  const maxBytes = options?.maxPayloadBytes ?? 4096;

  if (plan.entries.length === 0) return [];

  // Build all args: deterministic ordering
  // Sort by exchangeSymbol (alphabetical), then per symbol: ticker first, then candles in map order
  const sorted = [...plan.entries].sort((a, b) => a.exchangeSymbol.localeCompare(b.exchangeSymbol));
  const args: BitgetSubscriptionArg[] = [];

  for (const entry of sorted) {
    if (entry.ticker !== false) {
      args.push({ instType, channel: 'ticker', instId: entry.exchangeSymbol });
    }
    for (const iv of entry.intervals) {
      const candleCh = CANONICAL_TO_CANDLE[iv];
      if (!candleCh) {
        throw new Error(`SubscriptionPlanner: unsupported interval "${iv}" for "${entry.exchangeSymbol}". Supported: ${Object.keys(CANONICAL_TO_CANDLE).join(', ')}`);
      }
      args.push({ instType, channel: candleCh, instId: entry.exchangeSymbol });
    }
  }

  // Dedup: same instType + channel + instId
  const seen = new Set<string>();
  const deduped: BitgetSubscriptionArg[] = [];
  for (const a of args) {
    const key = `${a.instType}|${a.channel}|${a.instId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(a);
    }
  }

  // Split into batches
  const batches: BitgetSubscriptionRequest[] = [];
  let batch: BitgetSubscriptionArg[] = [];

  function flushBatch(): void {
    if (batch.length === 0) return;
    const req: BitgetSubscriptionRequest = { op, args: batch };
    const size = encodeUtf8(JSON.stringify(req));
    if (size > maxBytes) {
      if (batch.length === 1) {
        throw new Error(`SubscriptionPlanner: single arg batch exceeds maxPayloadBytes (${size} > ${maxBytes})`);
      }
      // Split: pop last arg back, flush the rest, push back the popped arg
      const last = batch.pop()!;
      const smallerReq: BitgetSubscriptionRequest = { op, args: batch };
      // Recursive check — if even 1-arg batch still too large, error above handles it
      batches.push(smallerReq);
      batch = [last];
      flushBatch();
      return;
    }
    batches.push(req);
    batch = [];
  }

  for (const a of deduped) {
    batch.push(a);
    if (batch.length >= maxArgs) {
      flushBatch();
    }
  }
  flushBatch();

  return batches;
}
