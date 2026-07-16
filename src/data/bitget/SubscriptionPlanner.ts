// Stage 3B2A-R1: Bitget V2 Subscription Planner (hardened)
// Pure function — no WebSocket, no network, no side effects.

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

function validateOptions(
  op: string,
  options?: BitgetSubscriptionPlannerOptions,
): void {
  if (op !== 'subscribe' && op !== 'unsubscribe') {
    throw new Error(`SubscriptionPlanner: op must be 'subscribe' or 'unsubscribe', got "${op}"`);
  }
  if (options?.instType !== undefined && options.instType !== 'USDT-FUTURES') {
    throw new Error(`SubscriptionPlanner: options.instType must be 'USDT-FUTURES', got "${options.instType}"`);
  }
  const ma = options?.maxArgsPerBatch;
  if (ma !== undefined) {
    if (typeof ma !== 'number' || !Number.isFinite(ma) || !Number.isInteger(ma) || ma <= 0) {
      throw new Error(`SubscriptionPlanner: maxArgsPerBatch must be a positive integer, got ${ma}`);
    }
  }
  const mb = options?.maxPayloadBytes;
  if (mb !== undefined) {
    if (typeof mb !== 'number' || !Number.isFinite(mb) || !Number.isInteger(mb) || mb <= 0) {
      throw new Error(`SubscriptionPlanner: maxPayloadBytes must be a positive integer, got ${mb}`);
    }
  }
}

function validatePlan(plan: SubscriptionPlan): void {
  if (!plan) throw new Error('SubscriptionPlanner: plan is required');
  if (typeof plan.version !== 'number' || !Number.isInteger(plan.version) || plan.version <= 0) {
    throw new Error(`SubscriptionPlanner: plan.version must be a positive integer, got ${plan.version}`);
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error('SubscriptionPlanner: plan.entries must be an array');
  }
  const seenCanonical = new Set<string>();
  const seenExchange = new Set<string>();
  for (const e of plan.entries) {
    if (!e || typeof e !== 'object') {
      throw new Error('SubscriptionPlanner: each entry must be an object');
    }
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
    if (seenExchange.has(e.exchangeSymbol)) {
      throw new Error(`SubscriptionPlanner: duplicate exchange symbol "${e.exchangeSymbol}"`);
    }
    seenCanonical.add(e.symbol);
    seenExchange.add(e.exchangeSymbol);
  }
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

const INTERVAL_RANK: Record<string, number> = {
  '1m': 1, '5m': 2, '15m': 3, '30m': 4,
  '1h': 5, '4h': 6, '6h': 7, '12h': 8,
  '1d': 9, '3d': 10, '1w': 11, '1M': 12,
};

function sortIntervals(intervals: readonly string[]): string[] {
  // Dedup, then sort by rank
  const unique = [...new Set(intervals)];
  for (const iv of unique) {
    if (!INTERVAL_RANK[iv]) {
      throw new Error(`SubscriptionPlanner: unsupported interval "${iv}". Supported: ${Object.keys(CANONICAL_TO_CANDLE).join(', ')}`);
    }
  }
  return unique.sort((a, b) => INTERVAL_RANK[a] - INTERVAL_RANK[b]);
}

function encodeUtf8(text: string): number {
  return new (globalThis as any).TextEncoder().encode(text).length;
}

export function planBitgetSubscriptionRequests(
  plan: SubscriptionPlan,
  op: 'subscribe' | 'unsubscribe' = 'subscribe',
  options?: BitgetSubscriptionPlannerOptions,
): readonly BitgetSubscriptionRequest[] {
  validateOptions(op, options);
  validatePlan(plan);

  const instType = options?.instType ?? 'USDT-FUTURES';
  const maxArgs = options?.maxArgsPerBatch ?? 50;
  const maxBytes = options?.maxPayloadBytes ?? 4096;

  if (plan.entries.length === 0) return [];

  // Sort entries by exchangeSymbol
  const sorted = [...plan.entries].sort((a, b) => a.exchangeSymbol.localeCompare(b.exchangeSymbol));

  // Build args per entry with deterministic interval ordering
  const args: BitgetSubscriptionArg[] = [];
  for (const entry of sorted) {
    if (entry.ticker !== false) {
      args.push({ instType, channel: 'ticker', instId: entry.exchangeSymbol });
    }
    const ordered = sortIntervals(entry.intervals);
    for (const iv of ordered) {
      args.push({ instType, channel: CANONICAL_TO_CANDLE[iv], instId: entry.exchangeSymbol });
    }
  }

  // Dedup by instType+channel+instId
  const seen = new Set<string>();
  const deduped: BitgetSubscriptionArg[] = [];
  for (const a of args) {
    const k = `${a.instType}|${a.channel}|${a.instId}`;
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(a);
    }
  }

  // Candidate-first batching — each candidate measured before accept
  const batches: BitgetSubscriptionRequest[] = [];
  let current: BitgetSubscriptionArg[] = [];

  for (const a of deduped) {
    const candidate = [...current, a];
    const candidateReq: BitgetSubscriptionRequest = { op, args: candidate };
    const candidateBytes = encodeUtf8(JSON.stringify(candidateReq));

    if (candidate.length <= maxArgs && candidateBytes <= maxBytes) {
      current = candidate;
    } else {
      if (current.length === 0) {
        // Even a single arg exceeds limit
        if (candidateBytes > maxBytes) {
          throw new Error(`SubscriptionPlanner: single arg batch exceeds maxPayloadBytes (${candidateBytes} > ${maxBytes})`);
        }
        // maxArgs=0 edge (already rejected by options validation)
        throw new Error(`SubscriptionPlanner: cannot fit any args into batch (maxArgs=${maxArgs}, maxBytes=${maxBytes})`);
      }
      // Flush current batch; verify it before accepting
      const req: BitgetSubscriptionRequest = { op, args: current };
      const reqBytes = encodeUtf8(JSON.stringify(req));
      if (reqBytes > maxBytes || current.length > maxArgs) {
        throw new Error('SubscriptionPlanner: internal error — flushed batch exceeds limits');
      }
      batches.push(req);
      current = [a];
    }
  }

  // Final flush
  if (current.length > 0) {
    const req: BitgetSubscriptionRequest = { op, args: current };
    const reqBytes = encodeUtf8(JSON.stringify(req));
    if (reqBytes > maxBytes || current.length > maxArgs) {
      throw new Error('SubscriptionPlanner: internal error — final batch exceeds limits');
    }
    batches.push(req);
  }

  return batches;
}
