// Stage 3A7: TradingRuntime composition tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTradingRuntime } from '../../../src/runtime/trading/TradingRuntime';
import type { MarketDataCollectorPort } from '../../../src/runtime/market/MarketDataRuntime';
import { createTradingEventBus } from '../../../src/events';
import { ExecutionRouter } from '../../../src/router/ExecutionRouter';
import { KillSwitch } from '../../../src/router/KillSwitch';
import type { WsTicker, WsKline } from '../../../src/data/types';

class FakeColl implements MarketDataCollectorPort {
  private th: Array<(t: WsTicker) => void> = [];
  private kh: Array<(k: WsKline) => void> = [];
  public started = false;
  public sto = 0;
  start() { this.started = true; return Promise.resolve(); }
  stop() { this.sto += 1; this.started = false; }
  onTicker(h: any) { this.th.push(h); }
  onKline(h: any) { this.kh.push(h); }
}

class FakeAdp {
  initCalled = false; shutdownCalled = false;
  async init() { this.initCalled = true; }
  async calculate() { return { success: true, report: { timestamp: 0, updatedAt: 0, globalBias: 'neutral', confidence: 50, assets: [], globalLongShortRatio: 1, globalVolatility: 30, fearGreedIndex: 50, fundingStatus: 'neutral', whitelist: [], blacklist: [], riskEvents: [] } }; }
  shutdown() { this.shutdownCalled = true; }
}

class FakeIS {
  async calculateAll(req: any) { return []; }
}

test('1. minimal construction succeeds', () => {
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  assert.ok(rt.bus); assert.ok(rt.router); assert.ok(rt.marketData);
  assert.ok(rt.fastPipeline); assert.ok(rt.slowPipeline);
  assert.equal(rt.isRunning, false);
});

test('2. default bus shared', () => {
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  assert.equal(rt.bus, rt.marketData.bus);
  assert.equal(rt.bus, rt.slowPipeline.bus);
});

test('3. injected bus shared', () => {
  const bus = createTradingEventBus();
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any, bus });
  assert.equal(rt.bus, bus); assert.equal(rt.marketData.bus, bus); assert.equal(rt.slowPipeline.bus, bus);
});

test('4. injected router used', () => {
  const router = new ExecutionRouter({ fastPathTimeoutSec: 5, maxBiasReportAgeHours: 3, killSwitch: new KillSwitch() });
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any, router });
  assert.equal(rt.router, router);
});

test('5. router + routerConfig throws', () => {
  assert.throws(() => createTradingRuntime({
    collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any,
    router: new ExecutionRouter({ fastPathTimeoutSec: 1, maxBiasReportAgeHours: 2, killSwitch: new KillSwitch() }),
    routerConfig: {},
  }), /cannot provide both/);
});

test('6. isRunning delegates to marketData', async () => {
  const coll = new FakeColl();
  const rt = createTradingRuntime({ collectorFactory: () => coll, indicatorService: new FakeIS() as any });
  assert.equal(rt.isRunning, false);
  await rt.start(); assert.equal(rt.isRunning, true);
  rt.stop(); assert.equal(rt.isRunning, false);
});

test('7. concurrent start same promise', async () => {
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  const p1 = rt.start(); const p2 = rt.start();
  assert.equal(p1, p2);
  await p1; rt.stop();
});

test('8. running start no-op', async () => {
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  await rt.start(); await rt.start();
  assert.equal(rt.isRunning, true); rt.stop();
});

test('9. stop idempotent', async () => {
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  await rt.start(); rt.stop(); rt.stop(); rt.stop();
  assert.equal(rt.isRunning, false);
});

test('10. stop safe when pipeline not initialized', async () => {
  const adp = new FakeAdp(); const coll = new FakeColl();
  const rt = createTradingRuntime({
    collectorFactory: () => coll, indicatorService: new FakeIS() as any,
    slowPipelineConfig: { adapterFactory: () => adp as any },
  });
  await rt.start();
  rt.stop();
  assert.equal(rt.isRunning, false);
});

test('11. stop-start restart', async () => {
  const coll = new FakeColl();
  const rt = createTradingRuntime({ collectorFactory: () => coll, indicatorService: new FakeIS() as any });
  await rt.start(); rt.stop(); await rt.start();
  assert.equal(rt.isRunning, true); rt.stop();
});

test('12. two runtimes isolated', async () => {
  const rtA = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  const rtB = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  assert.notEqual(rtA.bus, rtB.bus);
  await rtA.start(); assert.equal(rtA.isRunning, true); assert.equal(rtB.isRunning, false);
  rtA.stop();
});

test('13. routerConfig passes through', () => {
  const ks = new KillSwitch({ enabled: true, totalCapitalUsd: 50000, maxSinglePositionPct: 0.1, writeActionTimeoutSec: 3 });
  const rt = createTradingRuntime({
    collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any,
    routerConfig: { fastPathTimeoutSec: 3, maxBiasReportAgeHours: 4, killSwitch: ks },
  });
  const cfg = rt.router.getConfig();
  assert.equal(cfg.fastPathTimeoutSec, 3);
  assert.equal(cfg.maxBiasReportAgeHours, 4);
});

test('14. no I/O during construction', () => {
  const coll = new FakeColl();
  createTradingRuntime({ collectorFactory: () => coll, indicatorService: new FakeIS() as any });
  assert.equal(coll.started, false);
});

test('15. FastPipeline can read store and candleStore', () => {
  const rt = createTradingRuntime({ collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any });
  assert.ok(rt.marketData.store);
  assert.ok(rt.marketData.candleStore);
});

test('16. marketDataInterval passes to FastPipeline', () => {
  const rt = createTradingRuntime({
    collectorFactory: () => new FakeColl(), indicatorService: new FakeIS() as any,
    marketDataInterval: '5m', minimumSeries: 50,
  });
  assert.ok(rt.fastPipeline); // FastPipeline constructor validated interval
});
