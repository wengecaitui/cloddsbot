import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservableAgentEvent } from '../../src/observability/contracts';
import { createObservabilityDashboardServer } from '../../src/observability/dashboard/dashboard-server';
import type { ObservableAlert } from '../../src/observability/alert-engine';
import { DASHBOARD_HTML, DASHBOARD_JS } from '../../src/observability/dashboard/page';
import { Script } from 'node:vm';
import type { RemediationRecommendation } from '../../src/observability/remediation-advisor';

const event: ObservableAgentEvent = {
  schemaVersion: '1.0', eventId: 'dashboard-event', runId: 'dashboard-test',
  timestamp: '2026-07-16T00:00:00.000Z', actor: 'runtime', source: 'process',
  action: 'runtime.snapshot', riskClass: 'R0_READ_ONLY', evidenceLevel: 'VERIFIED_OBSERVED',
  result: { ok: true },
};
const alert: ObservableAlert = {
  schemaVersion: '1.0', alertId: 'alert-1', ruleId: 'runtime-unhealthy', fingerprint: 'runtime-unhealthy|runtime.snapshot|',
  severity: 'critical', title: 'Runtime unhealthy', message: 'Health probe failed',
  firstSeenAt: event.timestamp, lastSeenAt: event.timestamp, occurrences: 1,
  eventId: event.eventId, action: event.action, riskClass: event.riskClass, approval: 'NOT_REQUIRED',
};
const recommendation: RemediationRecommendation = {
  schemaVersion: '1.0', recommendationId: 'recommendation:alert-1', alertId: alert.alertId,
  ruleId: alert.ruleId, priority: 'HIGH', status: 'VERIFY_FIRST', title: 'Check runtime',
  diagnosis: 'A runtime probe failed', possibleImpact: 'Monitoring may be stale',
  steps: ['Inspect health'], verification: ['Health returns 200'], requiresApproval: false,
  autoFixAvailable: false, evidenceEventId: event.eventId, updatedAt: event.timestamp,
};

test('dashboard serves loopback UI, state and security headers', async () => {
  const dashboard = createObservabilityDashboardServer({
    port: 0,
    stateProvider: () => ({
      totalEvents: 1, lastEventAt: event.timestamp, lastEventId: event.eventId,
      countsByActor: { runtime: 1 }, countsBySource: { process: 1 },
      countsByRisk: { R0_READ_ONLY: 1 }, lastEventBySource: { process: event },
      recentEventIds: [event.eventId],
    }),
    activityProvider: () => ({
      currentTask: {
        taskId: 'task-1', status: 'ACTIVE', firstSeenAt: event.timestamp, lastSeenAt: event.timestamp,
        lastAction: 'tool.completed', toolEvents: 1, errorEvents: 0, workspaceEvents: 0,
        observedProgress: 55,
        stages: { taskObserved: true, toolObserved: true, workspaceChanged: false, completionObserved: false },
      },
      recentTasks: [], lastHermesEventAt: event.timestamp, lastHermesAction: 'tool.completed',
    }),
  });
  try {
    const url = await dashboard.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    dashboard.publish(event);
    dashboard.publishAlert(alert);
    dashboard.publishRecommendation(recommendation);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DSbot · Hermes 控制台/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const state = await fetch(`${url}/api/state`).then(response => response.json()) as {
      monitor: { totalEvents: number };
      recentEvents: ObservableAgentEvent[];
      recentAlerts: ObservableAlert[];
      activity: { currentTask?: { taskId: string } };
      recommendations: RemediationRecommendation[];
    };
    assert.equal(state.monitor.totalEvents, 1);
    assert.equal(state.recentEvents[0]?.eventId, event.eventId);
    assert.equal(state.recentAlerts[0]?.alertId, alert.alertId);
    assert.equal(state.activity.currentTask?.taskId, 'task-1');
    assert.equal(state.recommendations[0]?.recommendationId, recommendation.recommendationId);

    const health = await fetch(`${url}/api/health`).then(response => response.json()) as { ok: boolean };
    assert.equal(health.ok, true);
    const denied = await fetch(`${url}/api/health`, { method: 'POST' });
    assert.equal(denied.status, 405);
  } finally {
    await dashboard.stop();
  }
  assert.equal(dashboard.isRunning, false);
});

test('dashboard browser script is syntactically valid', () => {
  assert.doesNotThrow(() => new Script(DASHBOARD_JS));
});

test('dashboard visible controls are wired to observable interactions', () => {
  assert.match(DASHBOARD_HTML, /id="technicalPanel"/);
  assert.match(DASHBOARD_JS, /function setTechnical/);
  assert.match(DASHBOARD_JS, /querySelector\('\.bell'\)\.addEventListener/);
  assert.match(DASHBOARD_JS, /刷新中…/);
  assert.match(DASHBOARD_JS, /状态已复制/);
  assert.match(DASHBOARD_JS, /querySelectorAll\('\.nav-item'\)/);
  assert.match(DASHBOARD_HTML, /id="dialogCodeExplanation"/);
  assert.match(DASHBOARD_HTML, /原始技术证据（保持原始输出）/);
  assert.match(DASHBOARD_HTML, /id="copyExplanationButton"/);
  assert.match(DASHBOARD_JS, /function evidenceExplanation/);
  assert.match(DASHBOARD_JS, /不能据此推断 Agent 的隐藏思考/);
  assert.match(DASHBOARD_HTML, /id="ambientCanvas"/);
  assert.match(DASHBOARD_JS, /function initAmbient/);
  assert.match(DASHBOARD_JS, /requestAnimationFrame\(draw\)/);
  assert.match(DASHBOARD_JS, /prefers-reduced-motion/);
});

test('dashboard ring buffer remains bounded', async () => {
  const dashboard = createObservabilityDashboardServer({
    port: 0, maxEvents: 2,
    stateProvider: () => ({ totalEvents: 0, countsByActor: {}, countsBySource: {}, countsByRisk: {}, lastEventBySource: {}, recentEventIds: [] }),
  });
  try {
    const url = await dashboard.start();
    dashboard.publish({ ...event, eventId: 'one' });
    dashboard.publish({ ...event, eventId: 'two' });
    dashboard.publish({ ...event, eventId: 'three' });
    const state = await fetch(`${url}/api/state`).then(response => response.json()) as { recentEvents: ObservableAgentEvent[] };
    assert.deepEqual(state.recentEvents.map(item => item.eventId), ['two', 'three']);
  } finally { await dashboard.stop(); }
});
