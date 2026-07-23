// Stage 3B4C10: Paper Broker — deterministic orchestration layer.
// Thin wiring between FillSimulator → PaperAccountLedger → PaperLedgerStore.
// No new accounting, risk, pricing, or trading. Async-safe serial queue.

import type { PaperAccountConfig, PaperAccountSnapshot, PaperLedgerEntry } from '../types/paper-account';
import type { TradeIntent } from '../types/trade-intent';
import type { PaperFill } from '../types/paper-fill';
import { PaperAccountLedger } from './PaperAccountLedger';
import { simulateFill, type FillSimulatorConfig } from './FillSimulator';

export interface PaperBrokerPersistence {
  load(): Promise<PaperAccountLedger | null>;
  save(ledger: PaperAccountLedger): Promise<void>;
}

export interface PaperBrokerResult {
  status: 'applied' | 'duplicate';
  fill: PaperFill;
  snapshot: PaperAccountSnapshot;
  persisted: boolean;
}

export class PaperBroker {
  private ledger: PaperAccountLedger;
  private readonly store: PaperBrokerPersistence;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(ledger: PaperAccountLedger, store: PaperBrokerPersistence) {
    this.ledger = ledger;
    this.store = store;
  }

  static async open(config: PaperAccountConfig, store: PaperBrokerPersistence): Promise<PaperBroker> {
    const stored = await store.load();
    if (stored) {
      const sc = stored.getConfig();
      if (sc.accountId !== config.accountId || sc.exchange !== config.exchange)
        throw new Error('PaperBroker: persisted ledger identity mismatch');
      return new PaperBroker(stored, store);
    }
    return new PaperBroker(new PaperAccountLedger(config), store);
  }

  snapshot(): PaperAccountSnapshot { return this.ledger.snapshot(); }
  entries(): readonly PaperLedgerEntry[] { return this.ledger.entries(); }
  getConfig(): PaperAccountConfig { return this.ledger.getConfig(); }

  /** Serialized async execute. All calls queue behind each other. */
  execute(intent: TradeIntent, config: FillSimulatorConfig, counter: number): Promise<PaperBrokerResult> {
    const run = () => this._doExecute(intent, config, counter);
    // Chain onto the tail of the queue, catching errors so the queue isn't permanently broken
    this.queue = this.queue.then(run, run);
    return this.queue as Promise<PaperBrokerResult>;
  }

  private async _doExecute(intent: TradeIntent, cfg: FillSimulatorConfig, counter: number): Promise<PaperBrokerResult> {
    // 1. Simulate
    const { fill } = simulateFill(intent, cfg, counter);

    // 2. Clone ledger as candidate
    const candidate = PaperAccountLedger.fromEntries(this.ledger.getConfig(), this.ledger.entries());

    // 3. Apply fill to candidate
    const applied = candidate.applyFill(fill);
    if (applied.status === 'duplicate') {
      return { status: 'duplicate', fill, snapshot: this.ledger.snapshot(), persisted: false };
    }

    // 4. Save candidate → on success swap live ledger (save-before-swap)
    await this.store.save(candidate);
    this.ledger = candidate;
    return { status: 'applied', fill, snapshot: this.ledger.snapshot(), persisted: true };
  }
}
