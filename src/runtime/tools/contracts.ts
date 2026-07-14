// =============================================================================
// Stage 2B-1: Unified Tool Execution Core — Contracts
// =============================================================================
//
// Zero dependencies on agents, gateway, cron, skills, trading, PythonBridge.
// These are the foundational types for the entire Tool Execution layer.
//
// Dependency direction: contracts → registry → executor → composition
// =============================================================================

// ── Risk Classification ────────────────────────────────────────────────────

/**
 * Tool risk classification — fixed 4-value enum. No extensions allowed.
 *
 * - READ_ONLY              : queries, reads, searches — no side effects
 * - COMPUTE                : pure computation, no persistence
 * - PERSISTENT_WRITE       : writes to disk / database — requires approval
 * - LIVE_EXECUTION_DISABLED: live trading — unconditionally rejected
 */
export type ToolRiskClass =
  | 'READ_ONLY'
  | 'COMPUTE'
  | 'PERSISTENT_WRITE'
  | 'LIVE_EXECUTION_DISABLED';

// ── ToolCall ───────────────────────────────────────────────────────────────

export interface ToolCall {
  /** Globally unique call ID (UUID v4 or ULID) */
  callId: string;
  /** Run ID from the originating AgentLoop / Pipeline */
  runId: string;
  /** Tool name matching a registered ToolSpec */
  toolName: string;
  /** Raw arguments (JSON-serializable) */
  arguments: unknown;
  /** Timestamp when the call was issued (ms since epoch) */
  requestedAt: number;
  /** Optional session ID for audit tracing */
  sessionId?: string;
}

// ── ToolError ──────────────────────────────────────────────────────────────

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_TOOL_INPUT'
  | 'TOOL_DISABLED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'KILL_SWITCH_BLOCKED'
  | 'TOOL_TIMEOUT'
  | 'TOOL_EXECUTION_FAILED'
  | 'INVALID_TOOL_OUTPUT';

export interface ToolError {
  code: ToolErrorCode;
  /** User-facing message — no internal paths, no stack traces */
  message: string;
  /** Whether a retry is likely to succeed */
  retryable: boolean;
  /** Internal details for audit only — never sent to the agent */
  details?: Record<string, unknown>;
}

// ── ToolResult ─────────────────────────────────────────────────────────────

export interface ToolResult<T = unknown> {
  callId: string;
  runId: string;
  toolName: string;

  ok: boolean;
  latencyMs: number;
  truncated: boolean;

  content: string;
  data?: T;
  error?: ToolError;

  /** Stage 2B-1: always []; reserved for Artifact Store */
  artifactIds: string[];
  /** Stage 2B-1: always []; reserved for Evidence Store */
  evidenceIds: string[];
}

// ── ToolExecutionContext ───────────────────────────────────────────────────

export interface ToolExecutionContext {
  callId: string;
  runId: string;
  sessionId?: string;
  /** AbortSignal for timeout — handler should check signal.aborted */
  signal: AbortSignal;
}

// ── ToolHandler ────────────────────────────────────────────────────────────

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

// ── ToolSpec ───────────────────────────────────────────────────────────────

export interface ToolSpec<TInput = unknown, TOutput = unknown> {
  /** Unique tool name (matches ToolRegistry key) */
  name: string;
  /** Semantic version for schema cache invalidation */
  version: string;
  /** Natural-language description (shown to LLM) */
  description: string;

  // ── Risk & Policy ──
  riskClass: ToolRiskClass;
  /** Per-execution timeout (ms). 0 = no timeout (use with caution). */
  timeoutMs: number;
  /** Whether repeated calls with same args are side-effect-free */
  idempotent: boolean;
  /** Whether manual approval is always required (overrides riskClass default) */
  requiresApproval: boolean;

  // ── Risk policy overrides (optional, safe-purpose only) ──
  riskPolicy?: {
    /** If true, check KillSwitch before execution (default: false) */
    applyKillSwitch?: boolean;
  };

  // ── Input contract ──
  /** OpenAI-compatible JSON Schema for the `parameters` field */
  parameters: Record<string, unknown>;

  /**
   * Validate and transform raw input. Throw ToolInputValidationError on failure.
   * NOTE: No Zod dependency. Implementers must write plain validation.
   */
  validateInput(input: unknown): TInput;

  /** Optional output validation — throw ToolInputValidationError on failure */
  validateOutput?(output: unknown): TOutput;

  // ── Execution ──
  handler: ToolHandler<TInput, TOutput>;

  /**
   * Optional content formatter.
   * If provided, the executor calls this to produce the `content` string.
   * If omitted: string result → used directly; non-string → JSON.stringify.
   */
  formatContent?(output: TOutput): string;
}

// ── ToolInputValidationError ──────────────────────────────────────────────

export class ToolInputValidationError extends Error {
  constructor(
    public toolName: string,
    message: string,
    public cause?: unknown,
  ) {
    super(`[${toolName}] input validation failed: ${message}`);
    this.name = 'ToolInputValidationError';
  }
}

// ── Helper: format spec output content ────────────────────────────────────

export function formatToolOutput<T>(spec: ToolSpec<unknown, T>, raw: T): string {
  if (spec.formatContent) return spec.formatContent(raw);
  if (raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return `[Unserializable output: ${typeof raw}]`;
  }
}

// ── MAX_TOOL_CONTENT_CHARS ─────────────────────────────────────────────────

export const MAX_TOOL_CONTENT_CHARS = 30_000;
