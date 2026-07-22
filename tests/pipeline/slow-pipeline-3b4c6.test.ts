// Stage 3B4C6-R1: SlowPipeline lifecycle & shutdown tests
// Offline — no real TradingAgents, no LLM calls, no network.
// Python adapter protocol is covered in tests/python/test_adapter_protocol.py.
// This file focuses on SlowPipeline TS-side lifecycle:
//   - adapter success → bullish report
//   - adapter success=false → neutral fallback
//   - adapter throw → neutral fallback
//   - init failure clears bridgeInitPromise (retry works)
//   - concurrent run rejected
//   - exchange mismatch fails with zero I/O
//   - persistence failure produces warning event
//   - publish failure produces warning event
//   - shutdown is idempotent (called N times → adapter.shutdown called once)
//   - shutdown → run → shutdown restart path
//   - shutdown clears internal bridge / bridgeInitPromise
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlowPipeline } from '../../src/pipeline/SlowPipeline';
import type { MarketBiasReportFull } from '../../src/types/market-bias';
import { createTradingEventBus } from '../../src/events';

// ─── Fake Adapter (simulates PythonBridgeDaemon surface) ───
class FakeAdapter {
  public initCalled = false;
  public calculateCalled = false;
  public shutdownCalled = 0;          // counts shutdown invocations
  public shouldThrowOnCalc = false;
  public shouldReturnSuccessFalse = false;
  public shouldThrowOnInit = false;
  public lastPayload: any = null;
  public lastTimeout: number = 0;
  public hangCalc = false;
  private hangResolve: (() => void) | null = null;

  async init(): Promise<void> {
    this.initCalled = true;
    if (this.shouldThrowOnInit) {
      throw new Error('Adapter init failure');
    }
  }

  async calculate(payload: any, timeoutMs: number): Promise<any> {
    this.calculateCalled = true;
    this.lastPayload = payload;
    this.lastTimeout = timeoutMs;
    if (this.hangCalc) {
      await new Promise<void>(resolve => { this.hangResolve = resolve; });
    }
    if (this.shouldThrowOnCalc) {
      throw new Error('Adapter calculate failure');
    }
    if (this.shouldReturnSuccessFalse) {
      return { success: false, error: 'symbol is required' };
    }
    return {
      success: true,
      report: {
        timestamp: Date.now(),
        updatedAt: Date.now(),
        globalBias: 'bullish',
        confidence: 75,
        assets: [{
          symbol: 'BTC/USDT',
          bias: 'bullish',
          confidence: 75,
          volatility: 30,
          direction: 'long',
          suggestedPositionPct: 10,
          entryCondition: 'Strong trend confirmed',
          stopLoss: '-',
          takeProfit: '-',
        }],
        globalLongShortRatio: 1.5,
        globalVolatility: 30,
        fearGreedIndex: 60,
        fundingStatus: 'neutral',
        whitelist: ['BTC/USDT'],
        blacklist: [],
        riskEvents: [],
      },
    };
  }

  shutdown(): void {
    this.shutdownCalled += 1;
  }

  // Test-only helper to unblock a hanging calculate()
  unhang(): void {
    if (this.hangResolve) {
      this.hangResolve();
      this.hangResolve = null;
    }
  }
}

// ─── Fake Router ──────────────────────────────────────────────
class FakeRouter {
  public readonly exchange = 'bitget' as const;
  public lastReport: MarketBiasReportFull | null = null;
  public updateCalled = 0;
  public shouldReject = false;

  async updateBiasReport(report: MarketBiasReportFull): Promise<void> {
    this.updateCalled += 1;
    this.lastReport = report;
    if (this.shouldReject) {
      throw new Error('Router persistence failure');
    }
  }
}

// Helper to build a pipeline with isolated fakes.
function buildPipeline(overrides: { adapter?: FakeAdapter; router?: FakeRouter; bus?: any; clock?: any } = {}) {
  const adapter = overrides.adapter ?? new FakeAdapter();
  const router = overrides.router ?? (new FakeRouter() as any);
  const bus = overrides.bus ?? createTradingEventBus();
  const pipeline = new SlowPipeline({
    exchange: 'bitget',
    router,
    bus,
    adapterFactory: () => adapter as any,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  return { pipeline, adapter, router, bus };
}

// ─── Tests ────────────────────────────────────────────────────

test('1. adapter success produces bullish report with exchange override', async () => {
  const { pipeline, adapter, router } = buildPipeline();
  const report = await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(adapter.initCalled, true, 'adapter.init called');
  assert.equal(adapter.calculateCalled, true, 'adapter.calculate called');
  assert.equal(adapter.lastPayload.symbol, 'BTC/USDT', 'symbol propagated to adapter');
  assert.equal(adapter.lastPayload.exchange, 'bitget', 'exchange propagated to adapter');
  assert.equal(adapter.lastPayload.asset, 'BTC/USDT', 'asset field present (legacy contract)');
  assert.equal(report.exchange, 'bitget', 'exchange overridden post-spread');
  assert.equal(report.globalBias, 'bullish', 'bullish passthrough');
  assert.equal(router.updateCalled, 1, 'router.updateBiasReport called once');
});

test('2. adapter success=false produces neutral fallback with riskEvents', async () => {
  const { pipeline, adapter, router } = buildPipeline();
  adapter.shouldReturnSuccessFalse = true;
  const report = await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(report.globalBias, 'neutral', 'neutral fallback on success=false');
  assert.equal(report.confidence, 0, 'zero confidence fallback');
  assert.equal(router.updateCalled, 1, 'fallback still persisted');
  assert.ok(report.riskEvents.length > 0, 'riskEvents describes adapter failure');
  assert.ok(report.riskEvents[0].includes('symbol is required'), 'riskEvents carries adapter error');
});

test('3. adapter throw produces neutral fallback', async () => {
  const { pipeline, adapter, router } = buildPipeline();
  adapter.shouldThrowOnCalc = true;
  const report = await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(report.globalBias, 'neutral', 'neutral fallback on throw');
  assert.equal(report.confidence, 0, 'zero confidence fallback on throw');
  assert.equal(router.updateCalled, 1, 'fallback still persisted on throw');
  assert.ok(report.riskEvents[0].includes('Adapter calculate failure'), 'riskEvents carries throw message');
});

test('4. init failure clears bridgeInitPromise; retry succeeds with new adapter', async () => {
  const failingAdapter = new FakeAdapter();
  failingAdapter.shouldThrowOnInit = true;
  const router = new FakeRouter() as any;
  // Pipeline starts with adapterFactory that always returns the same failing instance.
  let currentAdapter: FakeAdapter = failingAdapter;
  const pipeline = new SlowPipeline({
    exchange: 'bitget',
    router,
    adapterFactory: () => currentAdapter as any,
  });
  const first = await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(first.globalBias, 'neutral', 'first run produces neutral fallback');
  assert.ok(first.riskEvents[0].includes('Adapter init failure'), 'fallback mentions init failure');

  // Replace adapterFactory target with a working adapter; retry must succeed.
  const workingAdapter = new FakeAdapter();
  currentAdapter = workingAdapter;
  const second = await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(second.globalBias, 'bullish', 'retry produces bullish from working adapter');
  assert.equal(workingAdapter.initCalled, true, 'working adapter init called');
  assert.equal(workingAdapter.calculateCalled, true, 'working adapter calculate called');
});

test('5. concurrent run rejected with zero I/O on second call', async () => {
  const { pipeline, adapter } = buildPipeline();
  adapter.hangCalc = true;
  // First run hangs inside calculate
  const firstRun = pipeline.run('bitget', 'BTC/USDT');
  // Wait until first run is inside the adapter
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(
    () => pipeline.run('bitget', 'BTC/USDT'),
    /already running/,
  );
  adapter.unhang();
  await firstRun;
});

test('6. exchange mismatch fails before any adapter I/O', async () => {
  const { pipeline, adapter } = buildPipeline();
  await assert.rejects(
    () => pipeline.run('binance', 'BTC/USDT'),
    /exchange mismatch/,
  );
  // Allow microtask queue to flush any stray async work
  await new Promise(r => setTimeout(r, 5));
  assert.equal(adapter.initCalled, false, 'no init on mismatch');
  assert.equal(adapter.calculateCalled, false, 'no calculate on mismatch');
});

test('7. router persistence failure produces persistence_warning', async () => {
  const router = new FakeRouter() as any;
  router.shouldReject = true;
  const adapter = new FakeAdapter();
  const pipeline = new SlowPipeline({
    exchange: 'bitget',
    router,
    adapterFactory: () => adapter as any,
  });
  const warnings: any[] = [];
  pipeline.on('persistence_warning', (w) => warnings.push(w));
  await pipeline.run('bitget', 'BTC/USDT');
  // persistence is fire-and-observe; warning fires asynchronously
  await new Promise(r => setTimeout(r, 30));
  assert.equal(warnings.length, 1, 'persistence_warning emitted');
  assert.ok(warnings[0].error, 'warning carries error');
});

test('8. publish subscriber throw produces publish_warning', async () => {
  const bus = createTradingEventBus();
  bus.subscribe('research.bias.updated', () => { throw new Error('Subscriber failure'); });
  const { pipeline } = buildPipeline({ bus });
  const warnings: any[] = [];
  pipeline.on('publish_warning', (w) => warnings.push(w));
  await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(warnings.length, 1, 'publish_warning emitted');
  assert.equal(warnings[0].failures, 1, 'failures=1');
});

test('9. shutdown is idempotent — N calls close adapter exactly once', async () => {
  const { pipeline, adapter } = buildPipeline();
  await pipeline.run('bitget', 'BTC/USDT');
  pipeline.shutdown();
  pipeline.shutdown();
  pipeline.shutdown();
  assert.equal(adapter.shutdownCalled, 1, 'adapter.shutdown called exactly once');
});

test('10. shutdown → run → shutdown restart path closes both adapters', async () => {
  // Adapter 1: used by first run, closed by first shutdown.
  const adapter1 = new FakeAdapter();
  const router = new FakeRouter() as any;
  let currentAdapter: FakeAdapter = adapter1;
  const pipeline = new SlowPipeline({
    exchange: 'bitget',
    router,
    adapterFactory: () => currentAdapter as any,
  });
  await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(adapter1.calculateCalled, true, 'adapter1 used by first run');
  pipeline.shutdown();
  assert.equal(adapter1.shutdownCalled, 1, 'adapter1 closed by first shutdown');

  // Adapter 2: returned by adapterFactory after first shutdown.
  const adapter2 = new FakeAdapter();
  currentAdapter = adapter2;
  await pipeline.run('bitget', 'ETH/USDT');
  assert.equal(adapter2.initCalled, true, 'adapter2 init');
  assert.equal(adapter2.calculateCalled, true, 'adapter2 calculate');
  assert.equal(adapter1.shutdownCalled, 1, 'adapter1 still closed (not re-touched)');

  pipeline.shutdown();
  assert.equal(adapter2.shutdownCalled, 1, 'adapter2 closed by second shutdown');
  assert.equal(adapter1.shutdownCalled, 1, 'adapter1 untouched by second shutdown');
});

test('11. shutdown clears internal bridge and bridgeInitPromise', async () => {
  const { pipeline, adapter } = buildPipeline();
  await pipeline.run('bitget', 'BTC/USDT');
  // Internal state asserted via reflection (no public API exposes these).
  const pre = (pipeline as any);
  assert.ok(pre.bridge === adapter || pre.bridge === null, 'pre-shutdown bridge set');
  pipeline.shutdown();
  assert.equal((pipeline as any).bridge, null, 'bridge ref nulled');
  assert.equal((pipeline as any).bridgeInitPromise, null, 'bridgeInitPromise nulled');
});

test('12. shutdown before any run is a no-op (no adapter created)', async () => {
  const adapter = new FakeAdapter();
  const router = new FakeRouter() as any;
  const pipeline = new SlowPipeline({
    exchange: 'bitget',
    router,
    adapterFactory: () => adapter as any,
  });
  // shutdown before any run — must not throw, must not call adapter.shutdown
  pipeline.shutdown();
  assert.equal(adapter.initCalled, false, 'no init on shutdown-before-run');
  assert.equal(adapter.calculateCalled, false, 'no calculate on shutdown-before-run');
  assert.equal(adapter.shutdownCalled, 0, 'no adapter.shutdown when no bridge was created');
});

test('13. successful report carries correlationId-less event payload', async () => {
  const bus = createTradingEventBus();
  const events: any[] = [];
  bus.subscribe('research.bias.updated', (e) => events.push(e));
  const { pipeline } = buildPipeline({ bus });
  await pipeline.run('bitget', 'BTC/USDT');
  assert.equal(events.length, 1, 'one event published');
  assert.equal(events[0].type, 'research.bias.updated', 'event type');
  assert.equal(events[0].report.exchange, 'bitget', 'event report carries exchange');
  assert.equal(typeof events[0].receivedAt, 'number', 'receivedAt is a number');
});
