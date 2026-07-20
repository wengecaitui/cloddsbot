export type ObservableActor = 'hermes' | 'codex' | 'user' | 'system' | 'runtime';

export type ObservableSource =
  | 'log'
  | 'filesystem'
  | 'git'
  | 'process'
  | 'tool'
  | 'runtime'
  | 'approval';

export type RiskClass =
  | 'R0_READ_ONLY'
  | 'R1_REVERSIBLE_WORKSPACE_WRITE'
  | 'R2_STATEFUL_OPERATION'
  | 'R3_DESTRUCTIVE_OR_SYSTEM_CHANGE'
  | 'R4_PRODUCTION_OR_REAL_MONEY';

export type EvidenceLevel =
  | 'VERIFIED_SOURCE_EXISTS'
  | 'VERIFIED_RUNTIME_WIRED'
  | 'VERIFIED_TESTED'
  | 'VERIFIED_OBSERVED'
  | 'INFERENCE'
  | 'UNVERIFIED';

export interface ObservableAgentEvent {
  schemaVersion: '1.0';
  eventId: string;
  runId: string;
  taskId?: string;
  timestamp: string;
  actor: ObservableActor;
  source: ObservableSource;
  action: string;
  target?: string;
  cwd?: string;
  riskClass: RiskClass;
  evidenceLevel: EvidenceLevel;
  approvalId?: string;
  commandDigest?: string;
  before?: unknown;
  after?: unknown;
  result?: {
    ok: boolean;
    exitCode?: number;
    durationMs?: number;
    errorCode?: string;
    summary?: string;
  };
  redactions?: string[];
}

export interface RawObservableEvent {
  eventId?: string;
  runId?: string;
  taskId?: string;
  timestamp?: string | number | Date;
  actor?: ObservableActor;
  source: ObservableSource;
  action: string;
  target?: string;
  cwd?: string;
  riskClass?: RiskClass;
  evidenceLevel?: EvidenceLevel;
  approvalId?: string;
  command?: string;
  commandDigest?: string;
  before?: unknown;
  after?: unknown;
  result?: ObservableAgentEvent['result'];
}

export interface ObservableEventSink {
  emit(event: RawObservableEvent): void | Promise<void>;
}

export interface ObservableEventSourceAdapter {
  readonly name: string;
  start(sink: ObservableEventSink): void | Promise<void>;
  stop(): void | Promise<void>;
}

const RISK_RANK: Record<RiskClass, number> = {
  R0_READ_ONLY: 0,
  R1_REVERSIBLE_WORKSPACE_WRITE: 1,
  R2_STATEFUL_OPERATION: 2,
  R3_DESTRUCTIVE_OR_SYSTEM_CHANGE: 3,
  R4_PRODUCTION_OR_REAL_MONEY: 4,
};

export function compareRiskClass(left: RiskClass, right: RiskClass): number {
  return RISK_RANK[left] - RISK_RANK[right];
}
