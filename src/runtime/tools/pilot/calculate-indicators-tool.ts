// Stage 2B-2B: calculate_indicators Pilot Tool factory
// Dependency port + ToolSpec factory. COMPUTE, no trading, no bridge creation.

import type { Series } from '../../../data/types';
import type { IndicatorResult } from '../../../types/indicators';
import type { ToolSpec, ToolHandler } from '../contracts';
import { ToolInputValidationError } from '../contracts';

export interface IndicatorCalculationPort {
  calculateAll(request: { asset: string; series?: Series[] }): Promise<IndicatorResult[]>;
}

export interface CalculateIndicatorsInput {
  symbol: string;
  series: Series[];
}

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['symbol', 'series'],
  properties: {
    symbol: { type: 'string', description: 'Trading pair or asset symbol (e.g. BTC/USDT)' },
    series: {
      type: 'array', minItems: 1, maxItems: 5000,
      description: 'OHLCV price series for indicator computation',
      items: {
        type: 'object', required: ['open', 'high', 'low', 'close', 'volume'],
        properties: {
          open:  { type: 'number', description: 'Open price' },
          high:  { type: 'number', description: 'High price' },
          low:   { type: 'number', description: 'Low price' },
          close: { type: 'number', description: 'Close price' },
          volume:{ type: 'number', description: 'Volume (>= 0)' },
          ts:    { type: 'number', description: 'Optional bar timestamp (Unix ms)' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

function validateInput(raw: unknown): CalculateIndicatorsInput {
  if (typeof raw !== 'object' || raw === null) throw new ToolInputValidationError('calculate_indicators', 'Input must be a non-null object');
  const input = raw as Record<string, unknown>;
  if (typeof input.symbol !== 'string') throw new ToolInputValidationError('calculate_indicators', 'symbol must be a string');
  const symbol = input.symbol.trim();
  if (symbol.length === 0) throw new ToolInputValidationError('calculate_indicators', 'symbol must not be empty after trimming');
  if (symbol.length > 64) throw new ToolInputValidationError('calculate_indicators', 'symbol must not exceed 64 characters');
  if (/[\x00-\x1f\x7f]/.test(symbol)) throw new ToolInputValidationError('calculate_indicators', 'symbol must not contain control characters');
  if (!Array.isArray(input.series)) throw new ToolInputValidationError('calculate_indicators', 'series must be an array');
  if (input.series.length === 0) throw new ToolInputValidationError('calculate_indicators', 'series must have at least 1 bar');
  if (input.series.length > 5000) throw new ToolInputValidationError('calculate_indicators', 'series must not exceed 5000 bars');
  const series: Series[] = [];
  for (let i = 0; i < input.series.length; i++) {
    const bar = input.series[i];
    if (typeof bar !== 'object' || bar === null) throw new ToolInputValidationError('calculate_indicators', `series[${i}] must be a non-null object`);
    const b = bar as Record<string, unknown>;
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (typeof b[field] !== 'number' || !Number.isFinite(b[field])) throw new ToolInputValidationError('calculate_indicators', `series[${i}].${field} must be a finite number`);
    }
    if ((b as any).high < (b as any).low) throw new ToolInputValidationError('calculate_indicators', 'series[' + i + '] high < low');
    if ((b as any).volume < 0) throw new ToolInputValidationError('calculate_indicators', 'series[' + i + '].volume must be >= 0');
    if (b.ts !== undefined && !Number.isFinite(b.ts as number)) throw new ToolInputValidationError('calculate_indicators', 'series[' + i + '].ts must be finite');
    series.push({ open: b.open as number, high: b.high as number, low: b.low as number, close: b.close as number, volume: b.volume as number, ts: b.ts !== undefined ? (b.ts as number) : undefined });
  }
  return { symbol, series };
}

function validateOutput(output: unknown): IndicatorResult[] {
  if (!Array.isArray(output)) throw new ToolInputValidationError('calculate_indicators', 'output must be an array');
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    if (typeof item !== 'object' || item === null) throw new ToolInputValidationError('calculate_indicators', 'output[' + i + '] must be a non-null object');
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || (r.name as string).trim().length === 0) throw new ToolInputValidationError('calculate_indicators', 'output[' + i + '] must have a non-empty string name');
    if (Object.prototype.hasOwnProperty.call(r, 'error') && typeof r.error !== 'string') throw new ToolInputValidationError('calculate_indicators', 'output[' + i + '].error must be a string');
  }
  return output as IndicatorResult[];
}

function formatContent(output: IndicatorResult[]): string {
  const total = output.length;
  const errors = output.filter(r => (r as any).error !== undefined);
  const success = total - errors.length;
  const lines = [
    'Computed ' + total + ' indicators.',
    'Successful: ' + success,
  ];
  if (errors.length > 0) {
    lines.push('Partial failures: ' + errors.length);
    lines.push('Failed indicators: ' + errors.map(e => e.name).join(', '));
  }
  return lines.join('\n');
}

function createHandler(port: IndicatorCalculationPort): ToolHandler<CalculateIndicatorsInput, IndicatorResult[]> {
  return async (input, _ctx) => port.calculateAll({ asset: input.symbol, series: input.series });
}

export function createCalculateIndicatorsTool(port: IndicatorCalculationPort): ToolSpec<CalculateIndicatorsInput, IndicatorResult[]> {
  return {
    name: 'calculate_indicators',
    version: '1.0.0',
    description: 'Compute up to 14 technical indicators from OHLCV series (1-5000 bars). ' + 'Individual indicators may report data-insufficient errors without failing the entire result.',
    riskClass: 'COMPUTE',
    timeoutMs: 3000,
    idempotent: true,
    requiresApproval: false,
    parameters: INPUT_SCHEMA,
    validateInput,
    validateOutput,
    formatContent,
    handler: createHandler(port),
  };
}
