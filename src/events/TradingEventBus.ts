// Stage 3A1-R2 + 3B4C2: TradingEventBus — typed pub/sub, strict invariants
// Stage 3B4C2: publish boundary validates exchange provenance.
//   - market.ticker.updated: requires ticker + isExchangeId(ticker.exchange).
//   - market.kline.closed:  requires kline + isExchangeId(kline.exchange) + confirm === true.
//   Invalid exchange is rejected synchronously (never reaches subscribers).
//   No separate `source` field — exchange travels on ticker/kline itself.
import { KlineClosedEventRejectedError } from './TradingEvent';
import type { TradingEventType, TradingEventPayloadMap, TradingEvent } from './TradingEvent';
import { isExchangeId } from '../data/MarketIdentity';

export class InvalidExchangeProvenanceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidExchangeProvenanceError';
    Object.setPrototypeOf(this, InvalidExchangeProvenanceError.prototype);
  }
}

export interface TradingEventBus {
  subscribe<T extends TradingEventType>(
    type: T,
    handler: (event: TradingEvent<T>) => void,
  ): () => void;
  publish<T extends TradingEventType>(
    type: T,
    payload: TradingEventPayloadMap[T],
  ): { delivered: number; failures: number; sequence: number };
}

export function createTradingEventBus(): TradingEventBus {
  let seq = 0;
  const subs = new Map<TradingEventType, Array<(e: unknown) => void>>();

  return {
    subscribe(type, handler) {
      const list = subs.get(type) ?? [];
      list.push(handler as (e: unknown) => void);
      subs.set(type, list);
      let unsubbed = false;
      return () => {
        if (unsubbed) return;
        unsubbed = true;
        const i = list.indexOf(handler as (e: unknown) => void);
        if (i !== -1) list.splice(i, 1);
      };
    },

    publish(type, payload) {
      // Stage 3B4C2: validate exchange provenance at the publish boundary.
      if (type === 'market.ticker.updated') {
        const p = payload as TradingEventPayloadMap['market.ticker.updated'];
        if (!p || !p.ticker) {
          throw new InvalidExchangeProvenanceError('market.ticker.updated requires ticker payload');
        }
        if (!isExchangeId((p.ticker as { exchange?: unknown }).exchange)) {
          throw new InvalidExchangeProvenanceError(
            `market.ticker.updated: invalid ticker.exchange: ${JSON.stringify((p.ticker as { exchange?: unknown }).exchange)}`,
          );
        }
      } else if (type === 'market.kline.closed') {
        const p = payload as TradingEventPayloadMap['market.kline.closed'];
        if (!p || !p.kline) {
          throw new KlineClosedEventRejectedError('market.kline.closed requires kline payload');
        }
        if (!isExchangeId((p.kline as { exchange?: unknown }).exchange)) {
          throw new InvalidExchangeProvenanceError(
            `market.kline.closed: invalid kline.exchange: ${JSON.stringify((p.kline as { exchange?: unknown }).exchange)}`,
          );
        }
        if (p.kline.confirm !== true) {
          throw new KlineClosedEventRejectedError();
        }
      }

      seq += 1;
      const sequence = seq;
      const event = { type, sequence, ...payload } as unknown as TradingEvent;

      const entries = subs.get(type);
      const handlers = entries ? [...entries] : [];
      let delivered = 0;
      let failures = 0;

      for (const h of handlers) {
        let ret: unknown;
        try { ret = h(event); } catch {
          failures += 1;
          continue;
        }
        if (ret !== null && typeof ret === 'object' && typeof (ret as { then?: unknown }).then === 'function') {
          failures += 1;
          Promise.resolve(ret as Promise<unknown>).catch(() => {});
          continue;
        }
        delivered += 1;
      }

      return { delivered, failures, sequence };
    },
  };
}
