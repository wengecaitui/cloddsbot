// Stage 3B4C1: Exchange-aware market identity
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

export type ExchangeId = 'bitget' | 'binance';

export interface ExchangeAwareMarketData {
  readonly exchange: ExchangeId;
  readonly instId: string;
}