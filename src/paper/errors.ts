// Stage 3B4C8: Typed paper ledger errors for audit and recovery.

export class PaperLedgerValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'PaperLedgerValidationError'; }
}
export class PaperLedgerExchangeMismatchError extends Error {
  constructor(message: string) { super(message); this.name = 'PaperLedgerExchangeMismatchError'; }
}
export class DuplicateFillConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'DuplicateFillConflictError'; }
}
export class StalePaperLedgerEventError extends Error {
  constructor(message: string) { super(message); this.name = 'StalePaperLedgerEventError'; }
}
export class ConflictingMarkError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictingMarkError'; }
}
export class PaperLedgerInvariantError extends Error {
  constructor(message: string) { super(message); this.name = 'PaperLedgerInvariantError'; }
}
export class PaperLedgerCorruptionError extends Error {
  constructor(message: string) { super(message); this.name = 'PaperLedgerCorruptionError'; }
}
export class UnsupportedPaperLedgerVersionError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedPaperLedgerVersionError'; }
}
export class PaperLedgerIdentityMismatchError extends Error {
  constructor(message: string) { super(message); this.name = 'PaperLedgerIdentityMismatchError'; }
}
