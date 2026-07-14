// =============================================================================
// Stage 2B-1.6: Composition Root — Tool Runtime 工厂
// =============================================================================
//
// 仅暴露 createToolRuntime()，组合 ToolRegistry + ToolExecutor + 默认 Safety。
//
// 约束：
//   - 无模块级全局状态、无 import-time 副作用
//   - 不注册任何生产工具（Stage 2B-2 负责）
//   - 不直接 import ExecApprovalsManager / KillSwitch / PythonBridgeDaemon
//   - CloddsToolSafetyAdapter 默认 fail-closed，不创建"全部允许"的 Safety
// =============================================================================

import { ToolExecutor } from './ToolExecutor';
import type { ToolExecutorOptions } from './ToolExecutor';
import type { ToolRegistry } from './ToolRegistry';
import { createToolRegistry } from './ToolRegistry';
import { CloddsToolSafetyAdapter } from './ToolSafetyAdapter';
import type { ToolSafetyAdapter } from './ToolSafetyAdapter';
import type { AgentToolEventSink } from './events';

export interface ToolRuntime {
  registry: ToolRegistry;
  executor: ToolExecutor;
}

export interface CreateToolRuntimeOptions {
  registry?: ToolRegistry;
  safetyAdapter?: ToolSafetyAdapter;
  eventSink?: AgentToolEventSink;
  now?: () => number;
  maxContentChars?: number;
  freezeRegistry?: boolean;
}

/**
 * 创建独立的 ToolRuntime 实例。
 *
 * 每次调用产生独立 Registry + Executor。
 * 默认 Safety = CloddsToolSafetyAdapter（fail-closed 默认行为：
 * READ_ONLY/COMPUTE → allow, PERSISTENT_WRITE → APPROVAL_REQUIRED,
 * LIVE_EXECUTION_DISABLED → TOOL_DISABLED）。
 * 默认不冻结，不注册工具。
 */
export function createToolRuntime(options: CreateToolRuntimeOptions = {}): ToolRuntime {
  if (options.maxContentChars != null) {
    if (typeof options.maxContentChars !== 'number' || !Number.isFinite(options.maxContentChars)) {
      throw new Error('createToolRuntime: maxContentChars must be a finite number.');
    }
    if (options.maxContentChars <= 0) {
      throw new Error('createToolRuntime: maxContentChars must be > 0.');
    }
  }

  const registry: ToolRegistry = options.registry ?? createToolRegistry();
  const safety: ToolSafetyAdapter = options.safetyAdapter ?? new CloddsToolSafetyAdapter();

  const executor = new ToolExecutor({
    registry,
    safetyAdapter: safety,
    eventSink: options.eventSink,
    now: options.now,
    maxContentChars: options.maxContentChars,
  });

  if (options.freezeRegistry === true) {
    registry.freeze();
  }

  return { registry, executor };
}
