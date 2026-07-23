// Stage 3B4C13: Instance-based Paper Execution Service with dynamic execution input.
import type { PaperAccountConfig, PaperAccountSnapshot, PaperLedgerEntry } from '../types/paper-account';
import type { TradeIntent } from '../types/trade-intent';
import type { FillSimulatorConfig } from './FillSimulator';
import { PaperBroker, type PaperBrokerPersistence, type PaperBrokerResult } from './PaperBroker';
import { canonicalizePaperAccountConfig } from '../types/paper-account';

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

/** Per-execute simulation parameters — all explicit, no stored defaults. */
export interface ExecuteParams {
  markPriceUsd: number;
  feeBps: number;
  slippageBps: number;
  executedAtMs: number;
  fillIdPrefix?: string;
}

export class PaperExecutionService {
  private broker: PaperBroker;
  private counter = 0;

  private constructor(broker: PaperBroker) {
    this.broker = broker;
  }

  /** Open a service bound to one canonical account + persistence. */
  static async open(config: PaperAccountConfig, persistence: PaperBrokerPersistence): Promise<PaperExecutionService> {
    const canonical = canonicalizePaperAccountConfig(config);
    const broker = await PaperBroker.open(canonical, persistence);
    const svc = new PaperExecutionService(broker);
    svc.counter = broker.snapshot().sequence;
    return svc;
  }

  snapshot(): PaperAccountSnapshot { return this.broker.snapshot(); }
  entries(): readonly PaperLedgerEntry[] { return this.broker.entries(); }

  /** Execute a risk-admitted intent with dynamic simulation parameters. */
  async execute(intent: TradeIntent, params: ExecuteParams): Promise<PaperExecutionEvent> {
    const counter = ++this.counter;
    const simCfg: FillSimulatorConfig = {
      markPriceUsd: params.markPriceUsd,
      feeBps: params.feeBps,
      slippageBps: params.slippageBps,
      executedAtMs: params.executedAtMs,
      fillIdPrefix: params.fillIdPrefix,
    };
    try {
      const result: PaperBrokerResult = await this.broker.execute(intent, simCfg, counter);
      return {
        status: result.status,
        fillId: result.fill.fillId,
        executedPriceUsd: result.fill.priceUsd,
        quantity: result.fill.quantity,
        feeUsd: result.fill.feeUsd,
        snapshot: result.snapshot,
      };
    } catch (err: any) {
      return { status: 'failed', snapshot: this.broker.snapshot(), error: err?.message ?? String(err) };
    }
  }
}
