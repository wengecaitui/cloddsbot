// Stage 3B3B: Binance USD-M Public Message Parser
//
// Pure function — no network, no API keys, no side effects.
// Parses raw Binance USD-M Futures WebSocket messages into typed frames.
// Supports both raw format (from single-stream /ws connections) and combined
// format (from /stream?streams=... connections).
//
// Never uses CandleCloseDetector — Binance kline events carry an explicit
// `x` (closed) field.
// Never outputs WsTicker / WsKline directly. Outputs protocol-level frames.

export interface BinanceAckFrame {
  readonly kind: 'ack';
  readonly id: number;
}

export interface BinanceErrorFrame {
  readonly kind: 'error';
  readonly code: string;
  readonly message: string;
  readonly id?: number;
}

export interface BinanceTickerUpdate {
  readonly kind: 'ticker';
  readonly exchangeSymbol: string;
  readonly last: number;
  readonly volume24h: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly ts: number;
}

export interface BinanceBookTickerUpdate {
  readonly kind: 'bookTicker';
  readonly exchangeSymbol: string;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly ts: number;
}

export interface BinanceKlineUpdate {
  readonly kind: 'kline';
  readonly exchangeSymbol: string;
  readonly interval: string;
  readonly startTs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly closed: boolean;
}

export type BinanceMarketUpdate =
  | BinanceTickerUpdate
  | BinanceBookTickerUpdate
  | BinanceKlineUpdate;

export interface BinanceDataFrame {
  readonly kind: 'data';
  readonly events: readonly BinanceMarketUpdate[];
}

export interface BinanceIgnoredFrame {
  readonly kind: 'ignored';
  readonly reason: string;
}

export interface BinanceMalformedFrame {
  readonly kind: 'malformed';
  readonly reason: string;
}

export type BinanceParsedFrame =
  | BinanceAckFrame
  | BinanceErrorFrame
  | BinanceDataFrame
  | BinanceIgnoredFrame
  | BinanceMalformedFrame;

// ── Numeric helper ────────────────────────────────────────────────────────

function parseFinite(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseTimestamp(raw: unknown): number | null {
  const n = parseFinite(raw);
  if (n === null) return null;
  if (n < 0) return null;
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

// ── Combined wrapper detection ────────────────────────────────────────────

interface CombinedPayload {
  stream?: string;
  data?: unknown;
}

function isCombinedPayload(raw: unknown): CombinedPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.stream === 'string' && obj.data !== undefined) {
    return { stream: obj.stream, data: obj.data };
  }
  return null;
}

// ── Ack / Error detection ────────────────────────────────────────────────

function tryParseAckOrError(raw: unknown): BinanceParsedFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Ack: { "result": null | ..., "id": number }
  if ('result' in obj && 'id' in obj) {
    const id = obj.id;
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0) {
      return { kind: 'ack', id };
    }
    return { kind: 'malformed', reason: 'invalid ack id' };
  }

  // Error: { "error": { "code": ..., "msg": ..., ... }, "id"?: number }
  if ('error' in obj && typeof obj.error === 'object' && obj.error !== null) {
    const err = obj.error as Record<string, unknown>;
    const code = String(err.code ?? '');
    const message = String(err.msg ?? '');
    const idRaw = obj.id;
    const id = (typeof idRaw === 'number' && Number.isInteger(idRaw)) ? idRaw : undefined;
    return { kind: 'error', code, message, id };
  }

  return null;
}

// ── Ticker parsing ────────────────────────────────────────────────────────

function tryParseTicker(raw: unknown, envelopeSymbol?: string): BinanceTickerUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // 24hr Ticker event has 'e': '24hrTicker' (not present in combined miniTicker)
  const eventType = obj.e;
  if (eventType !== '24hrTicker' && typeof eventType === 'string' && eventType.endsWith('Ticker')) {
    return null;
  }

  // Determine symbol: from envelope or from event payload
  const sym = envelopeSymbol ?? (obj.s ?? '');
  const exchangeSymbol = typeof sym === 'string' ? sym : '';
  if (exchangeSymbol.length === 0) return null;

  const last = parseFinite(obj.c);
  const volume = parseFinite(obj.v);
  const high = parseFinite(obj.h);
  const low = parseFinite(obj.l);
  const ts = parseTimestamp(obj.E);

  if (last === null || volume === null || high === null || low === null || ts === null) return null;

  return {
    kind: 'ticker',
    exchangeSymbol: exchangeSymbol.toLowerCase(),
    last,
    volume24h: volume,
    high24h: high,
    low24h: low,
    ts,
  };
}

// ── Book Ticker parsing ───────────────────────────────────────────────────

function tryParseBookTicker(raw: unknown, envelopeSymbol?: string): BinanceBookTickerUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Book ticker has specific fields. Detection: no 'e' (event type) or e='bookTicker'
  const eventType = obj.e;
  if (eventType !== undefined && eventType !== 'bookTicker') return null;

  // Fields: s=symbol, b=bestBid, B=bestBidQty, a=bestAsk, A=bestAskQty
  const sym = envelopeSymbol ?? (obj.s ?? '');
  const exchangeSymbol = typeof sym === 'string' ? sym : '';
  if (exchangeSymbol.length === 0) return null;

  // bookTicker: b is bid, a is ask. E is close time for 24hr ticker but for historical
  // bookTicker there may not be 'E'. Fallback to transaction time or Date.now() equivalent.
  // Use E (event time) if present, otherwise use T (transaction time).
  const tsRaw = (obj.E !== undefined) ? obj.E : obj.T;
  const ts = parseTimestamp(tsRaw);
  const bestBid = parseFinite(obj.b);
  const bestAsk = parseFinite(obj.a);

  if (bestBid === null || bestAsk === null || ts === null) return null;

  return {
    kind: 'bookTicker',
    exchangeSymbol: exchangeSymbol.toLowerCase(),
    bestBid,
    bestAsk,
    ts,
  };
}

// ── Kline parsing ─────────────────────────────────────────────────────────

function tryParseKline(raw: unknown, envelopeSymbol?: string): BinanceKlineUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const eventType = obj.e;
  if (eventType !== 'kline') return null;

  // kline data is in nested 'k' field
  const k = obj.k as Record<string, unknown> | undefined;
  if (!k || typeof k !== 'object') return null;

  const sym = envelopeSymbol ?? (obj.s ?? '');
  const exchangeSymbol = typeof sym === 'string' ? sym : '';
  if (exchangeSymbol.length === 0) return null;

  const interval = String(k.i ?? '');
  const startTs = parseTimestamp(k.t);
  const open = parseFinite(k.o);
  const high = parseFinite(k.h);
  const low = parseFinite(k.l);
  const close = parseFinite(k.c);
  const volume = parseFinite(k.v);
  const closed = k.x === true;

  if (startTs === null || open === null || high === null ||
      low === null || close === null || volume === null || interval.length === 0) {
    return null;
  }

  return {
    kind: 'kline',
    exchangeSymbol: exchangeSymbol.toLowerCase(),
    interval,
    startTs,
    open,
    high,
    low,
    close,
    volume,
    closed,
  };
}

// ── Main parse function ───────────────────────────────────────────────────

/**
 * Parse a raw Binance USD-M Futures WebSocket message.
 *
 * Supports:
 *   1. Raw JSON string (parser handles JSON.parse)
 *   2. Already-parsed object
 *   3. Combined stream format: { stream: "btcusdt@ticker", data: {...} }
 *   4. Binary / malformed JSON → malformed frame
 *
 * JSON.parse errors are caught and returned as malformed — never thrown.
 * Input objects are NOT modified.
 */
export function parseBinancePublicMessage(
  raw: unknown,
): BinanceParsedFrame {
  let parsed: unknown;

  if (typeof raw === 'string') {
    // Detect pong
    if (raw === 'pong' || raw.includes('pong')) {
      return { kind: 'ignored', reason: 'pong' };
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: 'malformed', reason: 'invalid JSON' };
    }
  } else if (typeof raw === 'object' && raw !== null) {
    parsed = raw;
  } else if (raw === 'pong') {
    return { kind: 'ignored', reason: 'pong' };
  } else {
    return { kind: 'malformed', reason: `unexpected input type: ${typeof raw}` };
  }

  // ── Combined wrapper? ─────────────────────────────────────────────────
  const combined = isCombinedPayload(parsed);
  const payload = combined ? combined.data : parsed;
  const envelopeSymbol = combined ? extractSymbolFromStream(combined.stream!) : undefined;

  // ── Ack/Error check ──────────────────────────────────────────────────
  const ackOrError = tryParseAckOrError(payload);
  if (ackOrError) return ackOrError;

  // ── Kline check (before ticker because 'e' helps distinguish) ────────
  const kline = tryParseKline(payload, envelopeSymbol);
  if (kline) return { kind: 'data', events: [kline] };

  // ── Book Ticker check ────────────────────────────────────────────────
  const book = tryParseBookTicker(payload, envelopeSymbol);
  if (book) return { kind: 'data', events: [book] };

  // ── Ticker check ─────────────────────────────────────────────────────
  const ticker = tryParseTicker(payload, envelopeSymbol);
  if (ticker) return { kind: 'data', events: [ticker] };

  // ── Unknown event ────────────────────────────────────────────────────
  const eventType = (payload as Record<string, unknown>)?.e;
  const eventTypeStr = typeof eventType === 'string' ? eventType : 'unknown';
  return { kind: 'ignored', reason: `unrecognised event type: ${eventTypeStr}` };
}

/** Extract symbol from a combined stream name (e.g. "btcusdt@ticker" → "btcusdt"). */
function extractSymbolFromStream(stream: string): string | undefined {
  const atIdx = stream.indexOf('@');
  if (atIdx <= 0) return undefined;
  return stream.slice(0, atIdx);
}
