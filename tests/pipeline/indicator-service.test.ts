// Stage 2B-2P-B: IndicatorService CALC contract alignment tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { IndicatorService } from '../../src/pipeline/IndicatorService';
import type { IndicatorResult, IndicatorName } from '../../src/types/indicators';

// ── Fake Bridge ──────────────────────────────────────────────────────────

interface BridgeCall {
  payload: { asset: string; series: unknown[]; indicators: unknown[] };
  timeoutMs: number;
}

function fakeBridge(resolveWith: unknown, rejectWith?: string) {
  return {
    calculate: (payload: { asset: string; series: unknown[]; indicators: unknown[] }, timeoutMs: number) => {
      const call: BridgeCall = { payload, timeoutMs };
      if (rejectWith) return Promise.reject(new Error(rejectWith));
      return Promise.resolve(resolveWith);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

const BASE_SERIES = Array.from({ length: 210 }, (_, i) => ({
  open: 67000 + i * 10,
  high: 67000 + i * 10 + 50,
  low: 67000 + i * 10 - 50,
  close: 67000 + i * 10 + 20,
  volume: 1.5 + i * 0.1,
}));

function makeDataPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: 'CALC_RES',
    correlationId: 'cid-1',
    status: 'SUCCESS',
    asset: 'BTC/USDT',
    data: {
      HullSuite: { name: 'HullSuite', hma: 67100, trend: 'BULL' },
      ChandelierExit: { name: 'ChandelierExit', long_stop: 66800, direction: 'LONG' },
      UTBotAlerts: { name: 'UTBotAlerts', buy: false, sell: false, signal: 'HOLD' },
      STC: { name: 'STC', value: 50 },
      StochasticOverlay: { name: 'StochasticOverlay', k: 60, d: 55 },
      MeanReversion: { name: 'MeanReversion', z_score: 0.5 },
      TrendImpulse: { name: 'TrendImpulse', impulse: 'NEUTRAL' },
      DeltaFlow: { name: 'DeltaFlow', delta: 0.1 },
      ElliottWave: { name: 'ElliottWave', wave: 3 },
      FibonacciEntryBands: { name: 'FibonacciEntryBands', bands: { upper: 68000, lower: 66000 } },
      SRRange: { name: 'SRRange', support: 66500, resistance: 67500 },
      VolumeProfile: { name: 'VolumeProfile', vah: 67300, val: 66900 },
      CompositeMomentum: { name: 'CompositeMomentum', composite_score: 85, regime_state: 'STRONG_BULLISH', in_cooldown: false },
      SmartOrderBlock: { name: 'SmartOrderBlock', has_active_ob: false, ob_strength_weight: 0 },
    },
  };
  return { ...base, ...overrides };
}

async function createService(payload: unknown): Promise<IndicatorResult[]> {
  const bridge = fakeBridge(payload);
  const svc = new IndicatorService(bridge as any);
  return svc.calculateAll({ asset: 'BTC/USDT', series: BASE_SERIES });
}

// ── Tests ────────────────────────────────────────────────────────────────

void describe('IndicatorService CALC contract alignment', () => {

  void it('1. real CALC_RES shape → IndicatorResult[]', async () => {
    const payload = makeDataPayload();
    const results = await createService(payload);
    assert.strictEqual(results.length, 14);
    // first result is HullSuite
    assert.strictEqual(results[0].name, 'HullSuite');
  });

  void it('2. request order is stable', async () => {
    const payload = makeDataPayload();
    // Swap order in data dict — Object.values() follows insertion order
    const data = payload.data as Record<string, unknown>;
    const entries = Object.entries(data);
    entries.reverse();
    const reordered: Record<string, unknown> = {};
    for (const [k, v] of entries) reordered[k] = v;
    payload.data = reordered;

    const results = await createService(payload);
    // Order must follow ALL_INDICATORS, not data dict order
    assert.strictEqual(results[0].name, 'HullSuite');   // expect HullSuite first
    assert.strictEqual(results[13].name, 'SmartOrderBlock'); // SmartOrderBlock last
  });

  void it('3. error result has name injected', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = { error: '数据不足，需要 205 根 K 线' };
    const results = await createService(payload);
    const hull = results.find(r => r.name === 'HullSuite')!;
    assert.strictEqual(hull.name, 'HullSuite');
    assert.strictEqual((hull as any).error, '数据不足，需要 205 根 K 线');
  });

  void it('4. map key overrides inner name', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).CompositeMomentum = { name: 'WrongName', error: 'test' };
    const results = await createService(payload);
    const cm = results.find(r => r.name === 'CompositeMomentum')!;
    assert.strictEqual(cm.name, 'CompositeMomentum');
  });

  void it('5. partial success (success + error mix)', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = { error: '数据不足，需要 205 根 K 线' };
    // CompositeMomentum stays success
    const results = await createService(payload);
    assert.strictEqual(results.length, 14);
    // Error result present
    assert.ok(results.some(r => r.name === 'HullSuite' && !!(r as any).error));
    // Success result present
    const cm = results.find(r => r.name === 'CompositeMomentum')!;
    assert.strictEqual((cm as any).composite_score, 85);
  });

  void it('6. missing indicator key → reject', async () => {
    const payload = makeDataPayload();
    // Remove one key
    delete (payload.data as Record<string, unknown>).SmartOrderBlock;
    await assert.rejects(() => createService(payload));
  });

  void it('7. malformed result → reject: null', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = null;
    await assert.rejects(() => createService(payload));
  });

  void it('7. malformed result → reject: array', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = [];
    await assert.rejects(() => createService(payload));
  });

  void it('7. malformed result → reject: error non-string', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = { error: 123 };
    await assert.rejects(() => createService(payload));
  });

  void it('8. legacy raw.indicators', async () => {
    const payload = { indicators: [{ name: 'HullSuite', hma: 67100 }] };
    const results = await createService(payload);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'HullSuite');
  });

  void it('9. legacy raw array', async () => {
    const payload = [{ name: 'HullSuite', hma: 67100 }];
    const results = await createService(payload);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'HullSuite');
  });

  void it('10. unrecognized payload → throw', async () => {
    const payload = { unexpected: true };
    await assert.rejects(() => createService(payload));
  });

  void it('11. bridge error passthrough', async () => {
    const bridge = fakeBridge(null, 'Python error');
    const svc = new IndicatorService(bridge as any);
    await assert.rejects(
      () => svc.calculateAll({ asset: 'BTC/USDT', series: BASE_SERIES }),
      /Python error/,
    );
  });

  void it('12. request contains asset, series, 14 indicators + pure_numeric_mode + timeout', async () => {
    let captured: BridgeCall | null = null;
    const bridge = {
      calculate: (payload: { asset: string; series: unknown[]; indicators: unknown[] }, timeoutMs: number) => {
        captured = { payload, timeoutMs };
        return Promise.resolve(makeDataPayload());
      },
    };
    const svc = new IndicatorService(bridge as any);
    await svc.calculateAll({ asset: 'ETH/USDT', series: BASE_SERIES });
    assert.ok(captured !== null);
    assert.strictEqual(captured!.payload.asset, 'ETH/USDT');
    assert.strictEqual(captured!.payload.series, BASE_SERIES);
    assert.strictEqual(captured!.payload.indicators.length, 14);
    // Check pure_numeric_mode is set on CompositeMomentum and SmartOrderBlock
    const cm = captured!.payload.indicators.find(i => i.name === 'CompositeMomentum')!;
    assert.deepStrictEqual(cm.params, { pure_numeric_mode: true });
    const sob = captured!.payload.indicators.find(i => i.name === 'SmartOrderBlock')!;
    assert.deepStrictEqual(sob.params, { pure_numeric_mode: true });
    assert.strictEqual(captured!.timeoutMs, 1500);
  });

  void it('13. type narrowing — IndicatorResult union includes failure', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = { error: '数据不足，需要 205 根 K 线' };
    const results = await createService(payload);
    const failures = results.filter(r => (r as any).error !== undefined);
    assert.ok(failures.length >= 1);
  });

  void it('16. success result missing name → reject', async () => {
    const payload = makeDataPayload();
    // CompositeMomentum has no error, no name — unrecognized empty payload
    (payload.data as Record<string, unknown>).CompositeMomentum = { composite_score: 80 };
    await assert.rejects(() => createService(payload));
  });

  void it('17. empty object → reject', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).HullSuite = {};
    await assert.rejects(() => createService(payload));
  });

  void it('18. canonical data is primitive → reject (no legacy fallback)', async () => {
    const payload = { data: 'invalid' };
    await assert.rejects(() => createService(payload));
  });

  void it('19. success result inner wrong name → map key overrides', async () => {
    const payload = makeDataPayload();
    (payload.data as Record<string, unknown>).CompositeMomentum = {
      name: 'WrongName',
      composite_score: 80,
      regime_state: 'STRONG_BULLISH',
      in_cooldown: false,
    };
    const results = await createService(payload);
    const cm = results.find(r => r.name === 'CompositeMomentum')!;
    assert.strictEqual(cm.name, 'CompositeMomentum');
  });
});
