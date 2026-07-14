// =============================================================================
// Stage 2B-1: AgentToolEvent — 工具生命周期事件（3 类）
// =============================================================================
//
// 设计约束：
// - 仅支持 tool.started / tool.completed / tool.failed 三种
// - 通过 AgentToolEventSink 发布，不创建全局 EventBus
// - sequence 由 ToolExecutor 单调递增
//
// Dependencies: 无（纯数据结构）
// =============================================================================

// ── Event Base ──────────────────────────────────────────────────────────────

export interface AgentToolEventBase {
  schemaVersion: '1.0';
  runId: string;
  callId: string;
  sequence: number;
  timestamp: number;       // ms since epoch
  toolName: string;
}

// ── Concrete Events ─────────────────────────────────────────────────────────

export interface ToolStartedEvent extends AgentToolEventBase {
  type: 'tool.started';
}

export interface ToolCompletedEvent extends AgentToolEventBase {
  type: 'tool.completed';
  latencyMs: number;
  ok: boolean;
}

export interface ToolFailedEvent extends AgentToolEventBase {
  type: 'tool.failed';
  errorCode: string;
  errorMessage: string;
}

// ── Discriminated Union ─────────────────────────────────────────────────────

export type AgentToolEvent =
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent;

// ── Event Sink Interface ────────────────────────────────────────────────────

export interface AgentToolEventSink {
  emit(event: AgentToolEvent): void | Promise<void>;
}

// ── In-Memory Sink (for testing / composition) ──────────────────────────────

export function createInMemoryEventSink(): AgentToolEventSink & { events: AgentToolEvent[] } {
  const events: AgentToolEvent[] = [];
  return {
    emit(event: AgentToolEvent): void {
      events.push(event);
    },
    get events() {
      return events;
    }
  };
}
