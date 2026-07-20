import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservableAgentEvent } from '../../src/observability/contracts';
import { createDashboardCollaborationContext } from '../../src/observability/dashboard/collaboration-context';

function makeEvent(eventId: string): ObservableAgentEvent {
  return {
    schemaVersion: '1.0',
    eventId,
    runId: 'collaboration-test',
    timestamp: '2026-07-20T00:00:00.000Z',
    actor: 'runtime',
    source: 'process',
    action: 'runtime.snapshot',
    riskClass: 'R0_READ_ONLY',
    evidenceLevel: 'VERIFIED_OBSERVED',
    after: {
      token: 'should-not-leak',
      message: 'Authorization: Bearer abc.def.ghi',
    },
    result: { ok: true },
  };
}

test('collaboration context is bounded, defensive and redacted at the API boundary', () => {
  const events = [makeEvent('one'), makeEvent('two'), makeEvent('three')];
  const context = createDashboardCollaborationContext({
    generatedAt: '2026-07-20T01:02:03.000Z',
    maxItems: 2,
    monitor: {
      totalEvents: 3,
      countsByActor: { runtime: 3 },
      countsBySource: { process: 3 },
      countsByRisk: { R0_READ_ONLY: 3 },
      lastEventBySource: { process: events[2]! },
      recentEventIds: events.map(event => event.eventId),
    },
    activity: { recentTasks: [] },
    recentEvents: events,
    recentAlerts: [],
    recommendations: [],
  });

  assert.equal(context.generatedAt, '2026-07-20T01:02:03.000Z');
  assert.deepEqual(context.recentEvents.map(event => event.eventId), ['two', 'three']);
  assert.equal((context.recentEvents[0]?.after as { token?: string }).token, '<REDACTED>');
  assert.equal(
    (context.recentEvents[0]?.after as { message?: string }).message,
    'Authorization: <REDACTED> <REDACTED>',
  );
  assert.equal(
    ((context.monitor.lastEventBySource.process?.after) as { token?: string }).token,
    '<REDACTED>',
  );
  assert.equal(context.capabilities.canReadContext, true);
  assert.equal(context.capabilities.canExecuteCommands, false);
  assert.equal(context.safetyBoundary.dashboardDoesNotGrantApproval, true);

  events.push(makeEvent('four'));
  assert.deepEqual(context.recentEvents.map(event => event.eventId), ['two', 'three']);
});

test('collaboration context rejects an invalid item limit', () => {
  assert.throws(() => createDashboardCollaborationContext({
    maxItems: 0,
    monitor: {
      totalEvents: 0,
      countsByActor: {},
      countsBySource: {},
      countsByRisk: {},
      lastEventBySource: {},
      recentEventIds: [],
    },
    activity: { recentTasks: [] },
    recentEvents: [],
    recentAlerts: [],
    recommendations: [],
  }), /positive integer/);
});
