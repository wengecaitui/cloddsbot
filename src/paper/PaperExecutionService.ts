// Stage 3B4C12: Paper Execution Service — thin orchestration between TradeIntent and PaperBroker.
// Paper-mode only. No real Broker/Exchange/API/order calls.

import type { PaperAccountConfig, PaperAccountSnapshot, PaperLedgerEntry } from '../types/paper-account';
import type { TradeIntent } from '../types/trade-intent';
import type { FillSimulatorConfig } from './FillSimulator';
import { PaperBroker, type PaperBrokerPersistence, type PaperBrokerResult } from './PaperBroker';

// ═══ Configuration ════════════════════════════════════════════
export interface PaperExecutionConfig {
  /** Must be explicitly enabled — fail-closed otherwise. */
  paperMode: boolean;
  /** Account config passed to PaperAccountLedger. */
  account: PaperAccountConfig;
  /** Simulation parameters — all explicit, no defaults. */
  simulation: Omit<FillSimulatorConfig, 'fillIdPrefix'>;
  /** Fill ID prefix forwarded to simulator. */
  fillIdPrefix?: string;
  /** Persistence backend. */
  persistence: PaperBrokerPersistence;
}

// ═══ Result ═══════════════════════════════════════════════════
export type PaperExecutionStatus = 'applied' | 'duplicate' | 'rejected' | 'failed';

export interface PaperExecutionEvent {
  status: PaperExecutionStatus;
  fillId?: string;
  executedPriceUsd?: number;
  quantity?: number;
  feeUsd?: number;
  snapshot: PaperAccountSnapshot;
  error?: string;
}

// ═══ Registry key ═════════════════════════════════════════════
type BrokerKey = `${string}:${string}`; // accountId:exchange

export class PaperExecutionService {
  /** Singleton registry: one broker per accountId+exchange. */
  private static brokers = new Map<BrokerKey, PaperBroker>();
  /** Internal counter per broker. */
  private static counters = new Map<BrokerKey, number>();

  private static key(config: PaperExecutionConfig): BrokerKey {
    return `${config.account.accountId}:${config.account.exchange}`;
  }

  /** Acquire or create a broker for the given config. */
  static async acquire(config: PaperExecutionConfig): Promise<PaperBroker> {
    if (!config.paperMode) throw new Error('PaperExecutionService: paperMode must be enabled');

    const k = this.key(config);
    let broker = this.brokers.get(k);
    if (!broker) {
      broker = await PaperBroker.open(config.account, config.persistence);
      this.brokers.set(k, broker);
      this.counters.set(k, broker.snapshot().sequence);
    }
    return broker;
  }

  /** Execute a risk-admitted TradeIntent. */
  static async execute(config: PaperExecutionConfig, intent: TradeIntent): Promise<PaperExecutionEvent> {
    if (!config.paperMode) {
      return {
        status: 'rejected',
        snapshot: {
          accountId: config.account.accountId, exchange: config.account.exchange,
          initialCashUsd: 0, cashUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
          totalFeesUsd: 0, equityUsd: 0, grossExposureUsd: 0, netExposureUsd: 0,
          openPositions: 0, processedFills: 0, sequence: 0, updatedAt: 0, positions: [],
        },
        error: 'paperMode disabled',
      };
    }

    const broker = await this.acquire(config);
    const k = this.key(config);
    const counter = (this.counters.get(k) ?? 0) + 1;

    try {
      const simCfg: FillSimulatorConfig = {
        ...config.simulation,
        fillIdPrefix: config.fillIdPrefix,
      };
      const result: PaperBrokerResult = await broker.execute(intent, simCfg, counter);
      this.counters.set(k, counter);

      return {
        status: result.status,
        fillId: result.fill.fillId,
        executedPriceUsd: result.fill.priceUsd,
        quantity: result.fill.quantity,
        feeUsd: result.fill.feeUsd,
        snapshot: result.snapshot,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        snapshot: broker.snapshot(),
        error: err?.message ?? String(err),
      };
    }
  }

  /** Get the latest snapshot for a config. */
  static async snapshot(config: PaperExecutionConfig): Promise<PaperAccountSnapshot> {
    const broker = await this.acquire(config);
    return broker.snapshot();
  }

  /** Get all entries for a config. */
  static async entries(config: PaperExecutionConfig): Promise<readonly PaperLedgerEntry[]> {
    const broker = await this.acquire(config);
    return broker.entries();
  }

  /** Reset singleton registry (test-only). */
  static reset(): void {
    this.brokers.clear();
    this.counters.clear();
  }
}
