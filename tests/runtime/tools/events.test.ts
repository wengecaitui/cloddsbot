// Stage 2B-1.7: AgentToolEvent tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { createInMemoryEventSink } from '../../../src/runtime/tools/events';
import type { AgentToolEvent } from '../../../src/runtime/tools/events';

void describe('InMemoryEventSink', () => {
  void it('collects started/completed/failed events', () => {
    const sink = createInMemoryEventSink();
    sink.emit({ schemaVersion: '1.0', type: 'tool.started', runId: 'r', callId: 'c', sequence: 1, timestamp: 1000, toolName: 't' });
    sink.emit({ schemaVersion: '1.0', type: 'tool.completed', runId: 'r', callId: 'c', sequence: 2, timestamp: 1100, toolName: 't', latencyMs: 100, ok: true });
    sink.emit({ schemaVersion: '1.0', type: 'tool.failed', runId: 'r', callId: 'c', sequence: 3, timestamp: 1200, toolName: 't', errorCode: 'TOOL_TIMEOUT', errorMessage: 'timeout' });
    assert.strictEqual(sink.events.length, 3);
    assert.strictEqual(sink.events[0].type, 'tool.started');
    assert.strictEqual(sink.events[1].type, 'tool.completed');
    assert.strictEqual(sink.events[2].type, 'tool.failed');
  });

  void it('preserves all required event fields', () => {
    const sink = createInMemoryEventSink();
    const ev: AgentToolEvent = {
      schemaVersion: '1.0', type: 'tool.started',
      runId: 'my_run', callId: 'call_123', sequence: 1, timestamp: 5000, toolName: 'my_tool',
    };
    sink.emit(ev);
    const got = sink.events[0];
    assert.strictEqual(got.schemaVersion, '1.0');
    assert.strictEqual(got.runId, 'my_run');
    assert.strictEqual(got.callId, 'call_123');
    assert.strictEqual(got.sequence, 1);
    assert.strictEqual(got.timestamp, 5000);
    assert.strictEqual(got.toolName, 'my_tool');
  });

  void it('sink instances do not share state', () => {
    const a = createInMemoryEventSink();
    const b = createInMemoryEventSink();
    a.emit({ schemaVersion: '1.0', type: 'tool.started', runId: 'r', callId: 'c', sequence: 1, timestamp: 0, toolName: 't' });
    assert.strictEqual(a.events.length, 1);
    assert.strictEqual(b.events.length, 0);
  });

  void it('no global event storage on creation', () => {
    const sink = createInMemoryEventSink();
    assert.strictEqual(sink.events.length, 0);
  });

  void it('supports completed union fields', () => {
    const sink = createInMemoryEventSink();
    const ev: AgentToolEvent = {
      schemaVersion: '1.0', type: 'tool.completed',
      runId: 'r', callId: 'c', sequence: 2, timestamp: 500, toolName: 'x', latencyMs: 50, ok: true,
    };
    sink.emit(ev);
    const got = sink.events[0];
    if (got.type === 'tool.completed') {
      assert.strictEqual(got.latencyMs, 50);
      assert.strictEqual(got.ok, true);
    } else {
      assert.fail('expected tool.completed');
    }
  });

  void it('supports failed union fields', () => {
    const sink = createInMemoryEventSink();
    const ev: AgentToolEvent = {
      schemaVersion: '1.0', type: 'tool.failed',
      runId: 'r', callId: 'c', sequence: 3, timestamp: 600, toolName: 'x', errorCode: 'TOOL_ERROR', errorMessage: 'failed',
    };
    sink.emit(ev);
    const got = sink.events[0];
    if (got.type === 'tool.failed') {
      assert.strictEqual(got.errorCode, 'TOOL_ERROR');
      assert.strictEqual(got.errorMessage, 'failed');
    } else {
      assert.fail('expected tool.failed');
    }
  });
});
