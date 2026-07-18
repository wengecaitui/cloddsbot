// Stage 3B4C1 + 3B4C1-R1: Exchange-aware market identity
//
// Single canonical definition of ExchangeId and ExchangeAwareMarketData.
// Imported by data layer (types.ts, Collectors), runtime layer (PlanAwareCollector,
// ExchangeMarketDataProvider), and test code.
//
// Rules:
//   - ExchangeId is the ONLY canonical source of exchange identity in the project.
//   - ExchangeAwareMarketData.exchange is REQUIRED (not optional, never 'unknown').
//   - WsTicker and WsKline extend this interface (see types.ts).
//   - The data layer MUST NOT import from runtime/trading.
//   - ExchangeMarketDataProvider re-exports ExchangeId for backward compat.
//
// Stage 3B4C1-R1: hard runtime type guard. Rejects arbitrary strings, empty
// strings, case variants ('BITGET'), unknown/default exchange, and non-string
// values (null/undefined/number/object). Used by PlanAwareCollector to fail
// closed on invalid provenance.

export type ExchangeId = 'bitget' | 'binance';

export interface ExchangeAwareMarketData {
  readonly exchange: ExchangeId;
  readonly instId: string;
}

/**
 * Stage 3B4C1-R1: Runtime type guard for ExchangeId.
 *
 * Accepts EXACTLY 'bitget' or 'binance'. Rejects:
 *   - any other string (e.g. 'coinbase', 'okx')
 *   - empty string
 *   - case variants ('BITGET', 'Bitget', ' Binance ')
 *   - unknown / default-exchange placeholders
 *   - null / undefined / number / object / array
 *
 * Used at trust boundaries (PlanAwareCollector) to fail closed on invalid
 * provenance — invalid inputs are silently dropped, never thrown, never
 * re-emitted with a fabricated exchange.
 */
export function isExchangeId(value: unknown): value is ExchangeId {
  return value === 'bitget' || value === 'binance';
}