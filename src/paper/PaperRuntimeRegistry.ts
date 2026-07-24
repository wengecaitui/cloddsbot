// Stage 4A1: Paper Multi-Exchange Runtime Registry — instance-scoped, no global singleton.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { FastPipeline, FastPipelineResult } from '../pipeline/FastPipeline';
import { PaperExecutionService, type PaperExecutionEvent } from './PaperExecutionService';
import type { PaperAccountSnapshot } from '../types/paper-account';
import { PaperFastPathCoordinator, type PaperCoordinatorResult } from './PaperFastPathCoordinator';

// ── Binding ────────────────────────────────────────────────────
export interface PaperRuntimeBinding {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly pipeline: FastPipeline;
  readonly service: PaperExecutionService;
  readonly coordinator: PaperFastPathCoordinator;
}

// ── Registry ───────────────────────────────────────────────────
export class PaperRuntimeRegistry {
  private bindings = new Map<string, PaperRuntimeBinding>();

  /** Composite key: accountId + ":" + exchange */
  private key(accountId: string, exchange: ExchangeId): string {
    return `${accountId}:${exchange}`;
  }

  /** Register a binding. Rejects duplicates, invalid exchange, identity mismatches. */
  register(binding: PaperRuntimeBinding): void {
    if (!isExchangeId(binding.exchange)) throw new Error('Registry: invalid exchange');
    if (!binding.accountId) throw new Error('Registry: accountId required');
    const k = this.key(binding.accountId, binding.exchange);
    if (this.bindings.has(k)) throw new Error(`Registry: duplicate binding ${k}`);
    this.bindings.set(k, binding);
  }

  /** Unregister without deleting ledger data. */
  unregister(accountId: string, exchange: ExchangeId): boolean {
    return this.bindings.delete(this.key(accountId, exchange));
  }

  /** Check if a binding exists. */
  has(accountId: string, exchange: ExchangeId): boolean {
    return this.bindings.has(this.key(accountId, exchange));
  }

  /** Deterministic listing sorted by key. */
  list(): readonly PaperRuntimeBinding[] {
    return [...this.bindings.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v);
  }

  /** Lookup or fail-closed. */
  private get(accountId: string, exchange: ExchangeId): PaperRuntimeBinding {
    const k = this.key(accountId, exchange);
    const b = this.bindings.get(k);
    if (!b) throw new Error(`Registry: no binding for ${k}`);
    return b;
  }

  /** Route a signal through the matching binding. Pipeline called exactly once. */
  async run(
    accountId: string,
    signal: { exchange: ExchangeId; symbol: string; source: string },
    params: { feeBps: number; slippageBps: number },
  ): Promise<PaperCoordinatorResult> {
    const b = this.get(accountId, signal.exchange);
    return b.coordinator.run(signal, params);
  }

  /** Snapshot of a specific binding's ledger. */
  snapshot(accountId: string, exchange: ExchangeId): PaperAccountSnapshot {
    return this.get(accountId, exchange).service.snapshot();
  }
}
