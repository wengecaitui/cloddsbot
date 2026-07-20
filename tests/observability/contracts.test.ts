import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRiskClass } from '../../src/observability/contracts';

test('risk classes have a strict increasing order', () => {
  assert.ok(compareRiskClass('R0_READ_ONLY', 'R1_REVERSIBLE_WORKSPACE_WRITE') < 0);
  assert.ok(compareRiskClass('R3_DESTRUCTIVE_OR_SYSTEM_CHANGE', 'R2_STATEFUL_OPERATION') > 0);
  assert.equal(compareRiskClass('R4_PRODUCTION_OR_REAL_MONEY', 'R4_PRODUCTION_OR_REAL_MONEY'), 0);
});
