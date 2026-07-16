// Stage 3B2A: Bitget Subscription Planner tests (fully offline)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBitgetSubscriptionRequests } from '../../../src/data/bitget/SubscriptionPlanner';
import type { SubscriptionPlan } from '../../../src/runtime/market/UniverseManager';

function plan(overrides: Partial<{ ticker: boolean; intervals: string[] }> = {}, exchange = 'BTCUSDT', symbol = 'BTC/USDT'): SubscriptionPlan {
  return {
    version: 1,
    entries: [{
      symbol,
      exchangeSymbol: exchange,
      intervals: overrides.intervals ?? ['1m', '5m'],
      ticker: overrides.ticker ?? true,
    }],
  };
}

const DEFAULT_TICKER = { instType: 'USDT-FUTURES', channel: 'ticker' as const, instId: 'BTCUSDT' };
const CANDLE_1M   = { instType: 'USDT-FUTURES', channel: 'candle1m' as const, instId: 'BTCUSDT' };
const CANDLE_5M   = { instType: 'USDT-FUTURES', channel: 'candle5m' as const, instId: 'BTCUSDT' };

test('1. ticker=true generates ticker arg', () => {
  const r = planBitgetSubscriptionRequests(plan({ ticker: true }));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].args, [DEFAULT_TICKER, CANDLE_1M, CANDLE_5M]);
});

test('2. ticker=false omits ticker arg', () => {
  const r = planBitgetSubscriptionRequests(plan({ ticker: false }));
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].args, [CANDLE_1M, CANDLE_5M]);
});

test('3. single interval', () => {
  const r = planBitgetSubscriptionRequests(plan({ intervals: ['1m'] }));
  assert.deepEqual(r[0].args, [DEFAULT_TICKER, CANDLE_1M]);
});

test('4. multiple intervals', () => {
  const r = planBitgetSubscriptionRequests(plan({ intervals: ['1m', '5m', '1h'] }));
  assert.equal(r[0].args.length, 4); // ticker + candle1m + candle5m + candle1H
});

test('5. multiple symbols', () => {
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p);
  assert.equal(r[0].args.length, 4);
  assert.equal(r[0].args[0].instId, 'BTCUSDT');
  assert.equal(r[0].args[2].instId, 'ETHUSDT');
});

test('6. exact uppercase channel mapping', () => {
  const r = planBitgetSubscriptionRequests(plan({ intervals: ['1h', '4h', '1d', '1w', '1M'], ticker: false }));
  assert.equal(r[0].args.length, 5);
  const chs = r[0].args.map(a => a.channel);
  assert.deepEqual(chs, ['candle1H', 'candle4H', 'candle1D', 'candle1W', 'candle1M']);
});

test('7. deterministic ordering', () => {
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p);
  // BTCUSDT sorts before ETHUSDT
  assert.equal(r[0].args[0].instId, 'BTCUSDT');
  assert.equal(r[0].args[2].instId, 'ETHUSDT');
});

test('8. dedup removes duplicates', () => {
  // Two entries with same exchangeSymbol (same Bitget instId) but diff canonical
  // Both map to same subscription args — dedup should merge
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'SBTC/USDT',  exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'SBTCS/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p);
  assert.equal(r[0].args.length, 2); // 1 ticker + 1 candle (dedup from 2 entries)
  assert.equal(r[0].args.filter(a => a.channel === 'ticker').length, 1);
});

test('9. unsupported interval throws', () => {
  assert.throws(() => planBitgetSubscriptionRequests(plan({ intervals: ['7d'] })),
    /unsupported interval "7d"/);
});

test('10. empty plan returns empty array', () => {
  const r = planBitgetSubscriptionRequests({ version: 1, entries: [] });
  assert.deepEqual(r, []);
});

test('11. subscribe op', () => {
  const r = planBitgetSubscriptionRequests(plan({ intervals: ['1m'] }), 'subscribe');
  assert.equal(r[0].op, 'subscribe');
});

test('12. unsubscribe op', () => {
  const r = planBitgetSubscriptionRequests(plan({ intervals: ['1m'] }), 'unsubscribe');
  assert.equal(r[0].op, 'unsubscribe');
});

test('13. maxArgsPerBatch splits batches', () => {
  // 3 symbols × (ticker + 3 intervals) = 12 args, split at 4
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m', '5m', '1h'], ticker: true },
      { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['1m', '5m', '1h'], ticker: true },
      { symbol: 'SOL/USDT', exchangeSymbol: 'SOLUSDT', intervals: ['1m', '5m', '1h'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p, 'subscribe', { maxArgsPerBatch: 4 });
  assert.equal(r.length, 3, '12 args ÷ 4 = 3 batches');
  assert.equal(r[0].args.length, 4);
  assert.equal(r[1].args.length, 4);
  assert.equal(r[2].args.length, 4);
});

test('14. UTF-8 byte boundary splits batches', () => {
  // Very long exchange symbol + many intervals → will exceed tiny byte limit
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'VERYLONG/USDT', exchangeSymbol: 'VERYLONGUSDT', intervals: ['1m', '5m', '15m', '1h'], ticker: true },
    ],
  };
  const r = planBitgetSubscriptionRequests(p, 'subscribe', { maxArgsPerBatch: 100, maxPayloadBytes: 200 });
  // Should split due to byte limit, not arg count
  assert.ok(r.length > 1, 'split due to byte limit');
});

test('15. single arg exceeds limit throws', () => {
  assert.throws(() => planBitgetSubscriptionRequests(
    plan({ intervals: ['1m'] }),
    'subscribe',
    { maxPayloadBytes: 10 },   // way too small for even 1 arg
  ));
});

test('16. defensive copy', () => {
  const r1 = planBitgetSubscriptionRequests(plan({ intervals: ['1m'] }));
  const r2 = planBitgetSubscriptionRequests(plan({ intervals: ['1m'] }));
  assert.notEqual(r1, r2, 'returned array is new');
  assert.notEqual(r1[0].args, r2[0].args, 'args array is new');
  assert.notEqual(r1[0].args[0], r2[0].args[0], 'arg object is new');
});

test('17. duplicate canonical symbol rejects', () => {
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCPERP', intervals: ['1m'], ticker: true },
    ],
  };
  assert.throws(() => planBitgetSubscriptionRequests(p), /duplicate canonical/);
});

test('18. duplicate exchange symbol is tolerated (dedup handles it)', () => {
  const p: SubscriptionPlan = {
    version: 1,
    entries: [
      { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
      { symbol: 'ETH/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
    ],
  };
  // Should not throw — dedup handles the duplicate exchange
  const r = planBitgetSubscriptionRequests(p);
  assert.ok(r.length > 0, 'produced output despite shared exchange');
});

test('19. invalid version rejects', () => {
  assert.throws(() => planBitgetSubscriptionRequests({ version: 0, entries: [] }), /must be a positive integer/);
  assert.throws(() => planBitgetSubscriptionRequests({ version: -1, entries: [] } as any), /must be a positive integer/);
});

test('20. atomic failure — no partial batches', () => {
  // Invalid entry midway should not produce any output
  let threw = false;
  try {
    planBitgetSubscriptionRequests({
      version: 1,
      entries: [
        { symbol: 'BTC/USDT', exchangeSymbol: 'BTCUSDT', intervals: ['1m'], ticker: true },
        { symbol: 'ETH/USDT', exchangeSymbol: 'ETHUSDT', intervals: ['7d'], ticker: true }, // bad!
        { symbol: 'SOL/USDT', exchangeSymbol: 'SOLUSDT', intervals: ['1m'], ticker: true },
      ],
    });
  } catch (e: any) {
    threw = true;
    assert.match(e.message, /unsupported interval/);
  }
  assert.ok(threw, 'should have thrown; no partial output');
});
