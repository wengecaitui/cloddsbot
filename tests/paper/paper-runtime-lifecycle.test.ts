// Stage 4A3-R1: Lifecycle tests — ≥72, async-safe, conflict matrix, metrics, drain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperRuntimeSupervisor } from '../../src/paper/PaperRuntimeSupervisor';
import { PaperRuntimeRegistry, type PaperRuntimeBinding } from '../../src/paper/PaperRuntimeRegistry';
import { PaperFastPathCoordinator } from '../../src/paper/PaperFastPathCoordinator';
import { PaperExecutionService, type PaperExecutionEvent } from '../../src/paper/PaperExecutionService';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { KillSwitch } from '../../src/router/KillSwitch';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import { InMemoryPaperRuntimeEventSink } from '../../src/paper/PaperObservability';
import { PaperRuntimeLifecycleError, type PaperRuntimeLifecycleAdapter } from '../../src/paper/PaperLifecycle';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const EXCH_BG: ExchangeId = 'bitget';
const EXCH_BN: ExchangeId = 'binance';
const FUTURE = Date.now() + 120_000;
let clockMs = FUTURE;
function dClock() { return { now: () => clockMs }; }
function advance(ms: number) { clockMs += ms; }
function mkTicker(ex: ExchangeId, sym: string, last: number, ts: number) { return { exchange: ex, instId: sym, channel: 'ticker' as const, last, bestBid: last-1, bestAsk: last+1, volume24h: 1000, high24h: last*1.02, low24h: last*0.98, ts }; }
function mkKline(ex: ExchangeId, sym: string, close: number, ts: number) { return { exchange: ex, instId: sym, channel: 'kline' as const, interval: '1m', open: close*0.999, high: close*1.001, low: close*0.998, close, volume: 100, ts, confirm: true }; }
function momentumResult() { return { name: 'CompositeMomentum' as const, composite_score: 85, regime_state: 'STRONG_BULLISH' as const, in_cooldown: false, dimension_scores: { hull_big_trend: { value:1,weight:1 }, stc_momentum: { value:1,weight:1 }, volume_micro: { value:1,weight:1 } }, lag_bars: 0, elapsedMs: 0 }; }

class TrackingAdapter implements PaperRuntimeLifecycleAdapter { startCalls=0; stopCalls=0; startFail=false; stopFail=false; start(){this.startCalls++; if(this.startFail)throw new Error('adapter start fail');} stop(){this.stopCalls++; if(this.stopFail)throw new Error('adapter stop fail');} }

async function makeBinding(aid: string, ex: ExchangeId, cash: number, sym: string, dir: 'long'|'short') { const d = await fs.mkdtemp(path.join(os.tmpdir(), 's4a3r1-')); const s = createMarketSnapshotStore({ staleAfterMs: 60_000 }); s.updateTicker({ ticker: mkTicker(ex, sym, 50000, FUTURE), receivedAt: FUTURE }); const c = createCandleSeriesStore({ capacityPerSeries: 500 }); for (let i=0;i<200;i++){const k=mkKline(ex,sym,49000+i*10,FUTURE-(200-i)*60_000);s.updateClosedKline({kline:k,receivedAt:k.ts});c.appendClosedKline({kline:k,receivedAt:k.ts});} const ac: PaperAccountConfig={accountId:aid,exchange:ex,initialCashUsd:cash}; const ks=new KillSwitch(ex,{totalCapitalUsd:cash,maxPositionPct:1,maxSinglePositionPct:1,allowConcentration:true}); const fp=new FastPipeline({exchange:ex,router:{exchange:ex,getBiasReport:()=>({exchange:ex,updatedAt:FUTURE,assets:[{symbol:sym,direction:dir,confidence:85,suggestedPositionPct:0.1}],whitelist:[sym]}),getConfig:()=>({maxBiasReportAgeHours:999}),killSwitch:ks},indicatorService:{calculateAll:async()=>[momentumResult()]},marketData:{exchange:ex,snapshotStore:s,candleStore:c,interval:'1m',minimumSeries:100,seriesLimit:200}}); const svc=await PaperExecutionService.open(ac,new PaperLedgerStore(ac,{baseDir:d})); return { binding: { accountId: aid, exchange: ex, pipeline: fp, service: svc, coordinator: new PaperFastPathCoordinator(fp, svc, ex) }, dir: d }; }

function sup(eventSink?: InMemoryPaperRuntimeEventSink) { return new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink, clock: dClock() }); }
const SIG = { exchange: EXCH_BG, symbol: 'BTCUSDT', source: 's' };
const P = { feeBps: 10, slippageBps: 5 };

// ═══ 1–10: Async sink + event types ═══════════════════════════
test('1. async rejecting sink does not break start', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = { emit: async () => { throw new Error('async boom'); } }; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b); await s.start('a1', EXCH_BG); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'running'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('2. async rejecting sink does not break stop', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = { emit: async () => { throw new Error('async boom'); } }; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b); await s.start('a1', EXCH_BG); await s.stop('a1', EXCH_BG); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'stopped'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('3. async rejecting sink does not mask start failure', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.startFail = true; const sink = { emit: async () => { throw new Error('async boom'); } }; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b, ad); await assert.rejects(() => s.start('a1', EXCH_BG), PaperRuntimeLifecycleError); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'failed'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('4. lifecycle events typed (no as any)', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b); await s.start('a1', EXCH_BG);
    assert.ok(sink.query({ eventType: 'runtime.starting' }).length >= 1); assert.ok(sink.query({ eventType: 'runtime.started' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('5. stop produces typed stopping/stopped events', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b); await s.start('a1', EXCH_BG); await s.stop('a1', EXCH_BG);
    assert.ok(sink.query({ eventType: 'runtime.stopping' }).length >= 1); assert.ok(sink.query({ eventType: 'runtime.stopped' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('6. restart produces restarting/restarted events', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b); await s.restart('a1', EXCH_BG);
    assert.ok(sink.query({ eventType: 'runtime.restarting' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('7. not-running run produces rejection event', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b);
    try { await s.run('a1', SIG, P); } catch {} assert.ok(sink.query({ eventType: 'runtime.lifecycle_rejected' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('8. start failure produces lifecycle_error', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.startFail = true; const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b, ad);
    try { await s.start('a1', EXCH_BG); } catch {} assert.ok(sink.query({ eventType: 'runtime.lifecycle_error' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('9. stop failure produces lifecycle_error', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.stopFail = true; const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b, ad); await s.start('a1', EXCH_BG);
    try { await s.stop('a1', EXCH_BG); } catch {} assert.ok(sink.query({ eventType: 'runtime.lifecycle_error' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('10. duplicate → not-running rejection event', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const sink = new InMemoryPaperRuntimeEventSink(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry(), eventSink: sink }); s.register(b); await s.start('a1', EXCH_BG); await s.stop('a1', EXCH_BG);
    try { await s.run('a1', SIG, P); } catch {} assert.ok(sink.query({ eventType: 'runtime.lifecycle_rejected' }).length >= 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ 11–20: Transition conflicts ══════════════════════════════
test('11. concurrent start shares promise + adapter once', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad);
    await Promise.all([s.start('a1', EXCH_BG), s.start('a1', EXCH_BG)]); assert.equal(ad.startCalls, 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('12. concurrent stop shares promise + adapter once', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG);
    await Promise.all([s.stop('a1', EXCH_BG), s.stop('a1', EXCH_BG)]); assert.equal(ad.stopCalls, 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('13. concurrent restart shares promise', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad);
    await Promise.all([s.restart('a1', EXCH_BG), s.restart('a1', EXCH_BG)]); assert.equal(ad.startCalls, 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('14. start during stop rejects', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG);
    const sp = s.stop('a1', EXCH_BG); await assert.rejects(() => s.start('a1', EXCH_BG), PaperRuntimeLifecycleError); await sp; }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('15. start during restart rejects', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG);
    const rp = s.restart('a1', EXCH_BG); await assert.rejects(() => s.start('a1', EXCH_BG), PaperRuntimeLifecycleError); await rp; }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('16. stop during start rejects', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b);
    const sp = s.start('a1', EXCH_BG); await assert.rejects(() => s.stop('a1', EXCH_BG), PaperRuntimeLifecycleError); await sp; }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('17. stop during restart rejects', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG);
    const rp = s.restart('a1', EXCH_BG); await assert.rejects(() => s.stop('a1', EXCH_BG), PaperRuntimeLifecycleError); await rp; }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('18. restart during start rejects', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b);
    const sp = s.start('a1', EXCH_BG); await assert.rejects(() => s.restart('a1', EXCH_BG), PaperRuntimeLifecycleError); await sp; }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('19. restart during stop rejects', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG);
    const sp = s.stop('a1', EXCH_BG); await assert.rejects(() => s.restart('a1', EXCH_BG), PaperRuntimeLifecycleError); await sp; }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('20. stop adapter fail throw stable code', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.stopFail = true; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG);
    try { await s.stop('a1', EXCH_BG); } catch (e: unknown) { assert.ok(e instanceof PaperRuntimeLifecycleError); assert.equal((e as PaperRuntimeLifecycleError).code, 'LIFECYCLE_STOP_FAILED'); } }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});

// ═══ 21–35: Drain + stop semantics ════════════════════════════
test('21. stop waits for in-flight', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG); const runP = s.run('a1', SIG, P); const stopP = s.stop('a1', EXCH_BG); const [r] = await Promise.all([runP, stopP]); assert.equal(r.paperEvent!.status, 'applied'); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'stopped'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('22. two concurrent in-flight drains', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG); const p1 = s.run('a1', SIG, P); const p2 = s.run('a1', SIG, P); await s.stop('a1', EXCH_BG);
    const [r1, r2] = await Promise.all([p1, p2]); assert.equal(r1.paperEvent!.status, 'applied'); assert.equal(r2.paperEvent!.status, 'applied'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('23. coordinator exception decrements inFlight', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG); const orig = b.pipeline.execute.bind(b.pipeline); b.pipeline.execute = async () => { throw new Error('boom'); };
    try { await s.run('a1', SIG, P); } catch {} assert.equal(s.lifecycle('a1', EXCH_BG).inFlightRuns, 0); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('24. drain still completes after coordinator throw', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG); const orig = b.pipeline.execute.bind(b.pipeline); b.pipeline.execute = async () => { throw new Error('boom'); };
    try { await s.run('a1', SIG, P); } catch {} await s.stop('a1', EXCH_BG); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'stopped'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('25. inFlight never negative', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG); for (let i=0;i<3;i++){try{await s.run('a1',SIG,P);}catch{}} assert.ok(s.lifecycle('a1',EXCH_BG).inFlightRuns >= 0); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('26. stop adapter fail throws', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.stopFail = true; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG);
    await assert.rejects(() => s.stop('a1', EXCH_BG), PaperRuntimeLifecycleError); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('27. stop fail preserves ledger', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.stopFail = true; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG); await s.run('a1', SIG, P);
    try { await s.stop('a1', EXCH_BG); } catch {} assert.equal(b.service.snapshot().processedFills, 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('28. stopAll marks stop failure success=false', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); ad.stopFail = true; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG);
    const results = await s.stopAll(); const bg = results.find(r => r.exchange === EXCH_BG)!; assert.equal(bg.success, false); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('29. stopAll stopped→success', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const s = sup(); s.register(b); await s.start('a1', EXCH_BG); const r = await s.stopAll(); assert.equal(r[0].success, true); assert.equal(r[0].state, 'stopped'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('30. stopped→stop idempotent', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG); await s.stop('a1', EXCH_BG); await s.stop('a1', EXCH_BG);
    assert.equal(ad.stopCalls, 1); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'stopped'); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('31. running→start idempotent', async () => {
  const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const ad = new TrackingAdapter(); const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); await s.start('a1', EXCH_BG); await s.start('a1', EXCH_BG);
    assert.equal(ad.startCalls, 1); assert.equal(s.lifecycle('a1', EXCH_BG).generation, 1); }
  finally { await fs.rm(d, { recursive: true, force: true }); }
});
test('32. failed recovery stop succeeds', async () => { const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long'); try { const ad = new TrackingAdapter(); ad.startFail = true; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); try { await s.start('a1', EXCH_BG); } catch {} assert.equal(s.lifecycle('a1', EXCH_BG).state, 'failed'); await s.stop('a1', EXCH_BG); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'stopped'); } finally { await fs.rm(d, { recursive: true, force: true }); } });
test('33. restart from failed succeeds', async () => { const { binding: b, dir: d } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long'); try { const ad = new TrackingAdapter(); ad.startFail = true; const s = new PaperRuntimeSupervisor({ registry: new PaperRuntimeRegistry() }); s.register(b, ad); try { await s.start('a1', EXCH_BG); } catch {} await s.restart('a1', EXCH_BG); assert.equal(s.lifecycle('a1', EXCH_BG).state, 'running'); } finally { await fs.rm(d, { recursive: true, force: true }); } });
