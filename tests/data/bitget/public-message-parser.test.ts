// Stage 3B2A: Bitget Public Message Parser tests (fully offline)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBitgetPublicMessage } from '../../../src/data/bitget/PublicMessageParser';

const CANDLE_CHANNEL = 'candle1m';

test('21. pong string', () => {
  const f = parseBitgetPublicMessage('pong');
  assert.equal(f.kind, 'pong');
});

test('22. subscribe ack', () => {
  const f = parseBitgetPublicMessage({
    event: 'subscribe',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
  });
  assert.equal(f.kind, 'ack');
  if (f.kind === 'ack') {
    assert.equal(f.event, 'subscribe');
    assert.equal(f.arg.instId, 'BTCUSDT');
  }
});

test('23. unsubscribe ack', () => {
  const f = parseBitgetPublicMessage({
    event: 'unsubscribe',
    arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' },
  });
  assert.equal(f.kind, 'ack');
  if (f.kind === 'ack') assert.equal(f.event, 'unsubscribe');
});

test('24. error frame', () => {
  const f = parseBitgetPublicMessage({
    event: 'error',
    code: '30003',
    msg: 'Symbol not exists',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'NOPE' },
  });
  assert.equal(f.kind, 'error');
  if (f.kind === 'error') {
    assert.equal(f.code, '30003');
    assert.match(f.message, /Symbol/);
  }
});

test('25. ticker success — V2 fields', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ lastPr: '44962.00', bidPr: '44961', askPr: '44962', baseVolume: '39746', high24h: '45136.50', low24h: '43620.00', ts: '1632470889087' }],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') {
    assert.equal(f.action, 'snapshot');
    assert.equal(f.events.length, 1);
    const e = f.events[0];
    if (e.kind === 'ticker') {
      assert.equal(e.last, 44962);
      assert.equal(e.bestBid, 44961);
      assert.equal(e.bestAsk, 44962);
      assert.equal(e.volume24h, 39746);
      assert.equal(e.high24h, 45136.5);
      assert.equal(e.low24h, 43620);
      assert.equal(e.ts, 1632470889087);
    }
  }
});

test('P26. ticker multi rows', () => {
  const f = parseBitgetPublicMessage({
    action: 'update',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [
      { lastPr: '100', bidPr: '99', askPr: '101', baseVolume: '500', high24h: '110', low24h: '90', ts: '1000' },
      { lastPr: '200', bidPr: '199', askPr: '201', baseVolume: '600', high24h: '210', low24h: '190', ts: '2000' },
    ],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 2);
});

test('P27. ticker uses V2 field names', () => {
  // lastPr, bidPr, askPr — not last, bestBid, bestAsk
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ lastPr: '1', bidPr: '2', askPr: '3', baseVolume: '4', high24h: '5', low24h: '6', ts: '7' }],
  });
  assert.equal(f.kind, 'data');
  // Should NOT parse old field names
  const bad = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ last: '1', bestBid: '2', bestAsk: '3', volume24h: '4', high24h: '5', low24h: '6', systemTime: '7' }],
  });
  if (bad.kind === 'data') assert.equal(bad.events.length, 0, 'old fields rejected');
});

test('P28. ticker missing field drops row', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ lastPr: '100' }],  // missing bidPr, askPr, ...
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P29. ticker instId mismatch drops row', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ instId: 'ETHUSDT', lastPr: '100', bidPr: '99', askPr: '101', baseVolume: '500', high24h: '110', low24h: '90', ts: '1000' }],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P30. ticker NaN values dropped', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ lastPr: 'bad', bidPr: '99', askPr: '101', baseVolume: '500', high24h: '110', low24h: '90', ts: '1000' }],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P31. candle success', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [['1639584000000', '8533.02', '8553.74', '8527.17', '8548.26', '45247', '12345', '67890']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') {
    assert.equal(f.events.length, 1);
    assert.equal(f.action, 'snapshot');
  }
});

test('P32. candle 8-field complete parse', () => {
  const f = parseBitgetPublicMessage({
    action: 'update',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'ETHUSDT' },
    data: [['1000000', '100', '200', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') {
    const e = f.events[0];
    assert.equal(e.kind, 'candle');
    if (e.kind === 'candle') {
      assert.equal(e.startTs, 1000000);
      assert.equal(e.open, 100);
      assert.equal(e.high, 200);
      assert.equal(e.low, 50);
      assert.equal(e.close, 150);
      assert.equal(e.baseVolume, 1000);
      assert.equal(e.quoteVolume, 2000);
      assert.equal(e.usdtVolume, 3000);
      assert.equal(e.interval, '1m'); // reverse-mapped from candle1m
    }
  }
});

test('P33. snapshot preserved, no confirm invented', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [['1000', '100', '200', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') {
    assert.equal(f.action, 'snapshot');
    // Verify NO confirm field
    if (f.events.length > 0) {
      assert.ok(!('confirm' in f.events[0]), 'no confirm field on update');
    }
  }
});

test('P34. update action, no confirm invented', () => {
  const f = parseBitgetPublicMessage({
    action: 'update',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [['1000', '100', '200', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data' && f.events.length > 0) {
    assert.ok(!('confirm' in f.events[0]), 'no confirm on update');
  }
});

test('P35. candle multi rows', () => {
  const f = parseBitgetPublicMessage({
    action: 'update',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [
      ['1000', '100', '200', '50', '150', '1000', '2000', '3000'],
      ['2000', '200', '300', '150', '250', '2000', '3000', '4000'],
    ],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 2);
});

test('P36. candle missing fields drops row', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [['1000', '100']],  // only 2 fields
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P37. candle non-finite values dropped', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [['bad', 'NaN', 'Infinity', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P38. candle startTs must be non-negative safe integer', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [['-1', '100', '200', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P39. exact reverse interval mapping', () => {
  // candle1H → '1h' (lowercase h), candle4H → '4h'
  const f = parseBitgetPublicMessage({
    action: 'update',
    arg: { instType: 'USDT-FUTURES', channel: 'candle4H', instId: 'BTCUSDT' },
    data: [['1000', '100', '200', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data' && f.events.length > 0) {
    const e = f.events[0];
    if (e.kind === 'candle') assert.equal(e.interval, '4h');
  }
});

test('P40. unknown candle channel → ignored', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'candle7d', instId: 'BTCUSDT' },
    data: [['1000', '100', '200', '50', '150', '1000', '2000', '3000']],
  });
  assert.equal(f.kind, 'ignored');
});

test('P41. unknown non-market channel → ignored', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'positions', instId: 'BTCUSDT' },
    data: [1],
  });
  assert.equal(f.kind, 'ignored');
});

test('P42. malformed JSON string → malformed', () => {
  const f = parseBitgetPublicMessage('not-json{{');
  assert.equal(f.kind, 'malformed');
});

test('P43. junk input → malformed', () => {
  const f = parseBitgetPublicMessage(null);
  assert.equal(f.kind, 'malformed');
  const f2 = parseBitgetPublicMessage(42);
  assert.equal(f2.kind, 'malformed');
  const f3 = parseBitgetPublicMessage(undefined);
  assert.equal(f3.kind, 'malformed');
  const f4 = parseBitgetPublicMessage([]);
  assert.equal(f4.kind, 'malformed');
});

test('P44. input object not mutated', () => {
  const input = {
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
    data: [{ lastPr: '1', bidPr: '2', askPr: '3', baseVolume: '4', high24h: '5', low24h: '6', ts: '7' }],
  };
  const clone = JSON.parse(JSON.stringify(input));
  parseBitgetPublicMessage(input);
  assert.deepEqual(input, clone, 'input unchanged');
});

test('P45. one bad row does not affect valid rows', () => {
  const f = parseBitgetPublicMessage({
    action: 'snapshot',
    arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' },
    data: [
      ['bad'],  // bad
      ['1000', '100', '200', '50', '150', '1000', '2000', '3000'],  // good
    ],
  });
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') assert.equal(f.events.length, 1, 'valid row parsed');
});

test('P46. parser output has no confirm field', () => {
  // Test all output kinds — none should ever have 'confirm'
  const outputs = [
    parseBitgetPublicMessage('pong'),
    parseBitgetPublicMessage({ event: 'subscribe', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' } }),
    parseBitgetPublicMessage({ action: 'snapshot', arg: { instType: 'USDT-FUTURES', channel: CANDLE_CHANNEL, instId: 'BTCUSDT' }, data: [['1000', '100', '200', '50', '150', '1000', '2000', '3000']] }),
  ];
  for (const o of outputs) {
    assert.ok(!('confirm' in (o as any)), `kind=${o.kind} has no confirm`);
    if (o.kind === 'data') {
      for (const ev of o.events) {
        assert.ok(!('confirm' in (ev as any)), 'event has no confirm');
      }
    }
  }
});
