// Stage 2B-1: Unified Tool Execution Core — barrel export
// No import-time side effects.

export type { ToolRiskClass } from './contracts';
export type { ToolCall, ToolError, ToolErrorCode, ToolResult, ToolExecutionContext, ToolHandler, ToolSpec } from './contracts';
export { ToolInputValidationError, formatToolOutput, MAX_TOOL_CONTENT_CHARS } from './contracts';

export type { ToolRegistry } from './ToolRegistry';
export { createToolRegistry } from './ToolRegistry';

export type { AgentToolEvent, AgentToolEventBase, AgentToolEventSink, ToolStartedEvent, ToolCompletedEvent, ToolFailedEvent } from './events';
export { createInMemoryEventSink } from './events';

export type { ToolSafetyDecision, ToolSafetyAdapter, ApprovalPolicyAdapter, KillSwitchPolicyAdapter, CloddsToolSafetyAdapterOptions } from './ToolSafetyAdapter';
export { CloddsToolSafetyAdapter } from './ToolSafetyAdapter';

export type { ToolExecutorOptions } from './ToolExecutor';
export { ToolExecutor } from './ToolExecutor';

export type { ToolRuntime, CreateToolRuntimeOptions } from './composition';
export { createToolRuntime } from './composition';
