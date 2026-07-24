// Stage 4A3: Lifecycle types, errors, adapter.
import type { ExchangeId } from '../data/MarketIdentity';

export type PaperRuntimeLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export const LIFECYCLE_ERROR_CODES = [
  'RUNTIME_NOT_REGISTERED', 'RUNTIME_NOT_RUNNING', 'RUNTIME_ALREADY_REGISTERED',
  'RUNTIME_NOT_STOPPED', 'LIFECYCLE_TRANSITION_IN_PROGRESS',
  'LIFECYCLE_START_FAILED', 'LIFECYCLE_STOP_FAILED', 'LIFECYCLE_RESTART_FAILED',
  'LIFECYCLE_INVALID_STATE', 'LIFECYCLE_INVALID_ACCOUNT', 'LIFECYCLE_INVALID_EXCHANGE',
] as const;
export type PaperRuntimeLifecycleErrorCode = typeof LIFECYCLE_ERROR_CODES[number];

export class PaperRuntimeLifecycleError extends Error {
  readonly code: PaperRuntimeLifecycleErrorCode;
  readonly accountId?: string;
  readonly exchange?: ExchangeId;
  constructor(code: PaperRuntimeLifecycleErrorCode, message: string, accountId?: string, exchange?: ExchangeId) {
    super(message);
    this.name = 'PaperRuntimeLifecycleError';
    this.code = code;
    this.accountId = accountId;
    this.exchange = exchange;
  }
}

export interface PaperRuntimeLifecycleSnapshot {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly state: PaperRuntimeLifecycleState;
  readonly acceptingRuns: boolean;
  readonly inFlightRuns: number;
  readonly generation: number;
  readonly registeredAtMs: number;
  readonly lastTransitionAtMs: number;
  readonly startedAtMs?: number;
  readonly stoppedAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

export interface PaperRuntimeBatchResult {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly operation: 'start' | 'stop';
  readonly success: boolean;
  readonly state: PaperRuntimeLifecycleState;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

// ── Lifecycle Adapter ─────────────────────────────────────────
export interface PaperRuntimeLifecycleAdapter {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export class NoopPaperRuntimeLifecycleAdapter implements PaperRuntimeLifecycleAdapter {
  start(): void {}
  stop(): void {}
}
