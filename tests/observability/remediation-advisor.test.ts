import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservableAlert } from '../../src/observability/alert-engine';
import { createRemediationAdvisor } from '../../src/observability/remediation-advisor';

function alert(ruleId: string, overrides: Partial<ObservableAlert> = {}): ObservableAlert {
  return {
    schemaVersion: '1.0', alertId: `alert-${ruleId}`, ruleId,
    fingerprint: `${ruleId}|action|target`, severity: 'warning', title: 'Alert', message: 'Observed issue',
    firstSeenAt: '2026-07-16T00:00:00.000Z', lastSeenAt: '2026-07-16T00:00:01.000Z',
    occurrences: 1, eventId: 'event-1', action: 'test.action', riskClass: 'R0_READ_ONLY',
    approval: 'NOT_REQUIRED', ...overrides,
  };
}

test('advisor provides evidence-first runtime guidance without auto-fix', () => {
  const advisor = createRemediationAdvisor();
  const recommendation = advisor.recommend(alert('runtime-unhealthy', { severity: 'critical' }));
  assert.equal(recommendation?.priority, 'HIGH');
  assert.equal(recommendation?.status, 'VERIFY_FIRST');
  assert.equal(recommendation?.autoFixAvailable, false);
  assert.equal(recommendation?.steps.some(step => step.includes('只读检查')), true);
  assert.equal(recommendation?.verification.length! > 0, true);
});

test('advisor requires approval for uncorrelated high-risk events', () => {
  const advisor = createRemediationAdvisor();
  const recommendation = advisor.recommend(alert('approval-missing', {
    severity: 'critical', riskClass: 'R3_DESTRUCTIVE_OR_SYSTEM_CHANGE', approval: 'MISSING',
  }));
  assert.equal(recommendation?.status, 'APPROVAL_REQUIRED');
  assert.equal(recommendation?.requiresApproval, true);
});

test('advisor updates duplicate recommendations and bounds snapshots', () => {
  const advisor = createRemediationAdvisor(2);
  advisor.recommend(alert('hermes-log-error'));
  advisor.recommend(alert('git-head-changed'));
  advisor.recommend(alert('approval-missing'));
  assert.equal(advisor.snapshot().length, 2);
  const copy = advisor.snapshot();
  copy[0].title = 'mutated';
  assert.notEqual(advisor.snapshot()[0].title, 'mutated');
});

test('advisor skips informational alerts without a remediation rule', () => {
  const advisor = createRemediationAdvisor();
  assert.equal(advisor.recommend(alert('approval-correlated', { severity: 'info' })), undefined);
});
