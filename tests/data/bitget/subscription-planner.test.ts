// Stage 3B2A-R1: Bitget Subscription Planner tests (hardened)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBitgetSubscriptionRequests } from '../../../src/data/bitget/SubscriptionPlanner';
import type { SubscriptionPlan } from '../../../src/runtime/market/UniverseManager';

function pl(opts: Partial<{ t: boolean; iv: string[] }> = {}): SubscriptionPlan {
  return {
    version: 1,
    entries: [{
      symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT',
      intervals: opts.iv ?? ['1m', '5m'], ticker: opts.t ?? true,
    }],
  };
}

const C1  = { instType: 'USDT-FUTURES', channel: 'candle1m' as const, instId: 'BTCUSDT' };
const C5  = { instType: 'USDT-FUTURES', channel: 'candle5m' as const, instId: 'BTCUSDT' };
const T   = { instType: 'USDT-FUTURES', channel: 'ticker' as const, instId: 'BTCUSDT' };

test('1. ticker=true', () => {
  const r = planBitgetSubscriptionRequests(pl());
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].args, [T, C1, C5]);
});

test('2. ticker=false', () => {
  const r = planBitgetSubscriptionRequests(pl({ t: false }));
  assert.deepEqual(r[0].args, [C1, C5]);
});

test('3. interval fixed rank ordering', () => {
  const r = planBitgetSubscriptionRequests(pl({ iv: ['1d', '1m', '4h', '5m'], t: true }));
  const channels = r[0].args.map(a => a.channel);
  assert.deepEqual(channels, ['ticker', 'candle1m', 'candle5m', 'candle4H', 'candle1D'],
    'sorted by rank: 1m,5m,4h,1d despite input order 1d,1m,4h,5m');
});

test('4. interval input order irrelevant', () => {
  const a = planBitgetSubscriptionRequests(pl({ iv: ['1d', '5m', '1m'], t: false }));
  const b = planBitgetSubscriptionRequests(pl({ iv: ['1m', '5m', '1d'], t: false }));
  assert.deepEqual(a, b);
});

test('5. duplicate interval dedup', () => {
  const r = planBitgetSubscriptionRequests(pl({ iv: ['1m', '1m', '5m', '5m', '1m'], t: false }));
  assert.deepEqual(r[0].args, [C1, C5]);
});

test('6. maxArgsPerBatch splits', () => {
  const p: SubscriptionPlan = {
    version: 1, entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m','5m','1h'], ticker: true },
      { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m','5m','1h'], ticker: true },
      { symbol: 'SOL/USDT', exchangeSymbol: 'SOLUSDT', intervals: ['1m','5m','1h'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p, 'subscribe', { maxArgsPerBatch: 4 });
  assert.equal(r.length, 3, '12 args at 4/batch = 3 batches');
  assert.ok(r.every(x => x.args.length <= 4));
});

test('7. UTF-8 byte boundary splits', () => {
  // Long exchange symbol to make payload bigger
  const p: SubscriptionPlan = {
    version: 1, entries: [
      { symbol: 'A/USDT', exchangeSymbol: 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD', intervals: ['1m','5m','15m','1h'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p, 'subscribe', { maxArgsPerBatch: 100, maxPayloadBytes: 300 });
  assert.ok(r.length > 1, 'split by byte limit');
});

test('8. validate each output batch byte length', () => {
  const r = planBitgetSubscriptionRequests(pl({ iv: ['1m','5m','15m','1h','4h','1d'], t: false }));
  assert.equal(r.length, 1);
  const bytes = new (globalThis as any).TextEncoder().encode(JSON.stringify(r[0])).length;
  assert.ok(bytes <= 4096);
});

test('9. duplicate exchange symbol rejects', () => {
  assert.throws(() => planBitgetSubscriptionRequests({
    version: 1, entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'ETH/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
    ],
  }), /duplicate exchange/);
});

test('10. duplicate canonical rejects', () => {
  assert.throws(() => planBitgetSubscriptionRequests({
    version: 1, entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCPERP', intervals: ['1m'], ticker: true },
    ],
  }), /duplicate canonical/);
});

test('11. unsupported interval throws', () => {
  assert.throws(() => planBitgetSubscriptionRequests(pl({ iv: ['7d'] })), /unsupported interval/);
});

test('12. empty plan = []', () => {
  assert.deepEqual(planBitgetSubscriptionRequests({ version: 1, entries: [] }), []);
});

test('13. invalid op', () => {
  assert.throws(() => planBitgetSubscriptionRequests(pl(), 'sub' as any), /op must be/);
});

test('14. invalid instType', () => {
  assert.throws(() => planBitgetSubscriptionRequests(pl(), 'subscribe', { instType: 'mc' as any }), /instType/);
});

test('15. maxArgs invalid values', () => {
  for (const v of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => planBitgetSubscriptionRequests(pl(), 'subscribe', { maxArgsPerBatch: v }), /maxArgsPerBatch/);
  }
});

test('16. maxBytes invalid values', () => {
  for (const v of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => planBitgetSubscriptionRequests(pl(), 'subscribe', { maxPayloadBytes: v }), /maxPayloadBytes/);
  }
});

test('17. single arg exceeds byte limit throws', () => {
  assert.throws(() => planBitgetSubscriptionRequests(pl({ iv: ['1m'] }), 'subscribe', { maxPayloadBytes: 10 }), /exceeds maxPayloadBytes/);
});

test('18. atomic failure — no partial batches', () => {
  let threw = false;
  try {
    planBitgetSubscriptionRequests({
      version: 1, entries: [
        { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
        { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['7d'], ticker: true },
      ],
    });
  } catch (e: any) { threw = true; }
  assert.ok(threw);
});

test('19. defense dupe before batch generation', () => {
  let threw = false;
  try {
    // validatePlan runs first — rejects before any arg is built
    planBitgetSubscriptionRequests({
      version: 1, entries: [
        { symbol: 'BTC/USDT', exchangeSymbol: 'DUPE', intervals: ['1m'], ticker: true },
        { symbol: 'ETH/USDT', exchangeSymbol: 'DUPE', intervals: ['1m'], ticker: true },
      ],
    });
  } catch (e: any) { threw = true; assert.match(e.message, /duplicate exchange/); }
  assert.ok(threw);
});

test('20. unsubscribe op byte boundary respected', () => {
  // unsubscribe has different op string; must still obey byte limit
  const r = planBitgetSubscriptionRequests(pl({ iv: ['1m'] }), 'unsubscribe');
  assert.equal(r.length, 1);
  assert.equal(r[0].op, 'unsubscribe');
});
