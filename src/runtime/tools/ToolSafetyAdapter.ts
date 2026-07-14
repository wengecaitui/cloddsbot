// =============================================================================
// Stage 2B-1.4: ToolSafetyAdapter — 安全决策边界（依赖注入）
// =============================================================================
//
// 设计意图：
//   - 通过 ApprovalPolicyAdapter / KillSwitchPolicyAdapter 两个注入边界连接
//     CloddsBot 现有 ExecApprovalsManager / KillSwitch，不重写、不耦合单例
//   - 固定决策顺序：LIVE硬拒 → KillSwitch(opt-in) → Approval → allow
//   - 不创建第二套 Approval 数据模型、不写 JSON、不建 EventBus
//   - 不修改 src/permissions/index.ts / src/router/KillSwitch.ts
//
// 依赖方向：contracts → ToolSafetyAdapter（本文件）
// 禁止导入：agents / gateway / cron / skills / trading / PythonBridge / *管理类单例
// =============================================================================

import type { ToolCall, ToolError, ToolResult, ToolSpec } from './contracts';

// ── Decision Type ────────────────────────────────────────────────────────────

export interface ToolSafetyDecision {
  allowed: boolean;
  error?: ToolError;
}

// ── Adapter Boundary Interfaces ──────────────────────────────────────────────
//
// 这些接口是 Adapter boundary —— 由 composition.ts 在装配阶段注入具体实现，
// 本文件不 import ExecApprovalsManager / KillSwitch 单例，避免循环依赖。
// 具体适配器负责委托给现有系统，且不重新实现持久化/风控逻辑。
//

export interface ApprovalPolicyAdapter {
  /**
   * 评估当前 ToolCall 是否满足 PERSISTENT_WRITE 审批策略。
   * 返回 allowed=false 时必须携带 ToolError（APPROVAL_REQUIRED / APPROVAL_DENIED）。
   */
  evaluate(spec: ToolSpec, call: ToolCall): Promise<ToolSafetyDecision>;
}

export interface KillSwitchPolicyAdapter {
  /**
   * 评估当前 ToolCall 是否被 KillSwitch 阻断。
   * 仅在 spec.riskPolicy?.applyKillSwitch === true 时由 CloddsToolSafetyAdapter 调用。
   * 实现宜为只读检查（调用 killSwitch.check / snapshot），不修改风控状态。
   */
  evaluate(spec: ToolSpec, call: ToolCall): Promise<ToolSafetyDecision>;
}

// ── ToolSafetyAdapter Interface ──────────────────────────────────────────────

export interface ToolSafetyAdapter {
  /** 执行前决策。返回 { allowed: false } 时，ToolExecutor 不得调用 handler。 */
  beforeExecute(spec: ToolSpec, call: ToolCall): Promise<ToolSafetyDecision>;
  /** 执行后钩子。Stage 2B-1 默认 no-op，但必须返回 Promise<void>。 */
  afterExecute(spec: ToolSpec, call: ToolCall, result: ToolResult): Promise<void>;
}

// ── Error Builders ───────────────────────────────────────────────────────────

function toolDisabledError(): ToolError {
  return {
    code: 'TOOL_DISABLED',
    message: 'Tool execution is disabled by policy.',
    retryable: false,
  };
}

function approvalRequiredError(toolName: string): ToolError {
  return {
    code: 'APPROVAL_REQUIRED',
    message: `Tool '${toolName}' requires manual approval before execution.`,
    retryable: true,
  };
}

function killSwitchBlockedError(reason?: string): ToolError {
  return {
    code: 'KILL_SWITCH_BLOCKED',
    message: reason ?? 'Kill switch is active and blocks this tool execution.',
    retryable: false,
  };
}

// ── CloddsToolSafetyAdapter ──────────────────────────────────────────────────

export interface CloddsToolSafetyAdapterOptions {
  approvalAdapter?: ApprovalPolicyAdapter;
  killSwitchAdapter?: KillSwitchPolicyAdapter;
}

/**
 * 统一安全适配层。
 *
 * 决策顺序（固化，不可旁路）：
 *   1. LIVE_EXECUTION_DISABLED → 硬拒（TOOL_DISABLED），不查 approval、不查 KS、不可解锁
 *   2. riskPolicy.applyKillSwitch === true → KillSwitchAdapter.evaluate
 *   3. PERSISTENT_WRITE → ApprovalAdapter.evaluate；无 adapter → APPROVAL_REQUIRED
 *   4. READ_ONLY / COMPUTE → allow
 *
 * afterExecute 默认 no-op（预留审计/计数/no-progress guardrail 扩展点）。
 */
export class CloddsToolSafetyAdapter implements ToolSafetyAdapter {
  private readonly approvalAdapter?: ApprovalPolicyAdapter;
  private readonly killSwitchAdapter?: KillSwitchPolicyAdapter;

  constructor(options: CloddsToolSafetyAdapterOptions = {}) {
    this.approvalAdapter = options.approvalAdapter;
    this.killSwitchAdapter = options.killSwitchAdapter;
  }

  async beforeExecute(spec: ToolSpec, call: ToolCall): Promise<ToolSafetyDecision> {
    // ── Step 1: LIVE_EXECUTION_DISABLED hard deny ──
    if (spec.riskClass === 'LIVE_EXECUTION_DISABLED') {
      return { allowed: false, error: toolDisabledError() };
    }

    // ── Step 2: KillSwitch (opt-in only) ──
    if (spec.riskPolicy?.applyKillSwitch === true) {
      if (this.killSwitchAdapter) {
        const ksDecision = await this.killSwitchAdapter.evaluate(spec, call);
        if (!ksDecision.allowed) {
          return { allowed: false, error: ksDecision.error ?? killSwitchBlockedError() };
        }
      } else {
        // 显式要求 KillSwitch 但未注入 adapter → 保守拒绝，避免静默放行
        return { allowed: false, error: killSwitchBlockedError('No KillSwitch adapter configured.') };
      }
    }

    // ── Step 3: PERSISTENT_WRITE → Approval required ──
    if (spec.riskClass === 'PERSISTENT_WRITE') {
      if (this.approvalAdapter) {
        const apDecision = await this.approvalAdapter.evaluate(spec, call);
        if (!apDecision.allowed) {
          return apDecision;
        }
      } else {
        // 无 injection 时 fail-closed：必须返回 APPROVAL_REQUIRED
        return { allowed: false, error: approvalRequiredError(spec.name) };
      }
    }

    // ── Step 4: allow ──
    return { allowed: true };
  }

  async afterExecute(
    _spec: ToolSpec,
    _call: ToolCall,
    _result: ToolResult,
  ): Promise<void> {
    // Stage 2B-1.4: no-op.
    // 扩展点：审计落盘、失败计数、no-progress guardrail、KillSwitch 损失记录。
    // 约束：不写文件、不发全局事件、不修改 KillSwitch 状态（除非设计明确要求）。
    return;
  }
}
