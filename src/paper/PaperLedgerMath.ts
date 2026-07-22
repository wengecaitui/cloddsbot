// Stage 3B4C8: Centralized paper ledger math — single source of truth for all rounding.

export const USD_DECIMALS = 8;
export const QUANTITY_DECIMALS = 12;
export const ACCOUNTING_EPSILON = 1e-7;

/** Round USD-denominated values to 8 decimal places. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** Round quantity values to 12 decimal places. */
export function roundQuantity(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

/** Normalize a value that is within epsilon of zero to exact 0. */
export function normalizeZero(value: number, epsilon: number = ACCOUNTING_EPSILON): number {
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) < epsilon) return 0;
  return value === 0 ? 0 : value; // ensure -0 becomes 0
}

export function assertFinitePositive(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number, got ${value}`);
  }
}

export function assertFiniteNonNegative(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number, got ${value}`);
  }
}

export function assertAccountingInvariant(left: number, right: number, label: string): void {
  const diff = Math.abs(left - right);
  if (!Number.isFinite(diff) || diff > ACCOUNTING_EPSILON) {
    throw new Error(`Accounting invariant violation: ${label}: left=${left} right=${right} diff=${diff} > epsilon=${ACCOUNTING_EPSILON}`);
  }
}
