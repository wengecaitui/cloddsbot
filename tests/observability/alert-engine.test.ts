import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservableAgentEvent } from '../../src/observability/contracts';
import { createObservableAlertEngine } from '../../src/observability/alert-engine';

function event(overrides: Partial<ObservableAgentEvent> = {}): ObservableAgentEvent {
  return {
    schemaVersion: '1.0', eventId: 'event-1', runId: 'run-1',
    timestamp: '2026-07-16T00:00:00.000Z', actor: 'runtime', source: 'process',
    action: 'runtime.snapshot', riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_OBSERVED',
    ...overrides,
  };
}

test('alert engine flags unhealthy runtime and log errors', () => {
  let tick = 0;
  const engine = createObservableAlertEngine({ now: () => new Date(1_000 + tick++), createId: () => `alert-${tick}` });
  const unhealthy = engine.evaluate(event({ action: 'runtime.degraded', result: { ok: false, summary: 'port unavailable' } }));
  assert.equal(unhealthy[0]?.ruleId, 'runtime-unhealthy');
  assert.equal(unhealthy[0]?.severity, 'critical');
  const log = engine.evaluate(event({ eventId: 'event-2', source: 'log', action: 'log.error' }));
  assert.equal(log[0]?.ruleId, 'hermes-log-error');
  assert.equal(log[0]?.severity, 'warning');
});

test('alert engine correlates approval for R2 and above', () => {
  const engine = createObservableAlertEngine({ createId: () => 'alert' });
  const missing = engine.evaluate(event({ riskClass: 'R3_DESTRUCTIVE_OR_SYSTEM_CHANGE', action: 'system.changed' }));
  assert.equal(missing[0]?.ruleId, 'approval-missing');
  assert.equal(missing[0]?.approval, 'MISSING');
  assert.equal(missing[0]?.severity, 'critical');

  const approved = engine.evaluate(event({ eventId: 'event-2', riskClass: 'R2_STATEFUL_OPERATION', action: 'git.head_changed', approvalId: 'approval-7' }));
  assert.equal(approved.some(alert => alert.ruleId === 'approval-correlated' && alert.approval === 'ID_PRESENT'), true);
  assert.equal(approved.find(alert => alert.ruleId === 'git-head-changed')?.severity, 'info');
});

test('alert engine deduplicates repeated fingerprints and bounds history', () => {
  let now = 0;
  let id = 0;
  const engine = createObservableAlertEngine({ maxAlerts: 2, dedupeWindowMs: 1_000, now: () => new Date(now), createId: () => `alert-${++id}` });
  const first = engine.evaluate(event({ source: 'log', action: 'log.error', target: 'agent.log' }))[0];
  now = 500;
  const repeated = engine.evaluate(event({ eventId: 'event-2', source: 'log', action: 'log.error', target: 'agent.log' }))[0];
  assert.equal(repeated.alertId, first.alertId);
  assert.equal(repeated.occurrences, 2);
  now = 2_000;
  engine.evaluate(event({ eventId: 'event-3', source: 'log', action: 'log.error', target: 'gateway.log' }));
  engine.evaluate(event({ eventId: 'event-4', source: 'log', action: 'log.error', target: 'errors.log' }));
  assert.equal(engine.snapshot().length, 2);
});

test('alert snapshots are defensive copies', () => {
  const engine = createObservableAlertEngine({ createId: () => 'alert-1' });
  engine.evaluate(event({ source: 'log', action: 'log.error' }));
  const snapshot = engine.snapshot();
  snapshot[0].title = 'mutated';
  assert.notEqual(engine.snapshot()[0].title, 'mutated');
});
