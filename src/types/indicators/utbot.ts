// types/indicators/utbot.ts
import type { BaseResult } from './base';

export interface UTBotResult extends BaseResult {
  name: 'UTBotAlerts';
  keyPass: number;
  atrPeriod: number;
  trailingStop: number;
  close: number;
  buy: boolean;
  sell: boolean;
  signal: 'BUY' | 'SELL' | 'HOLD';
  lag_bars: number;
}