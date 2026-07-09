// src/types/hermes-lifecycle.ts
// Step 2A.6: Hermes lifecycle contract (interface only — no runtime)
//
// This file defines the compile-time contract for Hermes lifecycle management.
// Sprint 3 will provide the concrete implementation.
//
// No EventBus, no daemon control, no HTTP API, no cron — only the interface
// that the concrete Hermes class must satisfy.

/** Hermes operational states. */
export type HermesState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPING'
  | 'ERROR';

/** Snapshot of system health — no daemon probing, only aggregate data. */
export interface HealthStatus {
  /** Current Hermes lifecycle state. */
  state: HermesState;
  /** Whether the Python daemon process is alive (true) or dead / not started. */
  daemonAlive: boolean;
  /** Process uptime in seconds (0 if not running). */
  uptimeSec: number;
  /** Age of the latest MarketBiasReport in seconds (null if none exists yet). */
  biasReportAgeSec: number | null;
  /** Whether a SlowPipeline cycle is currently executing. */
  running: boolean;
}

/**
 * Hermes lifecycle interface.
 *
 * The concrete implementation (Sprint 3) will:
 *  - Manage the PythonBridgeDaemon process (spawn / kill)
 *  - Schedule cron triggers for SlowPipeline
 *  - Expose these methods via a local HTTP API (e.g. localhost:4173)
 *  - Publish state transitions via EventBus
 *
 * This file defines ONLY the contract.  No HTTP / cron / daemon logic.
 */
export interface IHermesLifecycle {
  /** Transition state machine to STARTING → READY. */
  start(): Promise<void>;

  /** Graceful shutdown: kill daemon, clear cron, transition to STOPPED. */
  stop(): Promise<void>;

  /** Reload configuration without restarting the process. */
  flush(): Promise<void>;

  /** Return a snapshot of current system health. */
  health(): Promise<HealthStatus>;
}
