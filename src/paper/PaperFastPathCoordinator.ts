// Stage 3B4C14: Paper Fast Path Coordinator — thin bridge between FastPipeline and PaperExecutionService.
// Only paper execution; no real Broker/Exchange/API/order calls. Fail-isolated: paper failures don't
// corrupt pipeline results or ledger state.

import type { ExchangeId } from '../data/MarketIdentity';
import { isExchangeId } from '../data/MarketIdentity';
import type { TradeIntent } from '../types/trade-intent';
import type { ExecutionQuote } from '../types/execution-quote';
import type { PaperAccountSnapshot } from '../types/paper-account';
import type { FastPipeline, FastPipelineResult } from '../pipeline/FastPipeline';
import { PaperExecutionService, type PaperExecutionEvent, type ExecuteParams } from './PaperExecutionService';
import type { PaperBrokerPersistence } from './PaperBroker';

export interface PaperCoordinatorConfig {
  service: PaperExecutionService;
  exchange: ExchangeId;
  /** Default fee rate if not overridden per call. */
  defaultFeeBps?: number;
  /** Default slippage if not overridden per call. */
  defaultSlippageBps?: number;
}

export interface PaperCoordinatorResult {
  /** Original FastPipeline result — never modified by paper path. */
  pipelineResult: FastPipelineResult;
  /** Paper execution event — only present when pipeline produced trade intent + valid quote. */
  paperEvent?: PaperExecutionEvent;
}

export class PaperFastPathCoordinator {
  constructor(private config: PaperCoordinatorConfig) {}

  /**
   * Run FastPipeline on a signal, and if a trade is risk-admitted AND execution quote
   * is present on the result, execute it through the paper service.
   *
   * @param pipeline  FastPipeline instance to call.
   * @param signal    Spread-Scanner signal forwarded to FastPipeline.
   * @param params    Optional per-call fee/slippage overrides.
   */
  async run(
    pipeline: FastPipeline,
    signal: { exchange: ExchangeId; symbol: string; source: string; signalData?: Record<string, unknown> },
    params?: { feeBps?: number; slippageBps?: number },
  ): Promise<PaperCoordinatorResult> {
    // 1. Validate exchange identity
    if (signal.exchange !== this.config.exchange) {
      throw new Error(`PaperCoordinator: signal exchange ${signal.exchange} !== ${this.config.exchange}`);
    }

    // 2. Call FastPipeline exactly once
    const pipelineResult = await pipeline.execute(signal);

    // 3. Only paper-execute on trade decision with valid tradeIntent + executionQuote
    if (pipelineResult.decision !== 'trade' || !pipelineResult.tradeIntent) {
      return { pipelineResult };
    }

    const quote = (pipelineResult as any).executionQuote as ExecutionQuote | undefined;
    if (!quote || !isExchangeId(quote.exchange) || quote.exchange !== this.config.exchange) {
      return { pipelineResult }; // missing/invalid quote → skip paper
    }

    // 4. Validate quote data
    if (!Number.isFinite(quote.markPriceUsd) || quote.markPriceUsd <= 0) return { pipelineResult };
    if (!Number.isFinite(quote.executedAtMs) || quote.executedAtMs < 0) return { pipelineResult };

    const feeBps = params?.feeBps ?? this.config.defaultFeeBps ?? 10;
    const slippageBps = params?.slippageBps ?? this.config.defaultSlippageBps ?? 5;
    if (!Number.isFinite(feeBps) || feeBps < 0) return { pipelineResult };
    if (!Number.isFinite(slippageBps) || slippageBps < 0) return { pipelineResult };

    const execParams: ExecuteParams = {
      markPriceUsd: quote.markPriceUsd,
      feeBps,
      slippageBps,
      executedAtMs: quote.executedAtMs,
    };

    // 5. Execute through paper service — fail-isolated: errors don't propagate
    try {
      const paperEvent = await this.config.service.execute(pipelineResult.tradeIntent, execParams);
      return { pipelineResult, paperEvent };
    } catch {
      // Paper failure is silent — pipeline result stands unchanged
      return { pipelineResult };
    }
  }
}
