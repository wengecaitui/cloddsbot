// Stage 3B4C14-R1: Paper Fast Path Coordinator — bind pipeline+service+exchange at construct.
import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { ExecutionQuote } from '../types/execution-quote';
import type { PaperAccountSnapshot } from '../types/paper-account';
import type { FastPipeline, FastPipelineResult } from '../pipeline/FastPipeline';
import { PaperExecutionService, type PaperExecutionEvent, type ExecuteParams } from './PaperExecutionService';

export interface PaperCoordinatorResult {
  readonly pipelineResult: FastPipelineResult;
  readonly paperEvent?: PaperExecutionEvent;
}

export class PaperFastPathCoordinator {
  constructor(
    private pipeline: FastPipeline,
    private service: PaperExecutionService,
    private exchange: ExchangeId,
  ) {
    if (!isExchangeId(exchange)) throw new Error('PaperCoordinator: invalid exchange');
  }

  async run(
    signal: { exchange: ExchangeId; symbol: string; source: string },
    params: { feeBps: number; slippageBps: number },
  ): Promise<PaperCoordinatorResult> {
    if (signal.exchange !== this.exchange) throw new Error('PaperCoordinator: signal exchange mismatch');
    if (!Number.isFinite(params.feeBps) || params.feeBps < 0) throw new Error('PaperCoordinator: invalid feeBps');
    if (!Number.isFinite(params.slippageBps) || params.slippageBps < 0) throw new Error('PaperCoordinator: invalid slippageBps');

    const pipelineResult = await this.pipeline.execute(signal);

    if (pipelineResult.decision !== 'trade' || !pipelineResult.tradeIntent) {
      return { pipelineResult };
    }

    const quote = pipelineResult.executionQuote;
    if (!quote) return { pipelineResult };
    if (!isExchangeId(quote.exchange) || quote.exchange !== this.exchange) return { pipelineResult };
    if (quote.exchange !== signal.exchange || quote.symbol !== signal.symbol) return { pipelineResult };
    if (!Number.isFinite(quote.markPriceUsd) || quote.markPriceUsd <= 0) return { pipelineResult };
    if (!Number.isFinite(quote.executedAtMs) || quote.executedAtMs < 0) return { pipelineResult };
    if (!Number.isInteger(quote.snapshotVersion) || quote.snapshotVersion < 0) return { pipelineResult };

    const execParams: ExecuteParams = {
      markPriceUsd: quote.markPriceUsd,
      feeBps: params.feeBps,
      slippageBps: params.slippageBps,
      executedAtMs: Date.now(),
    };

    try {
      const paperEvent = await this.service.execute(pipelineResult.tradeIntent, execParams);
      return { pipelineResult, paperEvent };
    } catch {
      return { pipelineResult };
    }
  }
}
