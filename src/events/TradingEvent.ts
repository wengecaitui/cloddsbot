// Stage 3A1-R2: Trading Event types — Exact 3-event flat contract
// Reuses WsTicker, WsKline, MarketBiasReportFull. No copy/reduction.

import type { WsTicker, WsKline } from '../data/types';
import type { MarketBiasReportFull } from '../types/market-bias';

export interface TradingEventPayloadMap {
  'market.ticker.updated':  { ticker: WsTicker; receivedAt: number };
  'market.kline.closed':    { kline: WsKline; receivedAt: number };
  'research.bias.updated':  { report: MarketBiasReportFull; receivedAt: number };
}

export type TradingEventType = keyof TradingEventPayloadMap;

/** Flattened event shape: { type, sequence, ...payloadFields } */
export type TradingEvent<T extends TradingEventType = TradingEventType> =
  T extends TradingEventType
    ? { type: T; sequence: number } & TradingEventPayloadMap[T]
    : never;

export class KlineClosedEventRejectedError extends Error {
  constructor(msg = 'market.kline.closed requires kline.confirm === true') {
    super(msg);
    this.name = 'KlineClosedEventRejectedError';
    Object.setPrototypeOf(this, KlineClosedEventRejectedError.prototype);
  }
}
