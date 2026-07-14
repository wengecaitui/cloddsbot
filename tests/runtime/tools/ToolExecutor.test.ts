// Stage 2B-1.7: ToolExecutor tests (A–M)
import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { ToolExecutor } from '../../../src/runtime/tools/ToolExecutor';
import { createToolRegistry } from '../../../src/runtime/tools/ToolRegistry';
import { CloddsToolSafetyAdapter } from '../../../src/runtime/tools/ToolSafetyAdapter';
import { createInMemoryEventSink } from '../../../src/runtime/tools/events';
import type { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry';
import type { ToolSafetyAdapter, ToolSafetyDecision } from '../../../src/runtime/tools/ToolSafetyAdapter';
import type { AgentToolEventSink } from '../../../src/runtime/tools/events';
import type { ToolCall, ToolResult, ToolSpec } from '../../../src/runtime/tools/contracts';

function makeSpec(name: string, overrides?: Partial<ToolSpec>): ToolSpec {
  return {
    name, version: '1.0', description: `tool ${name}`,
    riskClass: 'READ_ONLY', timeoutMs: 1000, idempotent: false, requiresApproval: false,
    parameters: { type: 'object', properties: {} },
    validateInput: (i: unknown) => i,
    handler: async () => 'ok',
    ...overrides,
  };
}
function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return { callId: 'c1', runId: 'r1', toolName: 'tt', arguments: {}, requestedAt: Date.now(), ...overrides };
}

let registry: ToolRegistry;
let safety: ToolSafetyAdapter;
let events: ReturnType<typeof createInMemoryEventSink>;
let executor: ToolExecutor;

function fresh() {
  registry = createToolRegistry();
  safety = new CloddsToolSafetyAdapter();
  events = createInMemoryEventSink();
  executor = new ToolExecutor({ registry, safetyAdapter: safety, eventSink: events, now: () => 1000 });
}

void describe('ToolExecutor A — success', () => {
  beforeEach(() => fresh());

  void it('handler receives validated input and context', async () => {
    let received: any;
    registry.register(makeSpec('tt', { handler: async (input, ctx) => { received = { input, callId: ctx.callId, runId: ctx.runId, hasSignal: !!ctx.signal }; return 'done'; } }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(received.input, {});
    assert.strictEqual(received.callId, 'c1');
    assert.strictEqual(received.runId, 'r1');
    assert.strictEqual(received.hasSignal, true);
  });

  void it('returns complete ToolResult', async () => {
    registry.register(makeSpec('tt'));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.callId, 'c1');
    assert.strictEqual(r.runId, 'r1');
    assert.strictEqual(r.toolName, 'tt');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.content, 'ok');
    assert.ok(r.latencyMs >= 0);
    assert.deepStrictEqual(r.artifactIds, []);
    assert.deepStrictEqual(r.evidenceIds, []);
  });
});

void describe('ToolExecutor B — unknown tool', () => {
  beforeEach(() => fresh());

  void it('returns TOOL_NOT_FOUND', async () => {
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_NOT_FOUND');
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(events.events[0].type, 'tool.failed');
  });
});

void describe('ToolExecutor C — input validation', () => {
  beforeEach(() => fresh());

  void it('INVALID_TOOL_INPUT on validateInput throw', async () => {
    registry.register(makeSpec('tt', { validateInput: () => { throw new Error('bad'); } }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'INVALID_TOOL_INPUT');
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(events.events[0].type, 'tool.failed');
  });
});

void describe('ToolExecutor D — safety deny', () => {
  beforeEach(() => fresh());

  void it('safety deny with TOOL_DISABLED blocks execution, no started event', async () => {
    // LIVE_EXECUTION_DISABLED tools remain registered and are available through
    // get(), has(), and list(), but are excluded from schemaList(). Direct execution
    // reaches ToolSafetyAdapter and is rejected with TOOL_DISABLED.
    const denySafety: ToolSafetyAdapter = {
      beforeExecute: async () => ({ allowed: false, error: { code: 'TOOL_DISABLED', message: 'disabled', retryable: false } }),
      afterExecute: async () => {},
    };
    executor = new ToolExecutor({ registry, safetyAdapter: denySafety, eventSink: events, now: () => 1000 });
    registry.register(makeSpec('tt', { riskClass: 'READ_ONLY' }));
    const r = await executor.executeOne(makeCall({ toolName: 'tt' }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_DISABLED');
    const started = events.events.filter(e => e.type === 'tool.started');
    assert.strictEqual(started.length, 0);
  });
});

void describe('ToolExecutor E — safety adapter exception', () => {
  beforeEach(() => fresh());

  void it('fail-closed on beforeExecute exception', async () => {
    const broken: ToolSafetyAdapter = { beforeExecute: async () => { throw new Error('oops'); }, afterExecute: async () => {} };
    executor = new ToolExecutor({ registry, safetyAdapter: broken, now: () => 1000 });
    registry.register(makeSpec('tt'));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_EXECUTION_FAILED');
  });
});

void describe('ToolExecutor F — handler exception', () => {
  beforeEach(() => fresh());

  void it('handles Error throw', async () => {
    registry.register(makeSpec('tt', { handler: async () => { throw new Error('fail'); } }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_EXECUTION_FAILED');
    assert.ok(!r.error!.message.includes('stack'));
  });

  void it('handles string throw', async () => {
    registry.register(makeSpec('tt', { handler: async () => { throw 'oops'; } }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_EXECUTION_FAILED');
  });
});

void describe('ToolExecutor G — timeout', () => {
  beforeEach(() => fresh());

  void it('returns TOOL_TIMEOUT and fires abort', async () => {
    let aborted = false;
    registry.register(makeSpec('tt', {
      timeoutMs: 50,
      handler: async (_i, ctx) => {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve('done'), 500);
          ctx.signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); resolve('aborted'); });
        });
      },
    }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_TIMEOUT');
    assert.strictEqual(r.error?.retryable, true);
    assert.strictEqual(aborted, true);
  });
});

void describe('ToolExecutor H — output validation', () => {
  beforeEach(() => fresh());

  void it('validateOutput success', async () => {
    registry.register(makeSpec('tt', {
      handler: async () => 'hello',
      validateOutput: (o: unknown) => (o as string).toUpperCase(),
    }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.content, 'HELLO');
  });

  void it('validateOutput failure → INVALID_TOOL_OUTPUT', async () => {
    registry.register(makeSpec('tt', {
      handler: async () => 'x',
      validateOutput: () => { throw new Error('bad output'); },
    }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'INVALID_TOOL_OUTPUT');
  });
});

void describe('ToolExecutor I — content formatting', () => {
  beforeEach(() => fresh());

  void it('formatContent throw yields TOOL_EXECUTION_FAILED', async () => {
    // handler succeeds, but formatContent throws after that
    let afterCalled = 0;
    const logSafety: ToolSafetyAdapter = {
      beforeExecute: async () => ({ allowed: true }),
      afterExecute: async () => { afterCalled++; },
    };
    executor = new ToolExecutor({ registry, safetyAdapter: logSafety, eventSink: events, now: () => 1000 });
    registry.register(makeSpec('tt', {
      handler: async () => 'ok',
      formatContent: () => { throw new Error('formatter internal details'); },
    }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_EXECUTION_FAILED');
    // no stack trace leaked
    assert.ok(!r.error!.message.includes('formatter internal'));
    assert.ok(!r.error!.message.includes('E:\\'));
    // event: started → failed
    assert.strictEqual(events.events.length, 2);
    assert.strictEqual(events.events[0].type, 'tool.started');
    assert.strictEqual(events.events[1].type, 'tool.failed');
    // afterExecute called exactly once
    assert.strictEqual(afterCalled, 1);
    // artifact/evidence empty
    assert.deepStrictEqual(r.artifactIds, []);
    assert.deepStrictEqual(r.evidenceIds, []);
  });
});

void describe('ToolExecutor J — truncation', () => {
  beforeEach(() => fresh());

  void it('truncates content when over limit', async () => {
    executor = new ToolExecutor({ registry, safetyAdapter: safety, eventSink: events, now: () => 1000, maxContentChars: 10 });
    registry.register(makeSpec('tt', { handler: async () => 'abcdefghijklmnop' }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.content.length, 10);
    assert.strictEqual(r.truncated, true);
  });

  void it('no truncation for short content', async () => {
    executor = new ToolExecutor({ registry, safetyAdapter: safety, eventSink: events, now: () => 1000, maxContentChars: 10 });
    registry.register(makeSpec('tt', { handler: async () => 'hi' }));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.content, 'hi');
    assert.strictEqual(r.truncated, false);
  });
});

void describe('ToolExecutor K — events', () => {
  beforeEach(() => fresh());

  void it('success: started → completed', async () => {
    registry.register(makeSpec('tt'));
    await executor.executeOne(makeCall());
    assert.strictEqual(events.events.length, 2);
    assert.strictEqual(events.events[0].type, 'tool.started');
    assert.strictEqual(events.events[1].type, 'tool.completed');
    assert.ok(events.events[1].sequence > events.events[0].sequence);
  });

  void it('handler failure: started → failed', async () => {
    registry.register(makeSpec('tt', { handler: async () => { throw new Error('nope'); } }));
    await executor.executeOne(makeCall());
    assert.strictEqual(events.events.length, 2);
    assert.strictEqual(events.events[0].type, 'tool.started');
    assert.strictEqual(events.events[1].type, 'tool.failed');
  });

  void it('pre-handler failure: failed only, no started', async () => {
    await executor.executeOne(makeCall()); // tt not registered
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(events.events[0].type, 'tool.failed');
  });

  void it('sink exception does not change result', async () => {
    const broken: AgentToolEventSink = { emit: () => { throw new Error('sink fail'); } };
    executor = new ToolExecutor({ registry, safetyAdapter: safety, eventSink: broken, now: () => 1000 });
    registry.register(makeSpec('tt'));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, true); // result unaffected by sink throw
  });
});

void describe('ToolExecutor L — afterExecute', () => {
  beforeEach(() => fresh());

  void it('called on success', async () => {
    let called = false;
    safety = { beforeExecute: async () => ({ allowed: true }), afterExecute: async () => { called = true; } };
    executor = new ToolExecutor({ registry, safetyAdapter: safety, now: () => 1000 });
    registry.register(makeSpec('tt'));
    await executor.executeOne(makeCall());
    assert.strictEqual(called, true);
  });

  void it('not called on pre-handler failure', async () => {
    let called = false;
    safety = { beforeExecute: async () => ({ allowed: true }), afterExecute: async () => { called = true; } };
    executor = new ToolExecutor({ registry, safetyAdapter: safety, now: () => 1000 });
    await executor.executeOne(makeCall()); // unknown tool
    assert.strictEqual(called, false);
  });

  void it('afterExecute exception does not override success result', async () => {
    let afterCalled = 0;
    const errSafety: ToolSafetyAdapter = {
      beforeExecute: async () => ({ allowed: true }),
      afterExecute: async () => { afterCalled++; throw new Error('after fail'); },
    };
    executor = new ToolExecutor({ registry, safetyAdapter: errSafety, eventSink: events, now: () => 1000 });
    registry.register(makeSpec('tt'));
    const r = await executor.executeOne(makeCall());
    assert.strictEqual(r.ok, true); // original success not overridden
    assert.strictEqual(afterCalled, 1); // afterExecute called once
    // still started → completed, only 2 events
    assert.strictEqual(events.events.length, 2);
    assert.strictEqual(events.events[0].type, 'tool.started');
    assert.strictEqual(events.events[1].type, 'tool.completed');
  });
});

void describe('ToolExecutor M — LIVE tool integration', () => {
  beforeEach(() => fresh());

  void it('LIVE_EXECUTION_DISABLED tool is rejected by Safety with correct semantics', async () => {
    // Use real CloddsToolSafetyAdapter, not a fake
    registry.register(makeSpec('lv', { riskClass: 'LIVE_EXECUTION_DISABLED' }));
    // Registry reflects registration
    assert.strictEqual(registry.get('lv')?.name, 'lv');
    assert.strictEqual(registry.has('lv'), true);
    assert.ok(registry.list().includes('lv'));
    // schemaList excludes LIVE
    const schemaNames = registry.schemaList().map(x => x.function.name);
    assert.ok(!schemaNames.includes('lv'));

    // construct executor with real adapter + approval adapter to verify LIVE bypasses it
    let approvalCalled = 0;
    const approval = { evaluate: async () => { approvalCalled++; return { allowed: true }; } };
    let ksCalled = 0;
    const killSwitch = { evaluate: async () => { ksCalled++; return { allowed: true }; } };
    const realSafety = new CloddsToolSafetyAdapter({ approvalAdapter: approval, killSwitchAdapter: killSwitch });
    executor = new ToolExecutor({ registry, safetyAdapter: realSafety, eventSink: events, now: () => 1000 });

    const r = await executor.executeOne(makeCall({ toolName: 'lv' }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error?.code, 'TOOL_DISABLED');
    // handler never called
    // approval never called
    assert.strictEqual(approvalCalled, 0);
    // KillSwitch never called (not opt-in anyway)
    assert.strictEqual(ksCalled, 0);
    // no started, exactly 1 failed
    const started = events.events.filter(e => e.type === 'tool.started');
    assert.strictEqual(started.length, 0);
    const failed = events.events.filter(e => e.type === 'tool.failed');
    assert.strictEqual(failed.length, 1);
    // artifact/evidence empty
    assert.deepStrictEqual(r.artifactIds, []);
    assert.deepStrictEqual(r.evidenceIds, []);
  });
});
