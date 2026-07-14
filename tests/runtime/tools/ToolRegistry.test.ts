// Stage 2B-1.7: ToolRegistry tests
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createToolRegistry } from '../../../src/runtime/tools/ToolRegistry';
import type { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry';
import type { ToolSpec, ToolRiskClass } from '../../../src/runtime/tools/contracts';

function makeSpec(name: string, riskClass: ToolRiskClass = 'READ_ONLY'): ToolSpec {
  return {
    name,
    version: '1.0.0',
    description: `tool ${name}`,
    riskClass,
    timeoutMs: 1000,
    idempotent: true,
    requiresApproval: false,
    parameters: { type: 'object', properties: {} },
    validateInput: (i: unknown) => i,
    handler: async () => 'ok',
  };
}

void describe('ToolRegistry', () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = createToolRegistry();
  });

  void it('registers and get returns spec', () => {
    const s = makeSpec('my_tool');
    reg.register(s);
    assert.strictEqual(reg.get('my_tool'), s);
  });

  void it('has() correct', () => {
    reg.register(makeSpec('alpha'));
    assert.strictEqual(reg.has('alpha'), true);
    assert.strictEqual(reg.has('beta'), false);
  });

  void it('list() returns registered names', () => {
    reg.register(makeSpec('alpha'));
    reg.register(makeSpec('beta'));
    assert.deepStrictEqual(reg.list().sort(), ['alpha', 'beta']);
  });

  void it('rejects invalid name', () => {
    // single char too short (regex requires 2-64 chars)
    assert.throws(() => reg.register(makeSpec('a')));
    // uppercase rejected
    assert.throws(() => reg.register(makeSpec('Bad')));
    // space rejected
    assert.throws(() => reg.register(makeSpec('tool with space')));
  });

  void it('rejects duplicate name', () => {
    reg.register(makeSpec('dup'));
    assert.throws(() => reg.register(makeSpec('dup')));
  });

  void it('rejects registration after freeze', () => {
    reg.register(makeSpec('ok'));
    reg.freeze();
    assert.strictEqual(reg.isFrozen(), true);
    assert.throws(() => reg.register(makeSpec('late')));
  });

  void it('isFrozen() false before freeze', () => {
    assert.strictEqual(reg.isFrozen(), false);
  });

  void it('preserves version metadata', () => {
    const s = makeSpec('vtool');
    s.version = '2.3.4';
    reg.register(s);
    assert.strictEqual(reg.get('vtool')!.version, '2.3.4');
  });

  void it('schemaList outputs OpenAI-compatible function schema', () => {
    reg.register(makeSpec('foo'));
    const list = reg.schemaList();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].type, 'function');
    assert.strictEqual(list[0].function.name, 'foo');
    assert.strictEqual(list[0].function.description, 'tool foo');
  });

  void it('excludes LIVE_EXECUTION_DISABLED from schemaList', () => {
    reg.register(makeSpec('live_tool', 'LIVE_EXECUTION_DISABLED'));
    reg.register(makeSpec('read_tool', 'READ_ONLY'));
    const list = reg.schemaList();
    const names = list.map(x => x.function.name);
    assert.ok(!names.includes('live_tool'));
    assert.ok(names.includes('read_tool'));
  });

  void it('excludes LIVE from schemaList only; has/list/get reflect registration', () => {
    reg.register(makeSpec('live', 'LIVE_EXECUTION_DISABLED'));
    reg.register(makeSpec('ok', 'COMPUTE'));
    assert.strictEqual(reg.get('live')?.name, 'live');
    assert.strictEqual(reg.has('live'), true);
    assert.ok(reg.list().includes('live'));
    const schemaNames = reg.schemaList().map(x => x.function.name);
    assert.ok(!schemaNames.includes('live'));
  });

  void it('get returns null for unknown', () => {
    assert.strictEqual(reg.get('nope'), null);
  });

  void it('registry instances are isolated', () => {
    const r1 = createToolRegistry();
    const r2 = createToolRegistry();
    r1.register(makeSpec('only_r1'));
    assert.strictEqual(r1.has('only_r1'), true);
    assert.strictEqual(r2.has('only_r1'), false);
  });
});
