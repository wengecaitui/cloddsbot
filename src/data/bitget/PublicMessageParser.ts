// Stage 3B2A-R1: Bitget V2 Public Message Parser (hardened)
// Pure function — no network, no side effects.

export type BitgetPushAction = 'snapshot' | 'update';

export interface BitgetTickerUpdate {
  readonly kind: 'ticker';
  readonly action: BitgetPushAction;
  readonly exchangeSymbol: string;
  readonly last: number;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly volume24h: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly ts: number;
}

export interface BitgetCandleUpdate {
  readonly kind: 'candle';
  readonly action: BitgetPushAction;
  readonly exchangeSymbol: string;
  readonly interval: string;
  readonly startTs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly baseVolume: number;
  readonly quoteVolume: number;
  readonly usdtVolume: number;
}

export type BitgetMarketUpdate = BitgetTickerUpdate | BitgetCandleUpdate;

export interface BitgetAckFrame {
  readonly kind: 'ack';
  readonly event: 'subscribe' | 'unsubscribe';
  readonly arg: { readonly instType: 'USDT-FUTURES'; readonly channel: string; readonly instId: string };
}

export interface BitgetErrorFrame {
  readonly kind: 'error';
  readonly code: string;
  readonly message: string;
  readonly arg?: { readonly instType: 'USDT-FUTURES'; readonly channel: string; readonly instId: string };
}

export interface BitgetDataFrame {
  readonly kind: 'data';
  readonly action: BitgetPushAction;
  readonly arg: { readonly instType: 'USDT-FUTURES'; readonly channel: string; readonly instId: string };
  readonly events: readonly BitgetMarketUpdate[];
}

export interface BitgetPongFrame { readonly kind: 'pong'; }
export interface BitgetIgnoredFrame { readonly kind: 'ignored'; readonly reason: string; }
export interface BitgetMalformedFrame { readonly kind: 'malformed'; readonly reason: string; }

export type BitgetParsedPublicFrame =
  | BitgetAckFrame | BitgetErrorFrame | BitgetDataFrame
  | BitgetPongFrame | BitgetIgnoredFrame | BitgetMalformedFrame;

// ── Reverse mapping ────────────────────────────────────────────────────────

const CANDLE_TO_CANONICAL: Record<string, string> = {
  'candle1m':'1m','candle5m':'5m','candle15m':'15m','candle30m':'30m',
  'candle1H':'1h','candle4H':'4h','candle6H':'6h','candle12H':'12h',
  'candle1D':'1d','candle3D':'3d','candle1W':'1w','candle1M':'1M',
};

// ── Strict numeric helpers ─────────────────────────────────────────────────

function fin(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function safeInt(v: unknown): number | null {
  const n = fin(v);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ── Extract & validate Bitget arg ──────────────────────────────────────────

function extractArg(raw: any): { instType: 'USDT-FUTURES'; channel: string; instId: string } | null {
  const arg = raw?.arg;
  if (!arg || typeof arg !== 'object') return null;
  const it = arg.instType;
  const ch = arg.channel;
  const id = arg.instId;
  if (it !== 'USDT-FUTURES') return null;
  if (typeof ch !== 'string' || ch.length === 0 || /\s/.test(ch)) return null;
  if (typeof id !== 'string' || id.length === 0 || /\s/.test(id)) return null;
  return { instType: 'USDT-FUTURES', channel: ch, instId: id };
}

function isPushAction(v: unknown): v is BitgetPushAction {
  return v === 'snapshot' || v === 'update';
}

// ── Ticker parser ──────────────────────────────────────────────────────────

function parseTickerRows(
  argInstId: string,
  action: BitgetPushAction,
  rows: unknown,
): BitgetTickerUpdate[] {
  if (!Array.isArray(rows)) return [];
  const results: BitgetTickerUpdate[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    // Symbol gate: absent row.instId → use envelope arg.instId
    // Present and string and matches → use arg.instId
    // Present and string but mismatch → discard
    // Present and not string → discard
    const rowInstId = (r as any).instId;
    if (rowInstId === undefined) { /* ok, use arg.instId */ }
    else if (typeof rowInstId === 'string') {
      if (rowInstId !== argInstId) continue;
    } else {
      continue; // non-string → discard
    }
    const last  = fin((r as any).lastPr);
    const bid   = fin((r as any).bidPr);
    const ask   = fin((r as any).askPr);
    const bv = fin((r as any).baseVolume);
    const hi = fin((r as any).high24h);
    const lo = fin((r as any).low24h);
    const ts = safeInt((r as any).ts);
    if (last === null || bid === null || ask === null || bv === null || hi === null || lo === null || ts === null) continue;
    results.push({ kind: 'ticker', action, exchangeSymbol: argInstId, last, bestBid: bid, bestAsk: ask, volume24h: bv, high24h: hi, low24h: lo, ts });
  }
  return results;
}

// ── Candle parser ──────────────────────────────────────────────────────────

function parseCandleRows(
  argInstId: string,
  channel: string,
  action: BitgetPushAction,
  rows: unknown,
): BitgetCandleUpdate[] {
  if (!Array.isArray(rows)) return [];
  const interval = CANDLE_TO_CANONICAL[channel];
  if (!interval) return [];
  const results: BitgetCandleUpdate[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const startTs = safeInt(r[0]);
    const open   = fin(r[1]);
    const high   = fin(r[2]);
    const low    = fin(r[3]);
    const close  = fin(r[4]);
    const bv = fin(r[5]);
    const qv = fin(r[6]);
    const uv = fin(r[7]);
    if (startTs === null || open === null || high === null || low === null || close === null ||
        bv === null || qv === null || uv === null) continue;
    results.push({
      kind: 'candle', action, exchangeSymbol: argInstId, interval,
      startTs, open, high, low, close, baseVolume: bv, quoteVolume: qv, usdtVolume: uv,
    });
  }
  return results;
}

// ── Main parser ────────────────────────────────────────────────────────────

export function parseBitgetPublicMessage(raw: unknown): BitgetParsedPublicFrame {
  if (raw === 'pong') return { kind: 'pong' };

  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch {
      return { kind: 'malformed', reason: 'JSON parse failure' };
    }
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { kind: 'malformed', reason: 'input is not a JSON object' };
  }

  const msg = obj as Record<string, unknown>;

  // ── Ack frame ──────────────────────────────────────────────────────────
  if (msg.event === 'subscribe' || msg.event === 'unsubscribe') {
    const arg = extractArg(msg);
    if (!arg) return { kind: 'malformed', reason: 'ack missing or invalid arg' };
    return { kind: 'ack', event: msg.event, arg };
  }

  // ── Error frame ────────────────────────────────────────────────────────
  if (msg.event === 'error') {
    const code = typeof msg.code === 'string' ? msg.code : String(msg.code ?? 'unknown');
    const message = typeof msg.msg === 'string' ? msg.msg : String(msg.msg ?? '');
    const argRaw = extractArg(msg);
    // If arg is absent entirely, error without arg is ok.
    // If arg is present but invalid, return malformed.
    if (argRaw === null && msg.arg !== undefined) {
      return { kind: 'malformed', reason: 'error frame has invalid arg' };
    }
    return { kind: 'error', code, message, arg: argRaw ?? undefined };
  }

  // ── Data frame ─────────────────────────────────────────────────────────
  const action = msg.action;
  if (isPushAction(action)) {
    const arg = extractArg(msg);
    if (!arg) return { kind: 'malformed', reason: 'data frame missing or invalid arg' };
    const ch = arg.channel;
    const isTicker = ch === 'ticker';
    const isCandle = CANDLE_TO_CANONICAL[ch] !== undefined;
    if (!isTicker && !isCandle) {
      return { kind: 'ignored', reason: `unknown channel: ${ch}` };
    }
    const events: BitgetMarketUpdate[] = isTicker
      ? parseTickerRows(arg.instId, action, msg.data)
      : parseCandleRows(arg.instId, ch, action, msg.data);
    return { kind: 'data', action, arg, events };
  }

  return { kind: 'ignored', reason: `unrecognized message shape (keys: ${Object.keys(msg).join(',')})` };
}
