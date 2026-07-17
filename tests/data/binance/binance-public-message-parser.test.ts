// Stage 3B3B-R1: Binance Public Message Parser tests (hardened)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBinancePublicMessage } from '../../../src/data/binance/BinancePublicMessageParser';

// ── 1. raw 24hrTicker preserves uppercase exchangeSymbol ──────────────────

test('1. raw 24hrTicker preserves uppercase exchangeSymbol', () => {
  const raw = JSON.stringify({
    e: '24hrTicker', s: 'BTCUSDT',
    c: '50000.00', h: '51000.00', l: '49000.00', v: '1234.5', E: 1700000000000,
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'data');
  if (f.kind !== 'data') return;
  const ev = f.events[0];
  assert.equal(ev.kind, 'ticker');
  if (ev.kind !== 'ticker') return;
  assert.equal(ev.exchangeSymbol, 'BTCUSDT', 'preserves original case');
  assert.equal(ev.last, 50000);
  assert.equal(ev.high24h, 51000);
  assert.equal(ev.low24h, 49000);
  assert.equal(ev.volume24h, 1234.5);
  assert.equal(ev.ts, 1700000000000);
});

// ── 2. combined wrapper ticker ────────────────────────────────────────────

test('2. combined { stream, data } ticker', () => {
  const raw = JSON.stringify({
    stream: 'btcusdt@ticker',
    data: { e: '24hrTicker', s: 'BTCUSDT', c: '50000.00', h: '51000.00', l: '49000.00', v: '1234.5', E: 1700000000000 },
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'data');
  if (f.kind !== 'data') return;
  const ev = f.events[0];
  assert.equal(ev.kind, 'ticker');
  if (ev.kind !== 'ticker') return;
  assert.equal(ev.exchangeSymbol, 'BTCUSDT', 'payload s wins');
});

// ── 3. ack only when result === null ───────────────────────────────────────

test('3. ack { result: null, id: 1 } returns ack', () => {
  const f = parseBinancePublicMessage(JSON.stringify({ result: null, id: 1 }));
  assert.equal(f.kind, 'ack');
  if (f.kind !== 'ack') return;
  assert.equal(f.id, 1);
});

test('3b. ack { result: [], id: 1 } is NOT an ack', () => {
  // result=[data] from Binance kline/ticker subscription — not an ack.
  const f = parseBinancePublicMessage(JSON.stringify({ result: [], id: 1 }));
  assert.notEqual(f.kind, 'ack', 'result=[] must not be treated as ack');
});

// ── 4. nested error ────────────────────────────────────────────────────────

test('4. nested error { error, id } returns error', () => {
  const raw = JSON.stringify({ error: { code: 1, msg: 'bad' }, id: 5 });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'error');
  if (f.kind !== 'error') return;
  assert.equal(f.code, '1');
  assert.equal(f.message, 'bad');
  assert.equal(f.id, 5);
});

// ── 5. top-level error ──────────────────────────────────────────────────

test('5. top-level error { code, msg, id? } returns error', () => {
  const raw = JSON.stringify({ code: -1001, msg: 'Internal error', id: 42 });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'error');
  if (f.kind !== 'error') return;
  assert.equal(f.code, '-1001');
  assert.equal(f.message, 'Internal error');
  assert.equal(f.id, 42);
});

// ── 6. bookTicker preserves uppercase exchangeSymbol ──────────────────────

test('6. bookTicker raw produces bookTicker frame', () => {
  const raw = JSON.stringify({
    e: 'bookTicker', s: 'BTCUSDT',
    b: '50000.10', B: '1.5', a: '50000.20', A: '2.0', E: 1700000000000,
  });
  const f = parseBinancePublicMessage(raw);
  if (f.kind !== 'data') { assert.fail('expected data'); return; }
  const ev = f.events[0];
  if (ev.kind !== 'bookTicker') { assert.fail('expected bookTicker'); return; }
  assert.equal(ev.exchangeSymbol, 'BTCUSDT', 'preserves uppercase');
  assert.equal(ev.bestBid, 50000.10);
  assert.equal(ev.bestAsk, 50000.20);
  assert.equal(ev.ts, 1700000000000);
});

// ── 7. kline preserves uppercase, closed=false ────────────────────────────

test('7. kline open (x=false) → closed=false, preserves case', () => {
  const raw = JSON.stringify({
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1700000000000, s: 'BTCUSDT', i: '1m', o: '50000.00', h: '50100.00', l: '49900.00', c: '50050.00', v: '100.5', x: false },
  });
  const f = parseBinancePublicMessage(raw);
  if (f.kind !== 'data') { assert.fail('expected data'); return; }
  const ev = f.events[0];
  if (ev.kind !== 'kline') { assert.fail('expected kline'); return; }
  assert.equal(ev.closed, false);
  assert.equal(ev.exchangeSymbol, 'BTCUSDT', 'preserves uppercase');
  assert.equal(ev.interval, '1m');
  assert.equal(ev.open, 50000);
  assert.equal(ev.close, 50050);
});

// ── 8. kline closed (x=true) ──────────────────────────────────────────────

test('8. kline closed (x=true) → closed=true', () => {
  const raw = JSON.stringify({
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1700000000000, i: '1m', o: '50000', h: '50100', l: '49900', c: '50050', v: '100.5', x: true },
  });
  const f = parseBinancePublicMessage(raw);
  if (f.kind !== 'data') { assert.fail('expected data'); return; }
  const ev = f.events[0];
  if (ev.kind !== 'kline') { assert.fail('expected kline'); return; }
  assert.equal(ev.closed, true);
});

// ── 9. empty numeric → malformed (identified ticker with bad fields) ─────

test('9. empty numeric string on identified ticker returns malformed', () => {
  const raw = JSON.stringify({
    e: '24hrTicker', s: 'BTCUSDT',
    c: '   ', h: '51000', l: '49000', v: '100', E: 1700000000000,
  });
  const f = parseBinancePublicMessage(raw);
  // Identified 24hrTicker with bad c field → malformed
  assert.equal(f.kind, 'malformed', 'bad ticker field → malformed, not ignored');
});

// ── 10. negative timestamp → malformed ──────────────────────────────────

test('10. negative timestamp on identified ticker returns malformed', () => {
  const raw = JSON.stringify({
    e: '24hrTicker', s: 'BTCUSDT',
    c: '50000', h: '51000', l: '49000', v: '100', E: -1,
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'malformed', 'bad ts → malformed');
});

// ── 11. envelope/payload symbol mismatch → malformed ─────────────────────

test('11. combined wrapper stream/payload symbol mismatch returns malformed', () => {
  const raw = JSON.stringify({
    stream: 'btcusdt@ticker',
    data: { e: '24hrTicker', s: 'ETHUSDT', c: '50000', h: '51000', l: '49000', v: '100', E: 1700000000000 },
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'malformed', 'stream vs payload s mismatch → malformed');
});

// ── 12. kline k.s vs outer s mismatch → malformed ────────────────────────

test('12. kline inner k.s mismatched returns malformed', () => {
  const raw = JSON.stringify({
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1000, s: 'ETHUSDT', i: '1m', o: '100', h: '110', l: '90', c: '105', v: '50', x: false },
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'malformed', 'k.s mismatch → malformed');
});

// ── 13. kline.x non-boolean → malformed ─────────────────────────────────

test('13. kline.x non-boolean returns malformed', () => {
  const raw = JSON.stringify({
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1000, s: 'BTCUSDT', i: '1m', o: '100', h: '110', l: '90', c: '105', v: '50', x: 1 },
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'malformed', 'x=number → malformed');
});

// ── 14. kline unsupported interval → malformed ──────────────────────────

test('14. kline unsupported interval returns malformed', () => {
  const raw = JSON.stringify({
    e: 'kline', s: 'BTCUSDT',
    k: { t: 1000, s: 'BTCUSDT', i: '99m', o: '100', h: '110', l: '90', c: '105', v: '50', x: false },
  });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'malformed', 'unsupported interval → malformed');
});

// ── 15. malformed JSON → malformed ────────────────────────────────────────

test('15. malformed JSON returns malformed frame', () => {
  const f = parseBinancePublicMessage('not json');
  assert.equal(f.kind, 'malformed');
});

// ── 16. ignored event ─────────────────────────────────────────────────────

test('16. unknown event type returns ignored', () => {
  const f = parseBinancePublicMessage(JSON.stringify({ e: 'someUnknownEvent', s: 'BTCUSDT' }));
  assert.equal(f.kind, 'ignored');
});

// ── 17. input not modified ───────────────────────────────────────────────

test('17. input object not modified', () => {
  const input = { e: '24hrTicker', s: 'BTCUSDT', c: '50000', h: '51000', l: '49000', v: '100', E: 1700000000000 };
  const snapshot = JSON.parse(JSON.stringify(input));
  parseBinancePublicMessage(input);
  assert.deepEqual(input, snapshot, 'input unchanged');
});

// ── 18. pong string ignored ──────────────────────────────────────────────

test('18. pong string ignored', () => {
  const f = parseBinancePublicMessage('pong');
  assert.equal(f.kind, 'ignored');
});

test('19. JSON containing "pong" substring is NOT swallowed', () => {
  // raw.includes('pong') was removed — this JSON must be parsed.
  const raw = JSON.stringify({ e: '24hrTicker', s: 'BTCUSDT', c: '50000', h: '51000', l: '49000', v: '100', E: 1700000000000 });
  const f = parseBinancePublicMessage(raw);
  assert.equal(f.kind, 'data', 'JSON containing pong substring must be parsed');
});

// ── 20. result=null ack with positive id ──────────────────────────────────

test('20. ack id zero returns malformed (id must be non-negative integer)', () => {
  const f = parseBinancePublicMessage(JSON.stringify({ result: null, id: -1 }));
  assert.equal(f.kind, 'malformed', 'negative ack id → malformed');
});

// ── 21. bookTicker without E/T → ts undefined (R1) ───────────────────────

test('21. bookTicker without E or T produces ts === undefined', () => {
  const raw = JSON.stringify({
    e: 'bookTicker', s: 'BTCUSDT',
    b: '50000.10', B: '1.5', a: '50000.20', A: '2.0',
    // no E, no T
  });
  const f = parseBinancePublicMessage(raw);
  if (f.kind !== 'data') { assert.fail('expected data'); return; }
  const ev = f.events[0];
  if (ev.kind !== 'bookTicker') { assert.fail('expected bookTicker'); return; }
  assert.equal(ev.bestBid, 50000.10);
  assert.equal(ev.bestAsk, 50000.20);
  assert.equal(ev.ts, undefined, 'ts must be undefined when E/T absent');
});

// ── 22. bookTicker with E present still strict ───────────────────────────

test('22. bookTicker with E present preserves ts', () => {
  const raw = JSON.stringify({
    s: 'BTCUSDT',
    b: '50000.10', a: '50000.20', E: 1700000000000,
  });
  const f = parseBinancePublicMessage(raw);
  if (f.kind !== 'data') { assert.fail('expected data'); return; }
  const ev = f.events[0];
  if (ev.kind !== 'bookTicker') { assert.fail('expected bookTicker'); return; }
  assert.equal(ev.ts, 1700000000000);
});
