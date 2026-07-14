// =============================================================================
// Stage 2B-1.5: ToolExecutor — 统一工具执行器（单工具）
// =============================================================================
//
// 依赖：contracts.ts, ToolRegistry.ts, ToolSafetyAdapter.ts, events.ts
// 禁止直接依赖：permissions/*, router/*, tools/*, agents/*
//
// 设计约束：
//   - 不创建模块级 singleton
//   - 安全行为全部通过 ToolSafetyAdapter 注入
//   - 不实现 executeMany/retry/queue/batch/Artifact Store/Plan/EventBus
//
// 12 步固定执行顺序：
//   1. Registry lookup
//   2. Input validation
//   3. Safety beforeExecute
//   4. Emit tool.started
//   5. Handler (timeout + AbortSignal)
//   6. Optional output validation
//   7. Format content
//   8. Normalize ToolResult
//   9. Truncate content
//  10. Safety afterExecute
//  11. Emit completed/failed
//  12. Return ToolResult
// =============================================================================

import type { ToolRegistry } from './ToolRegistry';
import type { ToolSafetyAdapter } from './ToolSafetyAdapter';
import type { AgentToolEventSink, AgentToolEvent } from './events';
import type {
    ToolCall,
    ToolError,
    ToolExecutionContext,
    ToolResult,
    ToolSpec,
} from './contracts';
import { MAX_TOOL_CONTENT_CHARS, formatToolOutput, ToolInputValidationError } from './contracts';

// ── Options ──────────────────────────────────────────────────────────────────

export interface ToolExecutorOptions {
    registry: ToolRegistry;
    safetyAdapter: ToolSafetyAdapter;
    eventSink?: AgentToolEventSink;
    /** Inject clock. Default: Date.now */
    now?: () => number;
    /** Max content chars. Default: MAX_TOOL_CONTENT_CHARS = 30000 */
    maxContentChars?: number;
}

// ── No-Op Event Sink ─────────────────────────────────────────────────────────

const noOpEventSink: AgentToolEventSink = {
    emit(_event: AgentToolEvent): void { /* no-op — intentionally empty */ },
};

// ── ToolExecutor ─────────────────────────────────────────────────────────────

export class ToolExecutor {
    private readonly registry: ToolRegistry;
    private readonly safety: ToolSafetyAdapter;
    private readonly eventSink: AgentToolEventSink;
    private readonly now: () => number;
    private readonly maxContentChars: number;
    private readonly maxErrorChars = 2000;
    private seq = 0;
    private callCreateMs = 0;

    constructor(options: ToolExecutorOptions) {
        this.registry = options.registry;
        this.safety = options.safetyAdapter;
        this.eventSink = options.eventSink ?? noOpEventSink;
        this.now = options.now ?? Date.now;
        this.maxContentChars = options.maxContentChars ?? MAX_TOOL_CONTENT_CHARS;
    }

    async executeOne(call: ToolCall): Promise<ToolResult> {
        this.callCreateMs = this.now();
        const { callId, runId } = call;
        const toolName = call.toolName;

        // ── 1. Registry lookup ───────────────────────────────────────────
        const spec = this.registry.get(toolName);
        if (!spec) {
            return this.failResult(callId, runId, toolName, {
                code: 'TOOL_NOT_FOUND',
                message: `Tool '${toolName}' not found.`,
                retryable: false,
            });
        }

        // ── 2. Input validation ──────────────────────────────────────────
        let validatedInput: unknown;
        try {
            validatedInput = spec.validateInput(call.arguments);
        } catch (err: unknown) {
            return this.failResult(callId, runId, toolName, {
                code: 'INVALID_TOOL_INPUT',
                message: this.safeErrorMsg(err, 'Invalid input.'),
                retryable: false,
            });
        }

        // ── 3. Safety beforeExecute ──────────────────────────────────────
        let safetyDecision;
        try {
            safetyDecision = await this.safety.beforeExecute(spec, call);
        } catch {
            return this.failResult(callId, runId, toolName, {
                code: 'TOOL_EXECUTION_FAILED',
                message: 'Tool safety evaluation failed.',
                retryable: false,
            });
        }
        if (!safetyDecision.allowed) {
            return this.failResult(callId, runId, toolName, safetyDecision.error ?? {
                code: 'TOOL_EXECUTION_FAILED',
                message: 'Tool execution denied by safety policy.',
                retryable: false,
            });
        }

        // ── 4. Emit tool.started ─────────────────────────────────────────
        const startSeq = this.nextSeq();
        this.emit({
            schemaVersion: '1.0',
            type: 'tool.started',
            runId,
            callId,
            sequence: startSeq,
            timestamp: this.now(),
            toolName,
        });

        // ── 5. Handler with timeout + AbortSignal ────────────────────────
        //
        // NOTE: AbortSignal gives cooperative cancellation. If the handler
        // ignores signal.aborted, the Promise.race resolves but the underlying
        // task continues. Stage 2B does NOT claim forced termination.
        const safeMs = validateTimeout(spec.timeoutMs, 30_000);
        const controller = new AbortController();
        const handlerCtx: ToolExecutionContext = {
            callId, runId,
            sessionId: call.sessionId,
            signal: controller.signal,
        };

        let output: unknown;
        let handlerErr: ToolError | null = null;
        const handlerStart = this.now();

        try {
            const result = await Promise.race([
                spec.handler(validatedInput, handlerCtx),
                timeoutPromise(safeMs, controller, spec.name),
            ]);
            output = result;
        } catch (err: unknown) {
            if (err instanceof ToolTimeout) {
                handlerErr = {
                    code: 'TOOL_TIMEOUT',
                    message: err.message.slice(0, this.maxErrorChars),
                    retryable: true,
                };
            } else if (err instanceof Error) {
                handlerErr = {
                    code: 'TOOL_EXECUTION_FAILED',
                    message: 'Handler execution failed.',
                    retryable: false,
                };
            } else {
                handlerErr = {
                    code: 'TOOL_EXECUTION_FAILED',
                    message: 'Handler threw a non-Error value.',
                    retryable: false,
                };
            }
        } finally {
            controller.abort();
        }

        const handlerMs = this.now() - handlerStart;

        if (handlerErr) {
            const r = this.makeResult(callId, runId, toolName, { ok: false, error: handlerErr, latencyMs: handlerMs });
            await this.finish(spec, call, r, toolName);
            return r;
        }

        // ── 6. Optional output validation ────────────────────────────────
        if (spec.validateOutput) {
            try {
                output = spec.validateOutput(output);
            } catch {
                const r = this.makeResult(callId, runId, toolName, {
                    ok: false,
                    error: { code: 'INVALID_TOOL_OUTPUT', message: 'Tool output validation failed.', retryable: false },
                    latencyMs: handlerMs,
                });
                await this.finish(spec, call, r, toolName);
                return r;
            }
        }

        // ── 7. Format content ────────────────────────────────────────────
        let content: string;
        try {
            content = formatToolOutput(spec as ToolSpec<unknown, unknown>, output);
        } catch {
            const r = this.makeResult(callId, runId, toolName, {
                ok: false,
                error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool output formatting failed.', retryable: false },
                latencyMs: handlerMs,
            });
            await this.finish(spec, call, r, toolName);
            return r;
        }

        // ── 8 + 9: Result + truncation ──────────────────────────────────
        let truncated = false;
        if (content.length > this.maxContentChars) {
            content = content.slice(0, this.maxContentChars);
            truncated = true;
        }

        const r = this.makeResult(callId, runId, toolName, {
            ok: true, latencyMs: handlerMs, data: output, content, truncated,
        });

        await this.finish(spec, call, r, toolName);
        return r;
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private async finish(spec: ToolSpec, call: ToolCall, result: ToolResult, toolName: string): Promise<void> {
        // 10. afterExecute (best-effort)
        try { await this.safety.afterExecute(spec, call, result); } catch { /* no overlapp */ }

        // 11. Emit
        const seq = this.nextSeq();
        if (result.ok) {
            this.emit({ schemaVersion: '1.0', type: 'tool.completed', runId: call.runId, callId: call.callId, sequence: seq, timestamp: this.now(), toolName, latencyMs: result.latencyMs, ok: true });
        } else {
            this.emit({ schemaVersion: '1.0', type: 'tool.failed', runId: call.runId, callId: call.callId, sequence: seq, timestamp: this.now(), toolName, errorCode: result.error!.code, errorMessage: result.error!.message });
        }
    }

    private failResult(callId: string, runId: string, toolName: string, error: ToolError): Promise<ToolResult> {
        // Pre-handler failure: emit tool.failed only, no tool.started
        this.emit({ schemaVersion: '1.0', type: 'tool.failed', runId, callId, sequence: this.nextSeq(), timestamp: this.now(), toolName, errorCode: error.code, errorMessage: error.message });
        return Promise.resolve(this.makeResult(callId, runId, toolName, { ok: false, error, latencyMs: this.now() - this.callCreateMs }));
    }

    private makeResult(
        callId: string, runId: string, toolName: string,
        overrides: { ok: boolean; error?: ToolError; latencyMs: number; data?: unknown; content?: string; truncated?: boolean },
    ): ToolResult {
        return {
            callId, runId, toolName,
            ok: overrides.ok,
            latencyMs: Math.max(0, Math.round(overrides.latencyMs)),
            truncated: overrides.truncated ?? false,
            content: overrides.content ?? '',
            data: overrides.data,
            error: overrides.ok ? undefined : overrides.error,
            artifactIds: [],
            evidenceIds: [],
        };
    }

    private nextSeq(): number { return ++this.seq; }

    private emit(event: AgentToolEvent): void {
        try { this.eventSink.emit(event); } catch { /* must not change ToolResult */ }
    }

    private safeErrorMsg(err: unknown, fallback: string): string {
        if (err instanceof ToolInputValidationError) return err.message.slice(0, this.maxErrorChars);
        if (err instanceof Error) return err.message.slice(0, this.maxErrorChars);
        return fallback;
    }
}

// ── Timeout helpers ─────────────────────────────────────────────────────────

class ToolTimeout extends Error {
    constructor(m: string) { super(m); this.name = 'ToolTimeout'; }
}

function validateTimeout(ms: number, fallback: number): number {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return fallback;
    if (ms <= 0 || ms > 86400000) return fallback;
    return ms;
}

function timeoutPromise(ms: number, ctrl: AbortController, name: string): Promise<never> {
    return new Promise((_, reject) => {
        const t = setTimeout(() => {
            ctrl.abort();
            clearTimeout(t);
            reject(new ToolTimeout(`Tool '${name}' timed out after ${ms}ms.`));
        }, ms);
        if (typeof t === 'object' && 'unref' in t) (t as ReturnType<typeof setTimeout>).unref?.();
    });
}
