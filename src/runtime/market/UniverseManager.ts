// Stage 3B1A-R1: Controlled subscription universe policy
import type { MarketBiasReportFull } from '../../types/market-bias';
import { createSymbolRegistry } from './SymbolFormat';
import type { SymbolMapping, SymbolRegistry } from './SymbolFormat';

export interface SubscriptionEntry {
  readonly symbol: string;
  readonly exchangeSymbol: string;
  readonly intervals: readonly string[];
  readonly ticker: boolean;
}

export interface SubscriptionPlan {
  readonly version: number;
  readonly entries: readonly SubscriptionEntry[];
}

export interface UniverseConfig {
  registry: SymbolRegistry;
  allowedSymbols: readonly string[];
  staticSymbols: readonly string[];
  maxSymbols: number;
  allowedIntervals: readonly string[];
  defaultIntervals: readonly string[];
  hardBlacklist?: readonly string[];
  allowResearchExpansion?: boolean;
}

export interface UniversePlanInput {
  entries: readonly {
    symbol: string;
    intervals?: readonly string[];
    ticker?: boolean;
  }[];
}

export interface UniverseUpdateResult {
  changed: boolean;
  previousVersion: number;
  version: number;
  added: readonly string[];
  removed: readonly string[];
  changedEntries: readonly string[];
}

export interface UniverseManager {
  getPlan(): SubscriptionPlan;
  setPlan(next: UniversePlanInput): UniverseUpdateResult;
  addSymbol(symbol: string, intervals?: readonly string[]): UniverseUpdateResult;
  removeSymbol(symbol: string): UniverseUpdateResult;
  applyResearchReport(report: MarketBiasReportFull): UniverseUpdateResult;
  hasPendingPlan(): boolean;
  markApplied(version: number): void;
}

function sortStrings(arr: readonly string[]): string[] {
  return [...arr].sort();
}

function canonicalizeIntervals(intervals: readonly string[]): string[] {
  return sortStrings([...new Set(intervals)]);
}

function entryKey(e: { symbol: string; exchangeSymbol: string; intervals: readonly string[]; ticker: boolean }): string {
  return `${e.symbol}|${e.exchangeSymbol}|${canonicalizeIntervals(e.intervals).join(',')}|${e.ticker}`;
}

function throwIfInvalidConfig(config: UniverseConfig): void {
  const registry = config.registry ?? createSymbolRegistry([]);
  const allowedSet = new Set(config.allowedSymbols);

  // maxSymbols positive integer
  const ms = config.maxSymbols;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isInteger(ms) || ms <= 0) {
    throw new Error(`UniverseManager: maxSymbols must be a positive integer, got ${ms}`);
  }

  // allowedIntervals must not be empty
  if (!Array.isArray(config.allowedIntervals) || config.allowedIntervals.length === 0) {
    throw new Error('UniverseManager: allowedIntervals must be a non-empty array');
  }
  const allowedIntervalSet = new Set(config.allowedIntervals);
  if (allowedIntervalSet.size !== config.allowedIntervals.length) {
    throw new Error('UniverseManager: allowedIntervals contains duplicates');
  }

  // defaultIntervals must not be empty
  if (!Array.isArray(config.defaultIntervals) || config.defaultIntervals.length === 0) {
    throw new Error('UniverseManager: defaultIntervals must be a non-empty array');
  }
  const defaultSet = new Set(config.defaultIntervals);
  if (defaultSet.size !== config.defaultIntervals.length) {
    throw new Error('UniverseManager: defaultIntervals contains duplicates');
  }

  for (const iv of defaultSet) {
    if (!allowedIntervalSet.has(iv)) {
      throw new Error(`UniverseManager: defaultInterval "${iv}" must be in allowedIntervals`);
    }
  }

  // hardBlacklist entries must be registered
  const hbl = config.hardBlacklist ?? [];
  const hblSet = new Set(hbl);
  if (hblSet.size !== hbl.length) {
    throw new Error('UniverseManager: hardBlacklist contains duplicates');
  }
  for (const s of hblSet) {
    if (!registry.hasCanonical(s)) {
      throw new Error(`UniverseManager: hardBlacklist contains unregistered canonical "${s}"`);
    }
  }

  // allowedSymbols must all be registered
  if (allowedSet.size !== config.allowedSymbols.length) {
    throw new Error('UniverseManager: allowedSymbols contains duplicates');
  }
  for (const s of allowedSet) {
    if (!registry.hasCanonical(s)) {
      throw new Error(`UniverseManager: allowedSymbols contains unregistered canonical "${s}"`);
    }
  }

  // staticSymbols: dedup and validate
  const staticSet = new Set(config.staticSymbols);
  if (staticSet.size > ms) {
    throw new Error(`UniverseManager: staticSymbols (${staticSet.size}) exceeds maxSymbols (${ms})`);
  }
  for (const s of staticSet) {
    if (!registry.hasCanonical(s)) {
      throw new Error(`UniverseManager: staticSymbols contains unregistered canonical "${s}"`);
    }
    if (!allowedSet.has(s)) {
      throw new Error(`UniverseManager: staticSymbols "${s}" not in allowedSymbols`);
    }
    if (hblSet.has(s)) {
      throw new Error(`UniverseManager: staticSymbols "${s}" is on hardBlacklist`);
    }
  }
}

function validateIntervalsNotEmpty(intervals: readonly string[] | undefined, context: string): void {
  if (intervals !== undefined && (!Array.isArray(intervals) || intervals.length === 0)) {
    throw new Error(`UniverseManager: ${context} must be non-empty or undefined`);
  }
}

export function createUniverseManager(config: UniverseConfig): UniverseManager {
  throwIfInvalidConfig(config);

  const registry = config.registry ?? createSymbolRegistry([]);
  const allowedSet = new Set(config.allowedSymbols);
  const allowedIntervalSet = new Set(config.allowedIntervals);
  const defaultIntervals = canonicalizeIntervals(config.defaultIntervals);
  const hardBlacklist = new Set(config.hardBlacklist ?? []);
  const allowResearchExpansion = config.allowResearchExpansion ?? false;
  const maxSymbols = config.maxSymbols;

  let version = 1;
  let entries = new Map<string, SubscriptionEntry>();
  let pending = true;

  function buildEntry(symbol: string, intervals?: readonly string[], ticker?: boolean): SubscriptionEntry {
    validateIntervalsNotEmpty(intervals, `intervals for "${symbol}"`);

    if (!registry.hasCanonical(symbol)) {
      throw new Error(`UniverseManager: unknown canonical "${symbol}"`);
    }
    if (!allowedSet.has(symbol)) {
      throw new Error(`UniverseManager: symbol "${symbol}" not in allowedSymbols`);
    }
    if (hardBlacklist.has(symbol)) {
      throw new Error(`UniverseManager: symbol "${symbol}" is on hardBlacklist`);
    }
    const ivs = intervals !== undefined
      ? canonicalizeIntervals(intervals)
      : defaultIntervals;
    for (const iv of ivs) {
      if (!allowedIntervalSet.has(iv)) {
        throw new Error(`UniverseManager: interval "${iv}" not in allowedIntervals`);
      }
    }
    return {
      symbol,
      exchangeSymbol: registry.toExchange(symbol),
      intervals: ivs,
      ticker: ticker ?? true,
    };
  }

  function sortedEntries(map: Map<string, SubscriptionEntry>): SubscriptionEntry[] {
    return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  function computeDiff(prev: Map<string, SubscriptionEntry>, next: Map<string, SubscriptionEntry>):
    { added: string[]; removed: string[]; changedEntries: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const changedEntries: string[] = [];
    for (const [sym, e] of next) {
      const pe = prev.get(sym);
      if (!pe) added.push(sym);
      else if (entryKey(pe) !== entryKey(e)) changedEntries.push(sym);
    }
    for (const sym of prev.keys()) {
      if (!next.has(sym)) removed.push(sym);
    }
    return {
      added: sortStrings(added),
      removed: sortStrings(removed),
      changedEntries: sortStrings(changedEntries),
    };
  }

  // Initial plan from staticSymbols (deduped via Set)
  const staticSet = new Set(config.staticSymbols);
  for (const s of staticSet) {
    entries.set(s, buildEntry(s));
  }

  function applyNext(nextMap: Map<string, SubscriptionEntry>): UniverseUpdateResult {
    const prevVersion = version;
    const diff = computeDiff(entries, nextMap);
    const changed = diff.added.length > 0 || diff.removed.length > 0 || diff.changedEntries.length > 0;

    if (!changed) {
      return {
        changed: false,
        previousVersion: prevVersion,
        version: prevVersion,
        added: [],
        removed: [],
        changedEntries: [],
      };
    }

    if (nextMap.size > maxSymbols) {
      throw new Error(`UniverseManager: plan size ${nextMap.size} exceeds maxSymbols ${maxSymbols}`);
    }

    entries = nextMap;
    version += 1;
    pending = true;

    return {
      changed: true,
      previousVersion: prevVersion,
      version,
      added: diff.added,
      removed: diff.removed,
      changedEntries: diff.changedEntries,
    };
  }

  function planFromInput(input: UniversePlanInput): Map<string, SubscriptionEntry> {
    const map = new Map<string, SubscriptionEntry>();
    for (const e of input.entries) {
      if (map.has(e.symbol)) {
        throw new Error(`UniverseManager: duplicate plan symbol "${e.symbol}"`);
      }
      const entry = buildEntry(e.symbol, e.intervals, e.ticker);
      map.set(entry.symbol, entry);
    }
    return map;
  }

  return {
    getPlan(): SubscriptionPlan {
      return {
        version,
        entries: sortedEntries(entries).map(e => ({
          symbol: e.symbol,
          exchangeSymbol: e.exchangeSymbol,
          intervals: [...e.intervals],
          ticker: e.ticker,
        })),
      };
    },

    setPlan(next: UniversePlanInput): UniverseUpdateResult {
      const nextMap = planFromInput(next);
      return applyNext(nextMap);
    },

    addSymbol(symbol: string, intervals?: readonly string[]): UniverseUpdateResult {
      validateIntervalsNotEmpty(intervals, `intervals for "${symbol}"`);
      const nextMap = new Map(entries);
      nextMap.set(symbol, buildEntry(symbol, intervals));
      return applyNext(nextMap);
    },

    removeSymbol(symbol: string): UniverseUpdateResult {
      if (!entries.has(symbol)) {
        return {
          changed: false,
          previousVersion: version,
          version,
          added: [],
          removed: [],
          changedEntries: [],
        };
      }
      const nextMap = new Map(entries);
      nextMap.delete(symbol);
      return applyNext(nextMap);
    },

    applyResearchReport(report: MarketBiasReportFull): UniverseUpdateResult {
      const nextMap = new Map(entries);
      const reportBlacklist = new Set(report.blacklist ?? []);

      for (const sym of reportBlacklist) {
        if (nextMap.has(sym)) nextMap.delete(sym);
      }

      if (allowResearchExpansion) {
        for (const sym of report.whitelist) {
          if (hardBlacklist.has(sym)) continue;
          if (reportBlacklist.has(sym)) continue;
          if (!allowedSet.has(sym)) continue;
          if (nextMap.has(sym)) continue;
          if (nextMap.size >= maxSymbols) break;
          nextMap.set(sym, buildEntry(sym));
        }
      }

      return applyNext(nextMap);
    },

    hasPendingPlan(): boolean {
      return pending;
    },

    markApplied(v: number): void {
      if (v === version) {
        pending = false;
      }
    },
  };
}
