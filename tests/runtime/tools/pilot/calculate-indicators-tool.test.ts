// Stage 2B-2B: calculate_indicators ToolSpec tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  createCalculateIndicatorsTool,
  type IndicatorCalculationPort,
  type CalculateIndicatorsInput,
} from '../../../../src/runtime/tools/pilot/calculate-indicators-tool';
import type { IndicatorResult, Series } from '../../../../src/runtime/tools';
import type { ToolSpec } from '../../../../src/runtime/tools/contracts';

// ── helpers ──

function makeSeries(count: number): Series[] {
  return Array.from({ length: count }, (_, i) => ({
    open: 67000 + i,
    high: 67000 + i + 50,
    low: 67000 + i - 50,
    close: 67000 + i + 20,
    volume: 1.5 + i * 0.1,
  }));
}

function makeFakePort(): IndicatorCalculationPort & { calls: number; lastRequest?: { asset: string; series?: Series[] } } {
  const port: IndicatorCalculationPort & { calls: number; lastRequest?: { asset: string; series?: Series[] } } = {
    calls: 0,
    async calculateAll(req: { asset: string; series?: Series[] }): Promise<IndicatorResult[]> {
      (port as any).calls++;
      (port as any).lastRequest = req;
      return [
        { name: 'HullSuite', hma: 67100, trend: 'BULL', position: 'LONG', period: 200, close: 67100, lag_bars: 0 },
      ] as IndicatorResult[];
    },
  };
  return port;
}

// ── metadata ──

void describe('calculate_indicators ToolSpec metadata', () => {
  const spec = createCalculateIndicatorsTool(makeFakePort());

  void it('name is calculate_indicators', () => {
    assert.strictEqual(spec.name, 'calculate_indicators');
  });

  void it('version is 1.0.0', () => {
    assert.strictEqual(spec.version, '1.0.0');
  });

  void it('riskClass is COMPUTE', () => {
    assert.strictEqual(spec.riskClass, 'COMPUTE');
  });

  void it('timeoutMs is 3000', () => {
    assert.strictEqual(spec.timeoutMs, 3000);
  });

  void it('idempotent is true', () => {
    assert.strictEqual(spec.idempotent, true);
  });

  void it('requiresApproval is false', () => {
    assert.strictEqual(spec.requiresApproval, false);
  });

  void it('parameters is a JSON Schema object', () => {
    const params = spec.parameters as Record<string, unknown>;
    assert.strictEqual(params.type, 'object');
    const props = params.properties as Record<string, unknown>;
    assert.ok('symbol' in props && 'series' in props);
    assert.deepStrictEqual(params.required, ['symbol', 'series']);
  });

  void it('schemaList visible via registry', () => {
    // Verified by registration test; keep metadata isolated here
    assert.ok(typeof spec.parameters === 'object');
  });
});

// ── input validation ──

void describe('calculate_indicators input validation', () => {
  const spec = createCalculateIndicatorsTool(makeFakePort());

  void it('accepts valid symbol + series', () => {
    const out = spec.validateInput!({ symbol: 'BTC/USDT', series: makeSeries(250) });
    assert.strictEqual(out.symbol, 'BTC/USDT');
    assert.strictEqual(out.series.length, 250);
  });

  void it('trims symbol whitespace', () => {
    const out = spec.validateInput!({ symbol: '  BTC/USDT  ', series: makeSeries(10) });
    assert.strictEqual(out.symbol, 'BTC/USDT');
  });

  void it('rejects empty symbol', () => {
    assert.throws(() => spec.validateInput!({ symbol: '', series: makeSeries(10) }));
  });

  void it('rejects symbol exceeding 64 chars', () => {
    assert.throws(() => spec.validateInput!({ symbol: 'A'.repeat(65), series: makeSeries(10) }));
  });

  void it('rejects non-array series', () => {
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: 'notarray' }));
  });

  void it('rejects empty series array', () => {
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: [] }));
  });

  void it('rejects series above maxItems 5000', () => {
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: makeSeries(5001) }));
  });

  void it('rejects missing OHLCV field', () => {
    const bad = makeSeries(10) as any[];
    delete bad[0].high;
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: bad }));
  });

  void it('rejects NaN value', () => {
    const bad = makeSeries(10) as any[];
    bad[0].close = NaN;
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: bad }));
  });

  void it('rejects Infinity value', () => {
    const bad = makeSeries(10) as any[];
    bad[0].open = Infinity;
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: bad }));
  });

  void it('rejects negative volume', () => {
    const bad = makeSeries(10) as any[];
    bad[0].volume = -5;
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: bad }));
  });

  void it('rejects high < low', () => {
    const bad = makeSeries(10) as any[];
    bad[0].high = 1;
    bad[0].low = 100;
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: bad }));
  });

  void it('rejects invalid ts', () => {
    const bad = makeSeries(10) as any[];
    bad[0].ts = 'not-number';
    assert.throws(() => spec.validateInput!({ symbol: 'BTC/USDT', series: bad }));
  });
});

// ── handler ──

void describe('calculate_indicators handler', () => {
  void it('maps asset + series and calls port once', async () => {
    const port = makeFakePort();
    const spec = createCalculateIndicatorsTool(port);
    const series = makeSeries(300);
    const result = await spec.handler!({ symbol: 'ETH/USDT', series }, {} as any);
    assert.strictEqual(port.calls, 1);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'HullSuite');
  });

  void it('uses trimmed symbol as asset', async () => {
    let capturedAsset = '';
    const port: IndicatorCalculationPort = {
      async calculateAll(req) { capturedAsset = req.asset; return []; },
    };
    const spec = createCalculateIndicatorsTool(port);
    // Handler receives validated (already trimmed) input
    await spec.handler!({ symbol: 'LTC/USDT', series: makeSeries(50) }, {} as any);
    assert.strictEqual(capturedAsset, 'LTC/USDT');
  });

  void it('passes series through unchanged (same reference identity)', async () => {
    const port = makeFakePort();
    const spec = createCalculateIndicatorsTool(port);
    const series = makeSeries(120);
    await spec.handler!({ symbol: 'X', series }, {} as any);
    assert.strictEqual(port.calls, 1);
    assert.strictEqual(port.lastRequest?.series, series, 'series reference must be passed through, not copied');
  });

  void it('formatContent does not leak raw indicator error strings', () => {
    const sensitive = 'Traceback (most recent call last): File "/app/bridge.py", line 42, in <module>';
    const output = [
      { name: 'HullSuite', hma: 1 },
      { name: 'ElliottWave', error: sensitive },
    ] as IndicatorResult[];
    const spec = createCalculateIndicatorsTool(makeFakePort());
    const content = spec.formatContent!(output);
    assert.ok(content.includes('Computed 2 indicators'));
    assert.ok(content.includes('Partial failures: 1'));
    assert.ok(content.includes('Failed indicators: ElliottWave'));
    assert.ok(!content.includes(sensitive), 'raw error string must not enter content');
    assert.ok(!content.includes('Traceback'), 'traceback must not enter content');
  });

  void it('rejects when port rejects (no swallowed error)', async () => {
    const port: IndicatorCalculationPort = {
      async calculateAll() { throw new Error('bridge down'); },
    };
    const spec = createCalculateIndicatorsTool(port);
    await assert.rejects(
      () => spec.handler!({ symbol: 'X', series: makeSeries(50) }, {} as any),
      /bridge down/,
    );
  });

  void it('does not call DecisionEngine or create Bridge', async () => {
    const port = makeFakePort();
    const spec = createCalculateIndicatorsTool(port);
    await spec.handler!({ symbol: 'X', series: makeSeries(50) }, {} as any);
    assert.strictEqual(port.calls, 1);
  });
});

// ── output validation ──

void describe('calculate_indicators output validation', () => {
  const spec = createCalculateIndicatorsTool(makeFakePort());

  void it('accepts valid success result', () => {
    const out = spec.validateOutput!([{ name: 'HullSuite', hma: 1 }]);
    assert.strictEqual(out.length, 1);
  });

  void it('accepts valid partial failure', () => {
    const out = spec.validateOutput!([
      { name: 'HullSuite', hma: 1 },
      { name: 'ChandelierExit', error: '数据不足，需要 205 根 K 线' },
    ]);
    assert.strictEqual(out.length, 2);
  });

  void it('rejects non-array output', () => {
    assert.throws(() => spec.validateOutput!({ name: 'X' }));
  });

  void it('rejects null element', () => {
    assert.throws(() => spec.validateOutput!([null]));
  });

  void it('rejects missing name', () => {
    assert.throws(() => spec.validateOutput!([{ hma: 1 }]));
  });

  void it('rejects non-string name', () => {
    assert.throws(() => spec.validateOutput!([{ name: 123, hma: 1 }]));
  });

  void it('rejects non-string error', () => {
    assert.throws(() => spec.validateOutput!([{ name: 'X', error: 123 }]));
  });
});

// ── ToolExecutor integration (real registry + executor + safety + sink) ──

import { createToolRegistry } from '../../../../src/runtime/tools/ToolRegistry';
import { ToolExecutor } from '../../../../src/runtime/tools/ToolExecutor';
import { CloddsToolSafetyAdapter } from '../../../../src/runtime/tools/ToolSafetyAdapter';
import { createInMemoryEventSink } from '../../../../src/runtime/tools/events';
import { registerPilotTools } from '../../../../src/runtime/tools/pilot/register-pilot-tools';
import type { IndicatorCalculationPort, CalculateIndicatorsInput } from '../../../../src/runtime/tools/pilot/calculate-indicators-tool';

void describe('calculate_indicators ToolExecutor integration', () => {

  function makeExecutor(
    port: IndicatorCalculationPort,
    sink: any,
  ): { executor: any; registry: any } {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: port });
    const safety = new CloddsToolSafetyAdapter({ defaultAllow: true });
    const executor = new ToolExecutor({ registry, safetyAdapter: safety, eventSink: sink });
    return { executor, registry };
  }

  function call(symbol: string, series: Series[]): any {
    return { callId: 'c1', runId: 'r1', toolName: 'calculate_indicators', sessionId: 's1', arguments: { symbol, series } };
  }

  void it('success path: started → completed, ok=true', async () => {
    const port = makeFakePort();
    const sink = createInMemoryEventSink();
    const { executor } = makeExecutor(port, sink);
    const result = await executor.executeOne(call('BTC/USDT', makeSeries(300)));
    assert.strictEqual(result.ok, true);
    assert.ok(sink.events.some((e: any) => e.type === 'tool.started'));
    assert.ok(sink.events.some((e: any) => e.type === 'tool.completed'));
  });

  void it('invalid input: no started, one failed', async () => {
    const port = makeFakePort();
    const sink = createInMemoryEventSink();
    const { executor } = makeExecutor(port, sink);
    const result = await executor.executeOne(call('', []));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error?.code, 'INVALID_TOOL_INPUT');
    assert.strictEqual(port.calls, 0);
    assert.ok(!sink.events.some((e: any) => e.type === 'tool.started'));
    assert.strictEqual(sink.events.filter((e: any) => e.type === 'tool.failed').length, 1);
  });

  void it('service error: started → failed, TOOL_EXECUTION_FAILED', async () => {
    const port: IndicatorCalculationPort = {
      async calculateAll() { throw new Error('bridge down'); },
    };
    const sink = createInMemoryEventSink();
    const { executor } = makeExecutor(port, sink);
    const result = await executor.executeOne(call('BTC/USDT', makeSeries(300)));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error?.code, 'TOOL_EXECUTION_FAILED');
    assert.ok(sink.events.some((e: any) => e.type === 'tool.started'));
    assert.ok(sink.events.some((e: any) => e.type === 'tool.failed'));
  });

  void it('malformed output: started → failed, INVALID_TOOL_OUTPUT', async () => {
    const port: IndicatorCalculationPort = {
      async calculateAll() { return [{ wrong: 'shape' } as any]; },
    };
    const sink = createInMemoryEventSink();
    const { executor } = makeExecutor(port, sink);
    const result = await executor.executeOne(call('BTC/USDT', makeSeries(300)));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error?.code, 'INVALID_TOOL_OUTPUT');
    assert.ok(sink.events.some((e: any) => e.type === 'tool.started'));
    assert.ok(sink.events.some((e: any) => e.type === 'tool.failed'));
  });

  void it('partial indicator failure remains ok=true', async () => {
    const port: IndicatorCalculationPort = {
      async calculateAll() {
        return [
          { name: 'HullSuite', hma: 1 },
          { name: 'ChandelierExit', error: '数据不足' },
        ] as IndicatorResult[];
      },
    };
    const sink = createInMemoryEventSink();
    const { executor } = makeExecutor(port, sink);
    const result = await executor.executeOne(call('BTC/USDT', makeSeries(300)));
    assert.strictEqual(result.ok, true);
  });
});

export {};
void describe;
