// Stage 3B4C1-R1: MarketIdentity type guard tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExchangeId } from '../../src/data/MarketIdentity';
import type { ExchangeId } from '../../src/data/MarketIdentity';

// ── isExchangeId: positive cases ───────────────────────────────────────────

test('1. isExchangeId accepts "bitget"', () => {
  assert.equal(isExchangeId('bitget'), true);
  // compile-time narrowing must work
  const v: unknown = 'bitget';
  if (isExchangeId(v)) {
    const _typed: ExchangeId = v; // → ExchangeId
    assert.equal(_typed, 'bitget');
  } else {
    assert.fail('should narrow to ExchangeId');
  }
});

test('2. isExchangeId accepts "binance"', () => {
  assert.equal(isExchangeId('binance'), true);
  const v: unknown = 'binance';
  if (isExchangeId(v)) {
    const _typed: ExchangeId = v;
    assert.equal(_typed, 'binance');
  } else {
    assert.fail('should narrow to ExchangeId');
  }
});

// ── isExchangeId: negative strings ──────────────────────────────────────────

test('3. isExchangeId rejects "coinbase" (unknown exchange)', () => {
  assert.equal(isExchangeId('coinbase'), false);
});

test('4. isExchangeId rejects empty string', () => {
  assert.equal(isExchangeId(''), false);
});

test('5. isExchangeId rejects case variant "BITGET"', () => {
  // Type guard is case-sensitive — 'BITGET' is a different string.
  assert.equal(isExchangeId('BITGET'), false);
  assert.equal(isExchangeId('Bitget'), false);
  assert.equal(isExchangeId(' binance'), false); // leading space
  assert.equal(isExchangeId('binance '), false); // trailing space
});

test('6. isExchangeId rejects "default" and "unknown" placeholders', () => {
  assert.equal(isExchangeId('default'), false);
  assert.equal(isExchangeId('unknown'), false);
  assert.equal(isExchangeId('exchange'), false);
});

// ── isExchangeId: non-string values ──────────────────────────────────────────

test('7. isExchangeId rejects null', () => {
  assert.equal(isExchangeId(null), false);
});

test('8. isExchangeId rejects undefined', () => {
  assert.equal(isExchangeId(undefined), false);
});

test('9. isExchangeId rejects number', () => {
  assert.equal(isExchangeId(0), false);
  assert.equal(isExchangeId(1), false);
  assert.equal(isExchangeId(NaN), false);
  assert.equal(isExchangeId(Infinity), false);
});

test('10. isExchangeId rejects object/array', () => {
  assert.equal(isExchangeId({ exchange: 'bitget' }), false);
  assert.equal(isExchangeId(['bitget']), false);
  assert.equal(isExchangeId(['bitget', 'binance']), false);
});

test('11. isExchangeId rejects boolean', () => {
  assert.equal(isExchangeId(true), false);
  assert.equal(isExchangeId(false), false);
});

// ── isExchangeId: exhaustive coverage ───────────────────────────────────────

test('12. isExchangeId only matches the two canonical values', () => {
  const allStrings: string[] = ['bitget', 'binance', 'BITGET', '', 'bitget ', ' binance',
                                'coinbase', 'okx', 'kraken', 'default', 'unknown',
                                'BITGET', 'Binance', 'bitgetx', 'xbittance'];
  let trueCount = 0;
  for (const s of allStrings) {
    if (isExchangeId(s)) trueCount++;
  }
  assert.equal(trueCount, 2, 'exactly two strings accepted: bitget + binance');
});
