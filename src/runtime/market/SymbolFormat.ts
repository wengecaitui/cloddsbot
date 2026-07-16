// Stage 3B1A-R1: Canonical ↔ exchange symbol mapping
// No automatic format guessing — only explicitly registered pairs.
// Canonical format: BASE/QUOTE (e.g. BTC/USDT).
// Exchange format: exchange-specific (e.g. BTCUSDT for Bitget).

const CANONICAL_RE = /^[A-Z][A-Z0-9]{0,20}\/[A-Z][A-Z0-9]{0,20}$/;
const EXCHANGE_RE = /^\S+$/;

export interface SymbolMapping {
  canonical: string;
  exchange: string;
}

export interface SymbolRegistry {
  toExchange(canonical: string): string;
  toCanonical(exchange: string): string;
  hasCanonical(canonical: string): boolean;
  hasExchange(exchange: string): boolean;
  mappings(): readonly SymbolMapping[];
}

export function createSymbolRegistry(mappings: readonly SymbolMapping[]): SymbolRegistry {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error('SymbolRegistry: at least one mapping required');
  }

  // Snapshot inputs immediately — caller can't mutate later
  const snapshot: Array<{ canonical: string; exchange: string }> = [];
  const canonMap = new Map<string, string>();
  const exchMap = new Map<string, string>();

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const c = m.canonical;
    const e = m.exchange;

    if (typeof c !== 'string' || !CANONICAL_RE.test(c)) {
      throw new Error(
        `SymbolRegistry: invalid canonical format "${c}" — ` +
        'must be BASE/QUOTE (uppercase A-Z, digits, max 21 chars per side)'
      );
    }

    if (typeof e !== 'string' || !EXCHANGE_RE.test(e)) {
      throw new Error(
        `SymbolRegistry: invalid exchange format "${e}" — ` +
        'must be non-empty with no whitespace'
      );
    }

    if (canonMap.has(c)) {
      throw new Error(`SymbolRegistry: duplicate canonical "${c}"`);
    }
    if (exchMap.has(e)) {
      throw new Error(`SymbolRegistry: duplicate exchange "${e}"`);
    }

    canonMap.set(c, e);
    exchMap.set(e, c);
    snapshot.push({ canonical: c, exchange: e });
  }

  return {
    toExchange(canonical: string): string {
      const e = canonMap.get(canonical);
      if (e === undefined) {
        throw new Error(`SymbolRegistry: unknown canonical "${canonical}"`);
      }
      return e;
    },

    toCanonical(exchange: string): string {
      const c = exchMap.get(exchange);
      if (c === undefined) {
        throw new Error(`SymbolRegistry: unknown exchange "${exchange}"`);
      }
      return c;
    },

    hasCanonical(canonical: string): boolean {
      return canonMap.has(canonical);
    },

    hasExchange(exchange: string): boolean {
      return exchMap.has(exchange);
    },

    mappings(): readonly SymbolMapping[] {
      return snapshot.map(s => ({ canonical: s.canonical, exchange: s.exchange }));
    },
  };
}
