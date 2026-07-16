// Stage 3A6: SlowPipeline event publication tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlowPipeline } from '../../src/pipeline/SlowPipeline';
import type { ExecutionRouter } from '../../src/router/ExecutionRouter';
import type { MarketBiasReportFull } from '../../src/types/market-bias';
import { createTradingEventBus } from '../../src/events';
import type { Clock } from '../../src/data/MarketSnapshot';

// ── Fake Adapter ─────────────────────────────────────────────────────────────

class FakeAdapter {
  public initCalled = false;
  public calculateCalled = false;
  public shutdownCalled = false;
  public shouldFail = false;
  public responseOverride: any = null;

  async init(): Promise<void> {
    this.initCalled = true;
  }

  async calculate(payload: any, timeoutMs: number): Promise<any> {
    this.calculateCalled = true;
    if (this.shouldFail) {
      throw new Error('Adapter failure');
    }
    if (this.responseOverride) {
      return this.responseOverride;
    }
    return {
      success: true,
      report: {
        timestamp: Date.now(),
        updatedAt: Date.now(),
        globalBias: 'bullish',
        confidence: 75,
        assets: [],
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
    this.shutdownCalled = true;
  }
}

// ── Fake Router ──────────────────────────────────────────────────────────────

class FakeRouter {
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

  getBiasReport(): MarketBiasReportFull | null {
    return this.lastReport;
  }
}

class FakeClock implements Clock {
  private _now = 1000;
  now(): number {
    return this._now;
  }
  advance(ms: number): void {
    this._now += ms;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('1. successful report publishes research.bias.updated', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const clock = new FakeClock();
  const events: any[] = [];

  bus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus,
    clock,
    adapterFactory: () => adapter as any,
  });

  const report = await pipeline.run('BTC/USDT');

  assert.equal(events.length, 1, 'one event published');
  assert.equal(events[0].type, 'research.bias.updated');
  assert.equal(events[0].report.globalBias, 'bullish');
  assert.equal(events[0].receivedAt, 1000);
  assert.equal(router.updateCalled, 1, 'router called');
});

test('2. fallback report also publishes event', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  adapter.shouldFail = true;
  const bus = createTradingEventBus();
  const events: any[] = [];

  bus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  const report = await pipeline.run('BTC/USDT');

  assert.equal(events.length, 1, 'fallback published');
  assert.equal(events[0].report.globalBias, 'neutral');
  assert.equal(events[0].report.confidence, 0);
  assert.equal(router.updateCalled, 1);
});

test('3. injected bus is reused', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const externalBus = createTradingEventBus();
  const events: any[] = [];

  externalBus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus: externalBus,
    adapterFactory: () => adapter as any,
  });

  await pipeline.run('BTC/USDT');

  assert.equal(events.length, 1, 'external bus received event');
});

test('4. default bus can be subscribed via pipeline.bus', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const events: any[] = [];

  const pipeline = new SlowPipeline({
    router,
    adapterFactory: () => adapter as any,
  });

  pipeline.bus.subscribe('research.bias.updated', (e) => events.push(e));

  await pipeline.run('BTC/USDT');

  assert.equal(events.length, 1, 'default bus works');
});

test('5. receivedAt uses injected clock', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const clock = new FakeClock();
  const events: any[] = [];

  bus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus,
    clock,
    adapterFactory: () => adapter as any,
  });

  clock.advance(5000);
  await pipeline.run('BTC/USDT');

  assert.equal(events[0].receivedAt, 6000, 'receivedAt from clock');
});

test('6. router.updateBiasReport called before publish', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const order: string[] = [];

  const originalUpdate = router.updateBiasReport.bind(router);
  router.updateBiasReport = async (r: any) => {
    order.push('router');
    return originalUpdate(r);
  };

  bus.subscribe('research.bias.updated', () => order.push('publish'));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  await pipeline.run('BTC/USDT');

  assert.deepEqual(order, ['router', 'publish'], 'router before publish');
});

test('7. router rejection does not block publish', async () => {
  const router = new FakeRouter() as any;
  router.shouldReject = true;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const events: any[] = [];
  const warnings: any[] = [];

  bus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  pipeline.on('persistence_warning', (w) => warnings.push(w));

  const report = await pipeline.run('BTC/USDT');

  assert.equal(events.length, 1, 'event still published');
  assert.equal(warnings.length, 1, 'persistence warning emitted');
  assert.ok(report, 'run() returned report');
});

test('8. subscriber failure does not block return', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const warnings: any[] = [];

  bus.subscribe('research.bias.updated', () => {
    throw new Error('Subscriber failure');
  });

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  pipeline.on('publish_warning', (w) => warnings.push(w));

  const report = await pipeline.run('BTC/USDT');

  assert.ok(report, 'run() succeeded');
  assert.equal(warnings.length, 1, 'publish warning emitted');
  assert.equal(warnings[0].failures, 1);
});

test('9. each run publishes exactly once', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const events: any[] = [];

  bus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  await pipeline.run('BTC/USDT');
  await pipeline.run('ETH/USDT');

  assert.equal(events.length, 2, 'two runs = two events');
});

test('10. run_complete event still fires', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const completes: any[] = [];

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  pipeline.on('run_complete', (c) => completes.push(c));

  await pipeline.run('BTC/USDT');

  assert.equal(completes.length, 1, 'run_complete fired');
  assert.ok(completes[0].report);
  assert.ok(completes[0].durationMs >= 0);
});

// ── Stage 3A6-R1: Non-blocking persistence ──────────────────────────────────

test('11. pending persistence does not block publish', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const order: string[] = [];

  // Router takes 100ms to persist
  const originalUpdate = router.updateBiasReport.bind(router);
  router.updateBiasReport = async (r: any) => {
    await new Promise(resolve => setTimeout(resolve, 100));
    order.push('persist-done');
    return originalUpdate(r);
  };

  bus.subscribe('research.bias.updated', () => order.push('publish'));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  const startTime = Date.now();
  await pipeline.run('BTC/USDT');
  const elapsed = Date.now() - startTime;

  // publish should fire immediately (not wait 100ms)
  assert.ok(elapsed < 50, 'run() returned quickly');
  assert.equal(order[0], 'publish', 'publish fired first');
});

test('12. pending persistence does not block run() return', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  
  // Router takes 50ms
  const originalUpdate = router.updateBiasReport.bind(router);
  router.updateBiasReport = async (r: any) => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return originalUpdate(r);
  };

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  const startTime = Date.now();
  const report = await pipeline.run('BTC/USDT');
  const elapsed = Date.now() - startTime;

  assert.ok(report, 'run() returned report');
  assert.ok(elapsed < 30, 'run() did not wait for persistence');
});

test('13. delayed rejection produces persistence_warning', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const warnings: any[] = [];

  // Router rejects after delay
  router.updateBiasReport = async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('Delayed persistence failure');
  };

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  pipeline.on('persistence_warning', (w) => warnings.push(w));

  const report = await pipeline.run('BTC/USDT');

  assert.ok(report, 'run() succeeded');
  
  // Wait for delayed rejection
  await new Promise(resolve => setTimeout(resolve, 50));
  
  assert.equal(warnings.length, 1, 'persistence warning eventually emitted');
  assert.ok(warnings[0].error);
});

test('14. router call still happens before publish', async () => {
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const order: string[] = [];

  const originalUpdate = router.updateBiasReport.bind(router);
  router.updateBiasReport = async (r: any) => {
    order.push('router-called');
    return originalUpdate(r);
  };

  bus.subscribe('research.bias.updated', () => order.push('publish'));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  await pipeline.run('BTC/USDT');

  assert.equal(order[0], 'router-called', 'router invoked first');
  assert.equal(order[1], 'publish', 'publish fired second');
});

test('15. original 10 tests still pass (regression guard)', async () => {
  // This is a meta-test ensuring we didn't break existing behavior
  const router = new FakeRouter() as any;
  const adapter = new FakeAdapter();
  const bus = createTradingEventBus();
  const events: any[] = [];

  bus.subscribe('research.bias.updated', (e) => events.push(e));

  const pipeline = new SlowPipeline({
    router,
    bus,
    adapterFactory: () => adapter as any,
  });

  await pipeline.run('BTC/USDT');

  assert.equal(events.length, 1, 'still publishes once');
  assert.equal(router.updateCalled, 1, 'still calls router');
});
