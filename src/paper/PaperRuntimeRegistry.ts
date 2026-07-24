// Stage 4A1-R1: PaperRuntimeRegistry — identity-verified, list-encapsulated.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { FastPipeline } from '../pipeline/FastPipeline';
import { PaperExecutionService } from './PaperExecutionService';
import type { PaperAccountSnapshot } from '../types/paper-account';
import { PaperFastPathCoordinator, type PaperCoordinatorResult } from './PaperFastPathCoordinator';

// ── Binding (frozen after registration) ──────────────────────
export interface PaperRuntimeBinding {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly pipeline: FastPipeline;
  readonly service: PaperExecutionService;
  readonly coordinator: PaperFastPathCoordinator;
}

/** Read-only summary returned by list() — no pipeline/service/coordinator references. */
export interface RegistryEntry {
  readonly accountId: string;
  readonly exchange: ExchangeId;
}

// ── Registry ───────────────────────────────────────────────────
export class PaperRuntimeRegistry {
  private bindings = new Map<string, { binding: Readonly<PaperRuntimeBinding>; key: string }>();

  private key(accountId: string, exchange: ExchangeId): string {
    return `${accountId}:${exchange}`;
  }

  /** Validate common inputs for all public methods. */
  private validateKey(accountId: string, exchange: ExchangeId): void {
    if (typeof accountId !== 'string' || accountId !== accountId.trim() || accountId.length === 0) {
      throw new Error('Registry: invalid accountId');
    }
    if (!isExchangeId(exchange)) throw new Error('Registry: invalid exchange');
  }

  /** Strong identity-verified registration. */
  register(binding: PaperRuntimeBinding): void {
    this.validateKey(binding.accountId, binding.exchange);
    const k = this.key(binding.accountId, binding.exchange);
    if (this.bindings.has(k)) throw new Error(`Registry: duplicate binding ${k}`);

    // ── Identity cross-check ──
    if (binding.pipeline.getExchange() !== binding.exchange) {
      throw new Error(`Registry: pipeline exchange mismatch`);
    }
    const id = binding.service.getIdentity();
    if (id.accountId !== binding.accountId) {
      throw new Error(`Registry: service accountId mismatch`);
    }
    if (id.exchange !== binding.exchange) {
      throw new Error(`Registry: service exchange mismatch`);
    }
    if (binding.coordinator.getExchange() !== binding.exchange) {
      throw new Error(`Registry: coordinator exchange mismatch`);
    }
    if (!binding.coordinator.isBoundTo(binding.pipeline, binding.service, binding.exchange)) {
      throw new Error(`Registry: coordinator not bound to given pipeline/service`);
    }

    // Store frozen copy
    this.bindings.set(k, { binding: Object.freeze({ ...binding }), key: k });
  }

  /** Unregister without deleting ledger data. */
  unregister(accountId: string, exchange: ExchangeId): boolean {
    this.validateKey(accountId, exchange);
    return this.bindings.delete(this.key(accountId, exchange));
  }

  /** Check if a binding exists. */
  has(accountId: string, exchange: ExchangeId): boolean {
    this.validateKey(accountId, exchange);
    return this.bindings.has(this.key(accountId, exchange));
  }

  /** Deterministic sorted listing — read-only summary only. */
  list(): readonly RegistryEntry[] {
    return [...this.bindings.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, { binding }]) => ({ accountId: binding.accountId, exchange: binding.exchange }));
  }

  /** Lookup or fail-closed. */
  private get(accountId: string, exchange: ExchangeId): Readonly<PaperRuntimeBinding> {
    this.validateKey(accountId, exchange);
    const entry = this.bindings.get(this.key(accountId, exchange));
    if (!entry) throw new Error(`Registry: no binding for ${this.key(accountId, exchange)}`);
    return entry.binding;
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
