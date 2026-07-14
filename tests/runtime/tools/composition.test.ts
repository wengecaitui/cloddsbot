// Stage 2B-1.7: Composition tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createToolRuntime } from '../../../src/runtime/tools/composition';
import { createToolRegistry } from '../../../src/runtime/tools/ToolRegistry';
import { createInMemoryEventSink } from '../../../src/runtime/tools/events';
import type { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry';
import type { ToolSafetyAdapter } from '../../../src/runtime/tools/ToolSafetyAdapter';
import type { ToolSpec } from '../../../src/runtime/tools/contracts';

// ── helpers ──────────────────────────────────────────────────────────────────

const baseSpec: Omit<ToolSpec, 'name'> = {
  version: '1.0',
  description: 'test tool',
  riskClass: 'READ_ONLY',
  timeoutMs: 1000,
  idempotent: false,
  requiresApproval: false,
  parameters: { type: 'object', properties: {} },
  validateInput: (i: unknown) => i,
  handler: async () => 'ok',
};

const mkSpec = (name: string, riskClass: ToolSpec['riskClass'] = 'READ_ONLY'): ToolSpec => ({
  ...baseSpec,
  name,
  riskClass,
});

void describe('createToolRuntime', () => {
  // ── default instance isolation ──────────────────────────────────────────
  void it('default instances are isolated (registry + executor)', () => {
    const a = createToolRuntime();
    const b = createToolRuntime();
    a.registry.register(mkSpec('only_a'));
    assert.strictEqual(a.registry.has('only_a'), true);
    assert.strictEqual(b.registry.has('only_a'), false);
    assert.notStrictEqual(a.executor, b.executor);
  });

  // ── shared registry ──────────────────────────────────────────────────────
  void it('explicit shared registry — state shared, executor separate', () => {
    const shared = createToolRegistry();
    const a = createToolRuntime({ registry: shared });
    const b = createToolRuntime({ registry: shared });
    a.registry.register(mkSpec('shared_tool'));
    assert.strictEqual(b.registry.has('shared_tool'), true);
    assert.notStrictEqual(a.executor, b.executor);
  });

  // ── freeze behavior ──────────────────────────────────────────────────────
  void it('freezeRegistry: false (default) — not frozen', () => {
    const r = createToolRuntime();
    assert.strictEqual(r.registry.isFrozen(), false);
  });

  void it('freezeRegistry: true — frozen after creation', () => {
    const r = createToolRuntime({ freezeRegistry: true });
    assert.strictEqual(r.registry.isFrozen(), true);
  });

  void it('external registry with freezeRegistry: true', () => {
    const reg = createToolRegistry();
    const r = createToolRuntime({ registry: reg, freezeRegistry: true });
    assert.strictEqual(reg.isFrozen(), true);
  });

  void it('external registry without freezeRegistry remains unfrozen', () => {
    const reg = createToolRegistry();
    createToolRuntime({ registry: reg });
    assert.strictEqual(reg.isFrozen(), false);
  });

  // ── custom adapter injection ─────────────────────────────────────────────
  void it('custom safety adapter is wired', async () => {
    const log: string[] = [];
    const safety: ToolSafetyAdapter = {
      beforeExecute: async () => { log.push('before'); return { allowed: true }; },
      afterExecute: async () => { log.push('after'); },
    };
    const r = createToolRuntime({ safetyAdapter: safety });
    r.registry.register(mkSpec('tt'));
    await r.executor.executeOne({ callId: 'c1', runId: 'r1', toolName: 'tt', arguments: {}, requestedAt: 0 });
    assert.deepStrictEqual(log, ['before', 'after']);
  });

  void it('custom event sink is wired', async () => {
    const ev = createInMemoryEventSink();
    const r = createToolRuntime({ eventSink: ev });
    r.registry.register(mkSpec('tt'));
    await r.executor.executeOne({ callId: 'c1', runId: 'r1', toolName: 'tt', arguments: {}, requestedAt: 0 });
    assert.strictEqual(ev.events.length, 2); // started + completed
  });

  void it('custom clock is wired (smoke)', async () => {
    const ev = createInMemoryEventSink();
    const clock = () => 42;
    const r = createToolRuntime({ eventSink: ev, now: clock });
    r.registry.register(mkSpec('tt'));
    await r.executor.executeOne({ callId: 'c1', runId: 'r1', toolName: 'tt', arguments: {}, requestedAt: 0 });
    assert.strictEqual(ev.events[0].timestamp, 42);
  });

  void it('custom maxContentChars truncates long output', async () => {
    const r = createToolRuntime({ maxContentChars: 5 });
    r.registry.register(mkSpec('tt', 'READ_ONLY'));
    const result = await r.executor.executeOne({ callId: 'c1', runId: 'r1', toolName: 'tt', arguments: {}, requestedAt: 0 });
    assert.strictEqual(result.content.length, 2); // 'ok' is 2 chars, below limit
    assert.strictEqual(result.truncated, false);
  });

  // ── parameter validation (fail-fast) ──────────────────────────────────────
  void it('rejects NaN maxContentChars', () => {
    assert.throws(() => createToolRuntime({ maxContentChars: NaN }));
  });

  void it('rejects Infinity maxContentChars', () => {
    assert.throws(() => createToolRuntime({ maxContentChars: Infinity }));
  });

  void it('rejects 0 maxContentChars', () => {
    assert.throws(() => createToolRuntime({ maxContentChars: 0 }));
  });

  void it('rejects negative maxContentChars', () => {
    assert.throws(() => createToolRuntime({ maxContentChars: -1 }));
  });

  void it('accepts valid positive maxContentChars', () => {
    const r = createToolRuntime({ maxContentChars: 100 });
    assert.strictEqual(r.registry.isFrozen(), false);
  });

  // ── multi-runtime isolation ───────────────────────────────────────────────
  void it('multiple runtimes do not pollute each other', () => {
    const a = createToolRuntime();
    const b = createToolRuntime();
    a.registry.register(mkSpec('tool_a'));
    assert.strictEqual(a.registry.has('tool_a'), true);
    assert.strictEqual(b.registry.has('tool_a'), false);
    assert.notStrictEqual(a.executor, b.executor);
  });
});
