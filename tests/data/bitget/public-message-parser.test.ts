// Stage 3B2A-R1: Bitget Public Message Parser tests (hardened)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBitgetPublicMessage } from '../../../src/data/bitget/PublicMessageParser';

const TICKER_ROW = { lastPr: '100', bidPr: '99', askPr: '101', baseVolume: '500', high24h: '110', low24h: '90', ts: '1000' };
const TICKER_ENV = { action: 'snapshot', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }, data: [TICKER_ROW] };
const CANDLE_ROW = ['1000', '100', '200', '50', '150', '1000', '2000', '3000'];
const CANDLE_ENV = { action: 'update', arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' }, data: [CANDLE_ROW] };

test('P1. pong', () => { assert.equal(parseBitgetPublicMessage('pong').kind, 'pong'); });

test('P2. subscribe ack', () => {
  const f = parseBitgetPublicMessage({ event: 'subscribe', arg: { instType:'USDT-FUTURES', channel:'ticker', instId:'BTCUSDT' } });
  assert.equal(f.kind, 'ack');
});

test('P3. error frame', () => {
  const f = parseBitgetPublicMessage({ event:'error', code:'30003', msg:'no symbol' });
  assert.equal(f.kind, 'error');
});

test('P4. error absent arg accepted', () => {
  const f = parseBitgetPublicMessage({ event:'error', code:'X', msg:'y' });
  assert.equal(f.kind, 'error');
  if (f.kind === 'error') assert.equal(f.arg, undefined);
});

test('P5. error with invalid present arg → malformed', () => {
  const f = parseBitgetPublicMessage({ event:'error', code:'X', msg:'y', arg: { instType:'WRONG' } });
  assert.equal(f.kind, 'malformed');
});

test('P6. wrong instType ack → malformed', () => {
  const f = parseBitgetPublicMessage({ event:'subscribe', arg: { instType:'mc', channel:'ticker', instId:'BTCUSDT' } });
  assert.equal(f.kind, 'malformed');
});

test('P7. wrong instType data → malformed', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg: { instType:'SP', channel:'ticker', instId:'BTCUSDT' }, data:[] });
  assert.equal(f.kind, 'malformed');
});

test('P8. empty channel → malformed', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg: { instType:'USDT-FUTURES', channel:'', instId:'B' }, data:[] });
  assert.equal(f.kind, 'malformed');
});

test('P9. empty instId → malformed', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg: { instType:'USDT-FUTURES', channel:'ticker', instId:'' }, data:[] });
  assert.equal(f.kind, 'malformed');
});

test('P10. whitespace instId → malformed', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg: { instType:'USDT-FUTURES', channel:'ticker', instId:'BTC USD' }, data:[] });
  assert.equal(f.kind, 'malformed');
});

test('P11. ticker success V2 fields', () => {
  const f = parseBitgetPublicMessage(TICKER_ENV);
  assert.equal(f.kind, 'data');
  if (f.kind === 'data') { assert.equal(f.events.length, 1); const e = f.events[0]; if (e.kind === 'ticker') { assert.equal(e.last, 100); assert.equal(e.ts, 1000); } }
});

test('P12. ticker multi rows', () => {
  const f = parseBitgetPublicMessage({ action:'update', arg:{ instType:'USDT-FUTURES', channel:'ticker', instId:'B' }, data:[TICKER_ROW, TICKER_ROW] });
  if (f.kind === 'data') assert.equal(f.events.length, 2);
});

test('P13. ticker empty numeric string rejected', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg:{ instType:'USDT-FUTURES', channel:'ticker', instId:'B' }, data:[{ lastPr:'', bidPr:'99', askPr:'101', baseVolume:'500', high24h:'110', low24h:'90', ts:'1000' }] });
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P14. ticker whitespace string rejected', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg:{ instType:'USDT-FUTURES', channel:'ticker', instId:'B' }, data:[{ lastPr:'  ', bidPr:'99', askPr:'101', baseVolume:'500', high24h:'110', low24h:'90', ts:'1000' }] });
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P15. ticker NaN rejected', () => {
  ['bad','NaN','Infinity'].forEach(v => {
    const f = parseBitgetPublicMessage({ action:'snapshot', arg:{ instType:'USDT-FUTURES', channel:'ticker', instId:'B' }, data:[{ ...TICKER_ROW, lastPr: v }] });
    if (f.kind === 'data') assert.equal(f.events.length, 0, `rejected ${v}`);
  });
});

test('P16. ticker missing field drops', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg:{ instType:'USDT-FUTURES', channel:'ticker', instId:'B' }, data:[{ lastPr:'1' }] });
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P17. ticker instId match/mismatch', () => {
  // match
  const f = parseBitgetPublicMessage({ ...TICKER_ENV, data:[{ ...TICKER_ROW, instId:'BTCUSDT' }] });
  if (f.kind === 'data') assert.equal(f.events.length, 1);
  // mismatch → discard
  const f2 = parseBitgetPublicMessage({ ...TICKER_ENV, data:[{ ...TICKER_ROW, instId:'ETHUSDT' }] });
  if (f2.kind === 'data') assert.equal(f2.events.length, 0);
  // non-string instId → discard
  const f3 = parseBitgetPublicMessage({ ...TICKER_ENV, data:[{ ...TICKER_ROW, instId: 42 }] });
  if (f3.kind === 'data') assert.equal(f3.events.length, 0);
});

test('P18. candle success', () => {
  const f = parseBitgetPublicMessage(CANDLE_ENV);
  if (f.kind === 'data') { assert.equal(f.events.length, 1); const e = f.events[0]; if (e.kind === 'candle') { assert.equal(e.open, 100); assert.equal(e.startTs, 1000); assert.equal(e.interval, '1m'); } }
});

test('P19. candle snapshot/update no confirm', () => {
  for (const action of ['snapshot', 'update']) {
    const f = parseBitgetPublicMessage({ ...CANDLE_ENV, action });
    if (f.kind === 'data') { assert.equal(f.action, action); for (const e of f.events) assert.ok(!('confirm' in (e as any))); }
  }
});

test('P20. candle missing columns', () => {
  const f = parseBitgetPublicMessage({ ...CANDLE_ENV, data:[['1000']] });
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P21. candle non-finite', () => {
  const f = parseBitgetPublicMessage({ ...CANDLE_ENV, data:[['bad','NaN','Infinity','','','','','']] });
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P22. candle negative timestamp', () => {
  const f = parseBitgetPublicMessage({ ...CANDLE_ENV, data:[['-100','100','200','50','150','1000','2000','3000']] });
  if (f.kind === 'data') assert.equal(f.events.length, 0);
});

test('P23. unknown candle channel → ignored', () => {
  const f = parseBitgetPublicMessage({ action:'snapshot', arg:{ instType:'USDT-FUTURES', channel:'candle7d', instId:'B' }, data:[] });
  assert.equal(f.kind, 'ignored');
});

test('P24. malformed JSON string', () => {
  assert.equal(parseBitgetPublicMessage('{{').kind, 'malformed');
});

test('P25. junk input', () => {
  for (const v of [null, 42, undefined, []]) {
    assert.equal(parseBitgetPublicMessage(v).kind, 'malformed');
  }
});

test('P26. input not mutated', () => {
  const clone = JSON.parse(JSON.stringify(TICKER_ENV));
  parseBitgetPublicMessage(TICKER_ENV);
  assert.deepEqual(TICKER_ENV, clone);
});

test('P27. bad row does not affect valid row', () => {
  const f = parseBitgetPublicMessage({ ...CANDLE_ENV, data: [['bad'], CANDLE_ROW] });
  if (f.kind === 'data') assert.equal(f.events.length, 1);
});

test('P28. output has no confirm', () => {
  const outputs = [parseBitgetPublicMessage('pong'), parseBitgetPublicMessage({ event:'subscribe', arg:{ instType:'USDT-FUTURES', channel:'t', instId:'B' } }), parseBitgetPublicMessage(CANDLE_ENV)];
  for (const o of outputs) {
    assert.ok(!('confirm' in (o as any)));
    if (o.kind === 'data') for (const e of o.events) assert.ok(!('confirm' in (e as any)));
  }
});
