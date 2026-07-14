// Stage 2B-2B: registerPilotTools registration helper tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createToolRegistry } from '../../../../src/runtime/tools';
import { registerPilotTools } from '../../../../src/runtime/tools/pilot/register-pilot-tools';
import type { PilotToolDependencies } from '../../../../src/runtime/tools/pilot/register-pilot-tools';
import type { IndicatorResult, Series } from '../../../../src/runtime/tools';

const fakePort: PilotToolDependencies['indicatorCalculation'] = {
  async calculateAll(_req: { asset: string; series?: Series[] }): Promise<IndicatorResult[]> {
    return [{ name: 'HullSuite', hma: 67100 }] as unknown as IndicatorResult[];
  },
};

void describe('registerPilotTools', () => {
  void it('1. registers calculate_indicators exactly', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    assert.strictEqual(registry.has('calculate_indicators'), true);
    assert.deepStrictEqual(registry.list(), ['calculate_indicators']);
  });

  void it('2. schemaList exposes calculate_indicators', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    const schemas = registry.schemaList();
    assert.strictEqual(schemas.length, 1);
    assert.strictEqual(schemas[0].function.name, 'calculate_indicators');
  });

  void it('3. duplicate registration throws', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    assert.throws(() => registerPilotTools(registry, { indicatorCalculation: fakePort }));
  });

  void it('4. does not freeze registry', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    assert.strictEqual(registry.isFrozen(), false);
  });

  void it('5. registry still accepts other tools after helper', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    const dummy = { name: 'dummy', version: '1.0.0', description: '', riskClass: 'COMPUTE', timeoutMs: 1000, idempotent: true, requiresApproval: false, parameters: {}, validateInput: (i: unknown) => i, handler: async () => ({}) };
    assert.doesNotThrow(() => registry.register(dummy));
    assert.strictEqual(registry.has('dummy'), true);
  });

  void it('6. frozen registry throws on helper', () => {
    const registry = createToolRegistry();
    registry.freeze();
    assert.throws(() => registerPilotTools(registry, { indicatorCalculation: fakePort }));
  });

  void it('7. two registries do not leak state', () => {
    const r1 = createToolRegistry();
    const r2 = createToolRegistry();
    registerPilotTools(r1, { indicatorCalculation: fakePort });
    assert.strictEqual(r2.has('calculate_indicators'), false);
    assert.strictEqual(r2.list().length, 0);
  });

  void it('8. two independent calls share no module state', () => {
    const r1 = createToolRegistry();
    const r2 = createToolRegistry();
    registerPilotTools(r1, { indicatorCalculation: fakePort });
    registerPilotTools(r2, { indicatorCalculation: fakePort });
    assert.strictEqual(r1.has('calculate_indicators'), true);
    assert.strictEqual(r2.has('calculate_indicators'), true);
  });

  void it('9. tool has correct risk class', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    const spec = registry.get('calculate_indicators')!;
    assert.strictEqual(spec.riskClass, 'COMPUTE');
  });

  void it('10. tool has correct timeout', () => {
    const registry = createToolRegistry();
    registerPilotTools(registry, { indicatorCalculation: fakePort });
    const spec = registry.get('calculate_indicators')!;
    assert.strictEqual(spec.timeoutMs, 3000);
  });
});
