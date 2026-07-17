// Stage 3B3B-R1: Binance USD-M Public Message Parser (hardened)
//
// Pure function — no network, no API keys, no side effects.
// Parses raw Binance USD-M Futures WebSocket messages into typed frames.
// Supports both raw format (from single-stream /ws connections) and combined
// format (from /stream?streams=... connections).
//
// Never uses CandleCloseDetector — Binance kline events carry an explicit
// `x` (closed) field.
// Never outputs WsTicker / WsKline directly. Outputs protocol-level frames.
//
// Hardening (R1):
//   - exchangeSymbol in outputs preserves Binance payload's original case
//     (e.g. "BTCUSDT"). Stream names from the planner are still lowercase,
//     but the parser does NOT lowercase payload symbols.
//   - Combined wrapper: stream symbol must match payload.s case-insensitively.
//     kline: outer s, k.s, and stream symbol must all agree case-insensitively.
//     Mismatch → malformed.
//   - Top-level error format: { code, msg, id? } (Binance canonical) AND
//     legacy nested { error: { code, msg } } both supported.
//   - Ack only when result === null AND id is a non-negative integer.
//   - Ping/pong: only literal "pong" string is ignored. JSON containing
//     the substring "pong" is NOT special-cased.
//   - Identified ticker/bookTicker/kline events with invalid fields return
//     malformed (not ignored).
//   - kline.x must be strictly boolean. kline.i must be a supported interval.

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
  /** Event timestamp from Binance payload, or 0 if absent. */
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

// ── Supported intervals (must match Planner) ─────────────────────────────

const SUPPORTED_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

// ── Numeric helpers ───────────────────────────────────────────────────────

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
  readonly stream: string;
  readonly data: unknown;
}

function isCombinedPayload(raw: unknown): CombinedPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.stream === 'string' && obj.data !== undefined) {
    return { stream: obj.stream, data: obj.data };
  }
  return null;
}

/** Extract symbol portion (lowercase) from a combined stream name. */
function extractSymbolFromStream(stream: string): string | undefined {
  const atIdx = stream.indexOf('@');
  if (atIdx <= 0) return undefined;
  return stream.slice(0, atIdx).toLowerCase();
}

// ── Ack / Error detection ────────────────────────────────────────────────

/**
 * Binance subscribe ack: exactly `{ result: null, id: number }`.
 * result !== null (array, number, etc.) is NOT a subscribe ack — return null
 * to let downstream handlers decide.
 */
function tryParseAck(raw: unknown): BinanceParsedFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!('result' in obj) || !('id' in obj)) return null;

  // result must be exactly null for a SUBSCRIBE/UNSUBSCRIBE ack.
  if (obj.result !== null) return null;

  const id = obj.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
    return { kind: 'malformed', reason: 'invalid ack id' };
  }
  return { kind: 'ack', id };
}

/**
 * Binance error frames come in two shapes:
 *   1. Top-level:   { code: number|string, msg: string, id?: number }
 *   2. Legacy nested: { error: { code, msg, ... }, id? }
 * Both are accepted.
 */
function tryParseError(raw: unknown): BinanceParsedFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Legacy nested form
  if ('error' in obj && typeof obj.error === 'object' && obj.error !== null) {
    const err = obj.error as Record<string, unknown>;
    const code = String(err.code ?? '');
    const message = String(err.msg ?? '');
    const idRaw = obj.id;
    const id = (typeof idRaw === 'number' && Number.isInteger(idRaw)) ? idRaw : undefined;
    return { kind: 'error', code, message, id };
  }

  // Top-level form — must have BOTH code and msg to qualify.
  if ('code' in obj && 'msg' in obj) {
    const code = String(obj.code ?? '');
    const message = String(obj.msg ?? '');
    const idRaw = obj.id;
    const id = (typeof idRaw === 'number' && Number.isInteger(idRaw)) ? idRaw : undefined;
    return { kind: 'error', code, message, id };
  }

  return null;
}

// ── Symbol consistency check (combined wrapper) ──────────────────────────

/**
 * Verify that all present symbol identifiers agree case-insensitively.
 * Returns true if consistent, false if mismatched.
 * `envelopeSymbol` is already lowercased by extractSymbolFromStream.
 */
function symbolsConsistent(
  envelopeSymbol: string | undefined,
  payloadS: unknown,
  innerKlineS: unknown,
): boolean {
  const candidates: string[] = [];
  if (envelopeSymbol !== undefined) candidates.push(envelopeSymbol);
  if (typeof payloadS === 'string' && payloadS.length > 0) {
    candidates.push(payloadS.toLowerCase());
  }
  if (typeof innerKlineS === 'string' && innerKlineS.length > 0) {
    candidates.push(innerKlineS.toLowerCase());
  }
  if (candidates.length <= 1) return true;
  const first = candidates[0];
  return candidates.every(c => c === first);
}

// ── Ticker parsing ────────────────────────────────────────────────────────

/**
 * Returns:
 *   - BinanceTickerUpdate         → on success
 *   - { kind: 'malformed' }       → on identified ticker event with bad fields
 *   - null                        → not a ticker event
 */
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; malformed: BinanceMalformedFrame }
  | null;

function tryParseTicker(raw: unknown, envelopeSymbol: string | undefined): ParseResult<BinanceTickerUpdate> {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const eventType = obj.e;
  if (eventType !== '24hrTicker') {
    // Not a 24hr ticker event — let other handlers decide.
    return null;
  }

  // Identified as 24hrTicker — fields must be valid or malformed.
  const payloadSymbRaw = obj.s;
  if (typeof payloadSymbRaw !== 'string' || payloadSymbRaw.length === 0) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'ticker: missing or invalid s' } };
  }

  // Envelope consistency
  if (envelopeSymbol !== undefined &&
      envelopeSymbol !== payloadSymbRaw.toLowerCase()) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'ticker: stream/data symbol mismatch' } };
  }

  const last = parseFinite(obj.c);
  const volume = parseFinite(obj.v);
  const high = parseFinite(obj.h);
  const low = parseFinite(obj.l);
  const ts = parseTimestamp(obj.E);

  if (last === null || volume === null || high === null || low === null || ts === null) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'ticker: invalid numeric/ts fields' } };
  }

  return {
    ok: true,
    value: {
      kind: 'ticker',
      exchangeSymbol: payloadSymbRaw, // preserve original case
      last,
      volume24h: volume,
      high24h: high,
      low24h: low,
      ts,
    },
  };
}

// ── Book Ticker parsing ───────────────────────────────────────────────────

function tryParseBookTicker(raw: unknown, envelopeSymbol: string | undefined): ParseResult<BinanceBookTickerUpdate> {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const eventType = obj.e;
  // Binance bookTicker over combined stream typically has NO 'e' field, OR
  // has e='bookTicker'. We treat both as identified bookTicker events
  // ONLY when the expected fields (b, a, s) are present.
  const hasBookFields = ('b' in obj) && ('a' in obj);
  if (eventType !== undefined && eventType !== 'bookTicker') return null;
  if (eventType === undefined && !hasBookFields) return null;

  // Identified as bookTicker
  const payloadSymbRaw = obj.s;
  if (typeof payloadSymbRaw !== 'string' || payloadSymbRaw.length === 0) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'bookTicker: missing or invalid s' } };
  }

  if (envelopeSymbol !== undefined &&
      envelopeSymbol !== payloadSymbRaw.toLowerCase()) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'bookTicker: stream/data symbol mismatch' } };
  }

  const tsRaw = (obj.E !== undefined) ? obj.E : obj.T;
  const ts = parseTimestamp(tsRaw);
  const bestBid = parseFinite(obj.b);
  const bestAsk = parseFinite(obj.a);

  if (bestBid === null || bestAsk === null) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'bookTicker: invalid b/a fields' } };
  }
  // ts is optional — some bookTicker frames carry no E/T. Use 0 as sentinel
  // so the Collector can inject its own receive time later.
  const bookTickerTs = ts ?? 0;

  return {
    ok: true,
    value: {
      kind: 'bookTicker',
      exchangeSymbol: payloadSymbRaw,
      bestBid,
      bestAsk,
      ts: bookTickerTs,
    },
  };
}

// ── Kline parsing ─────────────────────────────────────────────────────────

function tryParseKline(raw: unknown, envelopeSymbol: string | undefined): ParseResult<BinanceKlineUpdate> {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const eventType = obj.e;
  if (eventType !== 'kline') return null;

  // Identified as kline event
  const k = obj.k;
  if (!k || typeof k !== 'object') {
    return { ok: false, malformed: { kind: 'malformed', reason: 'kline: missing or invalid k' } };
  }
  const kObj = k as Record<string, unknown>;

  const payloadSymbRaw = obj.s;
  if (typeof payloadSymbRaw !== 'string' || payloadSymbRaw.length === 0) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'kline: missing or invalid s' } };
  }

  const innerKlineS = kObj.s;
  // All present symbol identifiers must agree case-insensitively.
  if (!symbolsConsistent(envelopeSymbol, payloadSymbRaw, innerKlineS)) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'kline: stream / payload / k.s symbol mismatch' } };
  }

  const interval = typeof kObj.i === 'string' ? kObj.i : '';
  if (interval.length === 0 || !SUPPORTED_INTERVALS.has(interval)) {
    return { ok: false, malformed: { kind: 'malformed', reason: `kline: unsupported interval "${interval}"` } };
  }

  const startTs = parseTimestamp(kObj.t);
  const open = parseFinite(kObj.o);
  const high = parseFinite(kObj.h);
  const low = parseFinite(kObj.l);
  const close = parseFinite(kObj.c);
  const volume = parseFinite(kObj.v);
  // kline.x must be strictly boolean
  const closedRaw = kObj.x;
  if (typeof closedRaw !== 'boolean') {
    return { ok: false, malformed: { kind: 'malformed', reason: 'kline: x must be boolean' } };
  }

  if (startTs === null || open === null || high === null ||
      low === null || close === null || volume === null) {
    return { ok: false, malformed: { kind: 'malformed', reason: 'kline: invalid numeric/ts fields' } };
  }

  return {
    ok: true,
    value: {
      kind: 'kline',
      exchangeSymbol: payloadSymbRaw,
      interval,
      startTs,
      open,
      high,
      low,
      close,
      volume,
      closed: closedRaw,
    },
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
 *   4. Plain "pong" string → ignored (control frame proxy)
 *
 * JSON.parse errors are caught and returned as malformed — never thrown.
 * Input objects are NOT modified.
 */
export function parseBinancePublicMessage(
  raw: unknown,
): BinanceParsedFrame {
  let parsed: unknown;

  if (typeof raw === 'string') {
    // Binance sends ping as WebSocket control frames, not text. Plain
    // "pong" string is the only text we treat as a pong proxy. Substring
    // search raw.includes('pong') MUST NOT be used — it could swallow a
    // legitimate JSON message that contains "pong" as a coincidence.
    if (raw === 'pong') {
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
  const envelopeSymbol = combined ? extractSymbolFromStream(combined.stream) : undefined;

  // ── Ack check (strict: result must be null) ──────────────────────────
  const ack = tryParseAck(payload);
  if (ack) return ack;

  // ── Error check (top-level or nested) ────────────────────────────────
  const err = tryParseError(payload);
  if (err) return err;

  // ── Kline check (independent of ticker — type discriminator helps) ──
  const kline = tryParseKline(payload, envelopeSymbol);
  if (kline) {
    if (kline.ok) return { kind: 'data', events: [kline.value] };
    return kline.malformed;
  }

  // ── Book Ticker check ────────────────────────────────────────────────
  const book = tryParseBookTicker(payload, envelopeSymbol);
  if (book) {
    if (book.ok) return { kind: 'data', events: [book.value] };
    return book.malformed;
  }

  // ── Ticker check ─────────────────────────────────────────────────────
  const ticker = tryParseTicker(payload, envelopeSymbol);
  if (ticker) {
    if (ticker.ok) return { kind: 'data', events: [ticker.value] };
    return ticker.malformed;
  }

  // ── Unknown event ────────────────────────────────────────────────────
  const eventType = (payload as Record<string, unknown>)?.e;
  const eventTypeStr = typeof eventType === 'string' ? eventType : 'unknown';
  return { kind: 'ignored', reason: `unrecognised event type: ${eventTypeStr}` };
}
