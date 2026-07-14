// Stage 2B-1.7: ToolSafetyAdapter tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { CloddsToolSafetyAdapter } from '../../../src/runtime/tools/ToolSafetyAdapter';
import type { ToolSpec, ToolCall, ToolResult, ToolRiskClass } from '../../../src/runtime/tools/contracts';
import type { ToolSafetyDecision, ApprovalPolicyAdapter, KillSwitchPolicyAdapter } from '../../../src/runtime/tools/ToolSafetyAdapter';

function makeSpec(overrides: Partial<ToolSpec> & { name: string; riskClass: ToolRiskClass }): ToolSpec {
  return {
    version: '1.0',
    description: 'test tool',
    timeoutMs: 1000,
    idempotent: false,
    requiresApproval: false,
    parameters: { type: 'object', properties: {} },
    validateInput: (i: unknown) => i,
    handler: async () => 'ok',
    riskPolicy: undefined,
    ...overrides,
  };
}
function makeCall(): ToolCall {
  return { callId: 'c1', runId: 'r1', toolName: 't', arguments: {}, requestedAt: Date.now() };
}
function makeResult(): ToolResult {
  return { callId: 'c', runId: 'r', toolName: 't', ok: true, latencyMs: 0, truncated: false, content: '', artifactIds: [], evidenceIds: [] };
}

class AllowApproval implements ApprovalPolicyAdapter {
  async evaluate(): Promise<ToolSafetyDecision> { return { allowed: true }; }
}
class DenyApproval implements ApprovalPolicyAdapter {
  async evaluate(): Promise<ToolSafetyDecision> { return { allowed: false, error: { code: 'APPROVAL_DENIED', message: 'no', retryable: true } }; }
}
class AllowKS implements KillSwitchPolicyAdapter {
  async evaluate(): Promise<ToolSafetyDecision> { return { allowed: true }; }
}
class DenyKS implements KillSwitchPolicyAdapter {
  async evaluate(): Promise<ToolSafetyDecision> { return { allowed: false, error: { code: 'KILL_SWITCH_BLOCKED', message: 'blocked', retryable: false } }; }
}

void describe('CloddsToolSafetyAdapter', () => {
  void it('READ_ONLY defaults allow', async () => {
    const r = await new CloddsToolSafetyAdapter().beforeExecute(makeSpec({ name: 'ro', riskClass: 'READ_ONLY' }), makeCall());
    assert.strictEqual(r.allowed, true);
  });
  void it('COMPUTE defaults allow', async () => {
    const r = await new CloddsToolSafetyAdapter().beforeExecute(makeSpec({ name: 'co', riskClass: 'COMPUTE' }), makeCall());
    assert.strictEqual(r.allowed, true);
  });
  void it('LIVE returns TOOL_DISABLED even with allow-all approval', async () => {
    const r = await new CloddsToolSafetyAdapter({ approvalAdapter: new AllowApproval() }).beforeExecute(makeSpec({ name: 'lv', riskClass: 'LIVE_EXECUTION_DISABLED' }), makeCall());
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.error?.code, 'TOOL_DISABLED');
  });
  void it('PERSISTENT_WRITE without adapter → APPROVAL_REQUIRED', async () => {
    const r = await new CloddsToolSafetyAdapter().beforeExecute(makeSpec({ name: 'pw', riskClass: 'PERSISTENT_WRITE' }), makeCall());
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.error?.code, 'APPROVAL_REQUIRED');
  });
  void it('PERSISTENT_WRITE with allow adapter passes', async () => {
    const r = await new CloddsToolSafetyAdapter({ approvalAdapter: new AllowApproval() }).beforeExecute(makeSpec({ name: 'pw', riskClass: 'PERSISTENT_WRITE' }), makeCall());
    assert.strictEqual(r.allowed, true);
  });
  void it('PERSISTENT_WRITE with deny adapter blocked', async () => {
    const r = await new CloddsToolSafetyAdapter({ approvalAdapter: new DenyApproval() }).beforeExecute(makeSpec({ name: 'pw', riskClass: 'PERSISTENT_WRITE' }), makeCall());
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.error?.code, 'APPROVAL_DENIED');
  });
  void it('KillSwitch not called without opt-in', async () => {
    let called = false;
    const a = new CloddsToolSafetyAdapter({ killSwitchAdapter: { evaluate: async () => { called = true; return { allowed: true }; } } });
    await a.beforeExecute(makeSpec({ name: 'ro', riskClass: 'READ_ONLY' }), makeCall());
    assert.strictEqual(called, false);
  });
  void it('KillSwitch called when applyKillSwitch=true', async () => {
    let called = false;
    const a = new CloddsToolSafetyAdapter({ killSwitchAdapter: { evaluate: async () => { called = true; return { allowed: true }; } } });
    await a.beforeExecute(makeSpec({ name: 't', riskClass: 'COMPUTE', riskPolicy: { applyKillSwitch: true } }), makeCall());
    assert.strictEqual(called, true);
  });
  void it('KillSwitch block returns KILL_SWITCH_BLOCKED', async () => {
    const r = await new CloddsToolSafetyAdapter({ killSwitchAdapter: new DenyKS() }).beforeExecute(makeSpec({ name: 't', riskClass: 'COMPUTE', riskPolicy: { applyKillSwitch: true } }), makeCall());
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.error?.code, 'KILL_SWITCH_BLOCKED');
  });
  void it('afterExecute returns Promise and is no-op', async () => {
    const a = new CloddsToolSafetyAdapter();
    const p = a.afterExecute(makeSpec({ name: 't', riskClass: 'READ_ONLY' }), makeCall(), makeResult());
    assert.ok(p instanceof Promise);
    await p;
  });
});
