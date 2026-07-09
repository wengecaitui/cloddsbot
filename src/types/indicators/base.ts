// types/indicators/base.ts
// Base interface for all indicator results

export interface BaseResult {
  name: string;
  error?: string;
  lag_bars?: number;
}