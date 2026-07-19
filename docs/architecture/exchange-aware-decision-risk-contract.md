# Exchange-Aware Decision and Risk Contract

> Stage 3B4C4-AUDIT  
> Baseline: `7c7a8a85a4c75a99919c207ec34504839f24b056`  
> Tracks: [exchange-aware-chain](https://github.com/wengecaitui/DSbot/labels)

---

## Table of Contents

1. [Fresh Code Audit — Provenance Gap Table](#1-fresh-code-audit--provenance-gap-table)
2. [Confirmed Known Problems](#2-confirmed-known-problems)
3. [Canonical Identity Contract](#3-canonical-identity-contract)
4. [Type Contract Proposals](#4-type-contract-proposals)
5. [ReportStore Isolation](#5-reportstore-isolation)
6. [Composition Root Contract](#6-composition-root-contract)
7. [EventBus Provenance Contract](#7-eventbus-provenance-contract)
8. [Execution Safety Boundary](#8-execution-safety-boundary)
9. [Migration Plan — Atomic Sequence](#9-migration-plan--atomic-sequence)
10. [Test Matrix](#10-test-matrix)
11. [Baseline Test Count (pre-migration)](#11-baseline-test-count-pre-migration)
12. [Implementation File List](#12-implementation-file-list)

---

## 1. Fresh Code Audit — Provenance Gap Table

### 1A. Types / Structs

| Type / Interface | File | Has `exchange`? | Type | Optional? | Default? | Cross-exchange collision risk? |
|---|---|---|---|---|---|---|
| `ExchangeId` | `MarketIdentity.ts` | **n/a** (is the type) | `'bitget'\|'binance'` | — | — | — |
| `ExchangeAwareMarketData` | `MarketIdentity.ts` | **yes** | `ExchangeId` | **no** | **no** | **no** (validated) |
| `WsTicker` | `data/types.ts` | **yes** (via `ExchangeAwareMarketData`) | `ExchangeId` | no | no | no |
| `WsKline` | `data/types.ts` | **yes** (via same) | `ExchangeId` | no | no | no |
| `MarketSnapshot` | `MarketSnapshot.ts` | **yes** | `ExchangeId` | no | no | no |
| `MarketBiasReport` | `types/market-bias.ts` | **MISSING** | — | — | — | **HIGH** — both exchanges write same file |
| `AssetBias` | `types/market-bias.ts` | no (inherits from parent) | — | — | — | no (report-level field) |
| `MarketBiasMeta.source` | `types/market-bias.ts` | SignalSource (`hermes_cron\|spread_scanner\|manual`), not ExchangeId | — | — | — | OK — different dimension |
| `MarketBiasReportFull` | `types/market-bias.ts` | **MISSING** (extends `MarketBiasReport`) | — | — | — | **HIGH** |
| `FastPipelineConfig` | `FastPipeline.ts` | **MISSING** at top level | — | — | — | **HIGH** — router injected without exchange guard |
| `FastPipelineMarketData` | `FastPipeline.ts` | **yes** | `ExchangeId` | no | no | no (validated in constructor) |
| `FastPipelineResult` | `FastPipeline.ts` | **MISSING** | — | — | — | **MEDIUM** — downstream consumers can't determine source |
| `SlowPipelineConfig` | `SlowPipeline.ts` | **MISSING** | — | — | — | **HIGH** — no exchange binding |
| `RouterConfig` | `ExecutionRouter.ts` | **MISSING** | — | — | — | **HIGH** |
| `RouteDecision` | `ExecutionRouter.ts` | **MISSING** | — | — | — | **HIGH** |
| `RouteDecision.source` | `ExecutionRouter.ts` | `SignalSource` (not ExchangeId) | — | — | — | OK — different dimension |
| `KillSwitchConfig` | `KillSwitch.ts` | **MISSING** | — | — | — | **HIGH** |
| `RiskSnapshot` | `KillSwitch.ts` | **MISSING** | — | — | — | **HIGH** |
| `ReportStoreConfig` | `ReportStore.ts` | **MISSING** | — | — | `bias.json` | **HIGH** — both exchanges write to same file |
| `TradingRuntimeOptions` | `TradingRuntime.ts` | **yes** (required via `exchange`) | `ExchangeId` | no | no | no |
| `ExchangeMarketDataProvider.exchange` | `ExchangeMarketDataProvider.ts` | **yes** | `ExchangeId` | no | no | no |

### 1B. Method Signatures

| Method | File | Input `exchange` | Output `exchange` | Risk |
|---|---|---|---|---|
| `FastPipeline.execute(signal)` | `FastPipeline.ts` | **MISSING** from signal input | **MISSING** from result | **HIGH** — signal lacks provenance |
| `SlowPipeline.run(symbol)` | `SlowPipeline.ts` | **MISSING** | **MISSING** from report | **HIGH** — adapter payload unchecked |
| `ExecutionRouter.route(signal)` | `ExecutionRouter.ts` | **MISSING** from signal | **MISSING** from RouteDecision | **HIGH** |
| `ExecutionRouter.updateBiasReport(report)` | `ExecutionRouter.ts` | no exchange guard on input | n/a | **HIGH** — bitget report can land on binance router |
| `ExecutionRouter.getBiasReport()` | `ExecutionRouter.ts` | n/a | **MISSING** — memory holds one report | **HIGH** |
| `ExecutionRouter.loadBiasReportFromDisk()` | `ExecutionRouter.ts` | no exchange guard | **MISSING** | **HIGH** |
| `ExecutionRouter.checkFastPathTimeout()` | `ExecutionRouter.ts` | **MISSING** | n/a | **LOW** (internal, but affects wrong KS) |
| `KillSwitch.check(symbol, positionUsd)` | `KillSwitch.ts` | **MISSING** | n/a | **HIGH** — wrong-exchange symbol not caught |
| `KillSwitch.recordLoss(usd)` | `KillSwitch.ts` | **MISSING** | n/a | **HIGH** |
| `KillSwitch.lock(reason)` | `KillSwitch.ts` | **MISSING** | n/a | **HIGH** |
| `KillSwitch.unlock()` | `KillSwitch.ts` | **MISSING** | n/a | **HIGH** |
| `KillSwitch.snapshot()` | `KillSwitch.ts` | **MISSING** | **MISSING** | **HIGH** |
| `ReportStore.write(report)` | `ReportStore.ts` | no exchange parameter | n/a | **HIGH** — file collision |
| `ReportStore.read<T>()` | `ReportStore.ts` | no exchange parameter | **MISSING** | **HIGH** — reads wrong exchange's data |

### 1C. Call Sites (need modification)

**Production call sites:**

| File | Line(s) | Pattern | Change needed |
|---|---|---|---|
| `router/ExecutionRouter.ts` | 134-147 | `updateBiasReport(report)` — writes to single file | Add exchange param + file isolation |
| `router/ExecutionRouter.ts` | 152-160 | `loadBiasReportFromDisk()` — reads single file | Add exchange param + file isolation |
| `router/ExecutionRouter.ts` | 89-124 | `route(signal)` — no exchange on input or output | Add `exchange` to signal + RouteDecision |
| `router/ExecutionRouter.ts` | 192-201 | `checkFastPathTimeout()` — calls `killSwitch.lock()` | Add exchange to KS method |
| `router/KillSwitch.ts` | 78 | `check(symbol, positionUsd)` | Add `exchange` param |
| `router/KillSwitch.ts` | 103 | `recordLoss(usd)` | Add `exchange` param |
| `router/KillSwitch.ts` | 112 | `lock(reason)` | Add `exchange` param |
| `router/KillSwitch.ts` | 118 | `unlock()` | Add `exchange` param |
| `router/KillSwitch.ts` | 125 | `snapshot()` | Add `exchange` param + `RiskSnapshot.exchange` |
| `pipeline/FastPipeline.ts` | 128-131 | `execute(signal)` — signal has no exchange | Add `exchange` to signal input |
| `pipeline/FastPipeline.ts` | 59-74 | `FastPipelineResult` — no exchange field | Add `exchange: ExchangeId` |
| `pipeline/FastPipeline.ts` | 308-313 | `emit('decision_made', ...)` — no exchange | Add exchange to emitted payload |
| `pipeline/SlowPipeline.ts` | 77 | `run(symbol, tradeDate?)` — no exchange | Add `exchange` parameter |
| `pipeline/SlowPipeline.ts` | 89-92 | adapter payload — no exchange | Add `exchange` field |
| `pipeline/SlowPipeline.ts` | 111-119 | report spread — from untrusted adapter | Override `exchange` with bound value |
| `pipeline/SlowPipeline.ts` | 175-207 | `buildFallbackReport` — no exchange | Add `exchange` param |
| `events/TradingEventBus.ts` | 48-73 | `publish` validates ticker/kline exchange, **not** `research.bias.updated` | Add `report.exchange` validation |

**Test files needing modification:**

| File | Approximate test count | Nature of changes |
|---|---|---|
| `tests/router/kill-switch.test.ts` | ~25 | All KS methods gain `exchange` param |
| `tests/router/execution-router.test.ts` | ~30 | route/updateBiasReport/load/get all gain `exchange` |
| `tests/pipeline/fast-pipeline-market.test.ts` | 18 | `FastPipelineConfig` gets `exchange`, signal/result gain `exchange` |
| `tests/pipeline/slow-pipeline.test.ts` | ~15 | `SlowPipelineConfig` + `run` + fixtures gain `exchange` |
| `tests/events/trading-event-bus.test.ts` | 21 | Add `report.exchange` validation tests |
| `tests/store/report-store.test.ts` | ~8 | Exchange-isolated file paths |
| `tests/runtime/trading/trading-runtime.test.ts` | 68 | Composition-root exchange binding tests |
| `tests/runtime/trading/bitget-trading-runtime.test.ts` | 46 | No change (wrapper fixes exchange) |
| `tests/runtime/trading/binance-trading-runtime.test.ts` | 16 | No change (wrapper fixes exchange) |
| `tests/runtime/trading/exchange-trading-runtime.test.ts` | 15 | Exchange binding regression |
| `tests/runtime/trading/multi-exchange-runtime.test.ts` | 56 | Verification that both sides' reports are independent |

---

## 2. Confirmed Known Problems

Each item verified against current source:

1. **`FastPipeline.execute` input has no exchange.**  
   `signal` parameter is `{ source: string; symbol: string; signalData?: ... }`. No exchange field.  
   → FastPipeline cannot verify signal provenance against its own exchange binding.

2. **`FastPipelineResult` has no exchange.**  
   Output type is `{ decision, direction, symbol, ... }`. No exchange field.  
   → Callers receiving a result cannot determine which exchange it's for.

3. **`FastPipelineConfig` has no exchange at top level.**  
   Exchange only exists on optional `marketData` sub-object. When `marketData` is absent, the pipeline has **no** trusted exchange identity.  
   → Consumers of `FastPipeline` without marketData cannot bind decisions to an exchange.

4. **`SlowPipelineConfig` / `run` / report have no exchange.**  
   `SlowPipelineConfig` has no exchange field. `run(symbol)` has no exchange parameter. The adapter payload is untyped `Record<string, unknown>`. Both normal and fallback reports are constructed without exchange.  
   → A SlowPipeline running for bitget can overwrite binance's report. Both pipelines write to the same router, which writes to the same file.

5. **TradingAgents adapter payload has no exchange.**  
   The payload sent to the Python bridge is `{ asset, symbol, ... }` — no exchange field. The adapter returns an untyped response whose `report` is spread directly into `MarketBiasReportFull` without overriding exchange.  
   → An adapter could return a report with wrong exchange (or no exchange) and it would propagate unchecked.

6. **`MarketBiasReport` / `MarketBiasReportFull` have no exchange.**  
   The root-level `MarketBiasReport` interface has `{ timestamp, globalBias, assets, ... }` — no exchange anywhere.  
   → Two exchanges produce indistinguishable reports. Any consumer that receives a report from an EventBus subscription cannot know which exchange it describes without independent context.

7. **`research.bias.updated` can only carry exchange inside `report`.**  
   Current EventBus contract has `{ report: MarketBiasReportFull; receivedAt: number }`. Since `MarketBiasReportFull` lacks exchange, the event has no exchange. The correct fix is to add exchange to the report, not add a separate source field.  
   → Config (6) must be fixed first; EventBus then validates `report.exchange` automatically.

8. **`ExecutionRouter.route` input and `RouteDecision` have no exchange.**  
   `route(signal)` takes `{ source, symbol?, signalData? }`. `RouteDecision` returns `{ path, source, reason, biasReport?, defensiveMode }`. Neither has exchange.  
   → Router cannot verify it's routing for the correct exchange; the decision output is ambiguous.

9. **`ExecutionRouter` holds a single `biasReport` in memory.**  
   Field `private biasReport: MarketBiasReportFull | null` — one slot.  
   → In a multi-exchange setup, the second exchange's report silently overwrites the first.

10. **Two independent routers write to the same file by default.**  
    `ReportStore` default filename is `bias.json` — every router writes to `~/.clodds/market-bias/bias.json`.  
    → Bitget and Binance routers overwrite each other's reports on disk. After a restart, whichever file was written last is loaded for both exchanges.

11. **`KillSwitch.check`/`recordLoss`/`lock`/`unlock`/`snapshot` have no exchange.**  
    Every method takes only business parameters; none receives an `ExchangeId`.  
    → Bitget positions and Binance positions share the same loss counter and lock state. A loss on Binance can lock trading on Bitget.

12. **`RiskSnapshot` has no exchange.**  
    Return type `{ currentExposureUsd, todayRealizedLossUsd, ... }` — no exchange.  
    → Snapshot consumers cannot distinguish which exchange's risk state they're looking at.

13. **`TradingRuntimeOptions.exchange` is required and trusted.**  
    Already validated in `TradingRuntime.ts` — `if (!isExchangeId(exchange)) throw ...`. Exchange is a required field. Composition roots (`BitgetTradingRuntime`, `BinanceTradingRuntime`) fix it internally.  
    → This is the correct single source of truth for all child components. 3B4C4 must propagate this value downward rather than re-inferring it.

14. **`MultiExchangeRuntime` currently enforces router/KillSwitch non-sharing.**  
    `assertIsolation` checks `bitget.router !== binance.router` and `bitget.router.killSwitch !== binance.router.killSwitch`.  
    → 3B4C4 must NOT relax this. Each exchange gets its own router + KS. The isolation checks remain.

---

## 3. Canonical Identity Contract

### 3A. Identity Chain

Every component in the decision and risk pipeline must derive its `ExchangeId` from a single source: the `TradingRuntimeOptions.exchange` that was validated at construction. The chain is:

```
TradingRuntimeOptions.exchange
  → TradingRuntime.exchange
    → FastPipelineConfig.exchange
      → FastPipelineMarketData.exchange  (must match, may be removed in favor of config.exchange)
    → SlowPipelineConfig.exchange
    → ExecutionRouter(RouterConfig) → ExecutionRouter.exchange
    → KillSwitch(KillSwitchConfig) → KillSwitch.exchange
      → FastPipelineResult.exchange
      → RouteDecision.exchange
      → MarketBiasReport.exchange
      → RiskSnapshot.exchange
```

### 3B. Type Rules

```
exchange field:
  - type MUST be ExchangeId          NOT string / unknown / optional
  - REQUIRED                         NOT optional / nullable
  - validated at construction        via isExchangeId()
  - NEVER defaulted                  NOT 'bitget' nor 'binance' as fallback
  - NEVER inferred                   NOT from symbol, exchangeSymbol, URL, or filename
  - fail closed on mismatch          throw at construction / call time
```

### 3C. SignalSource Independence

`SignalSource` (`hermes_cron | spread_scanner | manual`) describes *how* a signal was triggered. It is NOT an exchange identifier. These two dimensions are orthogonal:

```typescript
// CORRECT — both dimensions present
{ exchange: 'bitget', source: 'spread_scanner', symbol: 'BTC/USDT' }

// WRONG — SignalSource used as exchange
{ source: 'hermes_cron', symbol: 'BTC/USDT' }

// WRONG — exchange used as source
{ exchange: 'bitget', symbol: 'BTC/USDT' }
```

---

## 4. Type Contract Proposals

All proposals are verified against current source compatibility.

### 4A. MarketBiasReport

```typescript
export interface MarketBiasReport {
  readonly exchange: ExchangeId;           // NEW — required, validated
  readonly timestamp: number;
  readonly updatedAt: number;
  readonly globalBias: 'bullish' | 'bearish' | 'neutral';
  readonly confidence: number;
  readonly assets: AssetBias[];            // AssetBias NOT extended with exchange
  readonly globalLongShortRatio: number;
  readonly globalVolatility: number;
  readonly fearGreedIndex: number;
  readonly fundingStatus: 'positive' | 'negative' | 'neutral';
  readonly whitelist: string[];
  readonly blacklist: string[];
  readonly riskEvents: string[];
}
```

**Rationale for `exchange` at root, not on `AssetBias`:**
- Exchange is invariant across all assets in a single report.
- Adding exchange to every `AssetBias` would be redundant and increase payload size.
- Consumers either trust the report-level exchange or should not use the report.

**Adapter payload:**
- `SlowPipeline` must `spread` the raw report, then override `exchange` with its bound value:

```typescript
const report: MarketBiasReportFull = {
  ...raw.report,
  exchange: boundExchange,  // OVERRIDE — never trust adapter
  meta: { source: 'hermes_cron', ... },
};
```

### 4B. FastPipeline

**Recommended design (single exchange source):**

```typescript
export interface FastPipelineConfig {
  readonly exchange: ExchangeId;           // NEW — required, validated at construction
  readonly router: ExecutionRouter;
  readonly indicatorService: IndicatorService;
  readonly marketData?: FastPipelineMarketData;  // exchange here must match config.exchange
  readonly model?: string;
  readonly mockLatencyMs?: number;
}
```

`FastPipelineMarketData.exchange` is now redundant with `config.exchange`.  
**Recommendation:** keep it during 3B4C4 for backward compatibility, but validate at construction:

```typescript
if (config.marketData && config.marketData.exchange !== config.exchange) {
  throw new Error(`FastPipeline: marketData.exchange (${config.marketData.exchange}) !== config.exchange (${config.exchange})`);
}
```

**Future (3B4C5+):** Remove `FastPipelineMarketData.exchange` — derive from `config.exchange`.

**Signal input:**

```typescript
execute(signal: {
  exchange: ExchangeId;        // NEW — required
  source: string;
  symbol: string;
  signalData?: Record<string, unknown>;
}): Promise<FastPipelineResult>
```

Validate at the top of `execute`:

```typescript
if (signal.exchange !== this.config.exchange) {
  return {
    decision: 'skip',
    exchange: this.config.exchange,  // always return the pipeline's exchange
    reason: `Signal exchange mismatch: ${signal.exchange} !== ${this.config.exchange}`,
    ...
  };
}
```

**Result:**

```typescript
export interface FastPipelineResult {
  readonly exchange: ExchangeId;           // NEW — the pipeline's exchange
  readonly decision: 'trade' | 'skip' | 'defense';
  readonly direction?: 'long' | 'short' | 'hold';
  readonly symbol?: string;
  readonly positionUsd?: number;
  readonly reason: string;
  readonly elapsedMs: number;
  readonly biasReport: MarketBiasReportFull | null;
}
```

**decision_made event:**

```typescript
this.emit('decision_made', {
  exchange: this.config.exchange,   // NEW
  symbol: signal.symbol,
  bias: bias?.direction ?? 'hold',
  decision: deResult.decision,
  elapsedMs: Date.now() - startTime,
});
```

### 4C. SlowPipeline

```typescript
export interface SlowPipelineConfig {
  readonly exchange: ExchangeId;           // NEW — required, validated at construction
  readonly router: ExecutionRouter;
  readonly model?: string;
  readonly adapterScript?: string;
  readonly timeoutMs?: number;
  readonly bus?: TradingEventBus;
  readonly clock?: Clock;
  readonly adapterFactory?: () => PythonBridgeDaemon;
}
```

```typescript
async run(exchange: ExchangeId, symbol: string, tradeDate?: string): Promise<MarketBiasReportFull>
```

The `exchange` parameter equals `this.config.exchange` and is validated:

```typescript
if (exchange !== this.config.exchange) {
  throw new Error(`SlowPipeline.run: exchange ${exchange} !== config.exchange ${this.config.exchange}`);
}
```

**Adapter payload:**

```typescript
const payload: Record<string, unknown> = {
  exchange: this.config.exchange,    // NEW
  asset: symbol,
  symbol,
};
```

**Report construction — both normal and fallback:**

```typescript
// Normal — override exchange
const report: MarketBiasReportFull = {
  ...raw.report,
  exchange: this.config.exchange,
  meta: { ... },
};

// Fallback
private buildFallbackReport(exchange: ExchangeId, symbol: string, error: string, elapsedMs: number): MarketBiasReportFull {
  return {
    exchange,           // NEW
    timestamp: now,
    ...
  };
}
```

### 4D. ExecutionRouter

```typescript
export interface RouterConfig {
  readonly exchange: ExchangeId;           // NEW — required, validated at construction
  readonly fastPathTimeoutSec: number;
  readonly maxBiasReportAgeHours: number;
  readonly killSwitch: KillSwitch;
}
```

```typescript
export class ExecutionRouter extends EventEmitter {
  readonly exchange: ExchangeId;           // NEW

  constructor(config: RouterConfig) {
    super();
    if (!isExchangeId(config.exchange)) {
      throw new Error(`ExecutionRouter: invalid exchange: ${JSON.stringify(config.exchange)}`);
    }
    this.exchange = config.exchange;
    ...
  }
```

**Route input and output:**

```typescript
route(signal: {
  exchange: ExchangeId;              // NEW
  source: SignalSource;
  symbol?: string;
  signalData?: Record<string, unknown>;
}): RouteDecision {
  if (signal.exchange !== this.exchange) {
    throw new Error(`ExecutionRouter: signal exchange ${signal.exchange} !== router exchange ${this.exchange}`);
  }
  // ... existing logic ...
}
```

```typescript
export interface RouteDecision {
  readonly exchange: ExchangeId;           // NEW
  readonly path: ExecutionPath;
  readonly source: SignalSource;
  readonly reason: string;
  readonly biasReport?: MarketBiasReportFull;
  readonly defensiveMode: boolean;
}
```

**Bias report management:**

```typescript
async updateBiasReport(report: MarketBiasReportFull): Promise<void> {
  if (!isExchangeId((report as any).exchange)) {  // before type is added
    throw new Error(`ExecutionRouter: report missing exchange`);
  }
  if (report.exchange !== this.exchange) {
    throw new Error(`ExecutionRouter: report exchange ${report.exchange} !== router exchange ${this.exchange}`);
  }
  this.biasReport = report;
  this.emit('bias_updated', { exchange: this.exchange, report, ageHours: 0 });

  // Exchange-isolated file write
  const { ReportStore } = await import('../store/ReportStore');
  const store = new ReportStore({ filename: `bias.${this.exchange}.json` });
  await store.write(report);
}
```

```typescript
async loadBiasReportFromDisk(): Promise<MarketBiasReportFull | null> {
  const { ReportStore } = await import('../store/ReportStore');
  const store = new ReportStore({ filename: `bias.${this.exchange}.json` });
  const report = await store.read<MarketBiasReportFull>();
  if (!report) return null;
  if (report.exchange !== this.exchange) {
    // Fail closed — mismatched report is not a valid report
    return null;
  }
  this.biasReport = report;
  return report;
}
```

**Fast path timeout:**

```typescript
checkFastPathTimeout(startTime: number): { timedOut: boolean; elapsedMs: number } {
  const elapsedMs = Date.now() - startTime;
  if (elapsedMs > this.config.fastPathTimeoutSec * 1000) {
    this.config.killSwitch.lock(this.exchange,  // NEW — pass exchange
      `Fast path timeout: ${elapsedMs}ms > ${this.config.fastPathTimeoutSec * 1000}ms`
    );
    return { timedOut: true, elapsedMs };
  }
  return { timedOut: false, elapsedMs };
}
```

### 4E. KillSwitch

**Recommended signatures (strict — exchange REQUIRED on every public method):**

```typescript
export class KillSwitch extends EventEmitter {
  readonly exchange: ExchangeId;            // NEW — bound at construction

  constructor(exchange: ExchangeId, config: KillSwitchConfig) {
    super();
    if (!isExchangeId(exchange)) {
      throw new Error(`KillSwitch: invalid exchange: ${JSON.stringify(exchange)}`);
    }
    this.exchange = exchange;
    ...
  }

  check(exchange: ExchangeId, symbol: string, positionUsd: number): { allowed: boolean; reason?: string }
  recordLoss(exchange: ExchangeId, usd: number): void
  lock(exchange: ExchangeId, reason: string): void
  unlock(exchange: ExchangeId): void
  snapshot(exchange: ExchangeId): RiskSnapshot
}
```

**Bound-instance vs exchange-param debate:**

Two viable approaches:

| Approach | Signature | Pro | Con |
|---|---|---|---|
| **A: Bound** | `check(symbol, positionUsd)` hides exchange | Simpler callers; exchange from construction | Callers can forget which KS they hold |
| **B: Explicit** | `check(exchange, symbol, positionUsd)` | Fail-safe; caller must confirm intent | Redundant in single-exchange contexts |

**Recommendation:** Approach B (explicit) for 3B4C4. Reasons:
- MultiExchangeRuntime routes to different KS instances; callers must be explicit.
- Prevents bugs from holding the wrong KS reference.
- The small overhead of passing exchange is justified by safety in dual-exchange operation.

**RiskSnapshot:**

```typescript
export interface RiskSnapshot {
  readonly exchange: ExchangeId;             // NEW
  readonly currentExposureUsd: number;
  readonly todayRealizedLossUsd: number;
  readonly todayUnrealizedLossUsd: number;
  readonly openPositions: number;
  readonly isTriggered: boolean;
  readonly triggerReason?: string;
}
```

---

## 5. ReportStore Isolation

### Problem

Current `ReportStore` defaults to `bias.json` in `~/.clodds/market-bias/`. Two `ExecutionRouter` instances (Bitget + Binance) both write to and read from the same file. This causes:

1. Write-write conflict: whichever router writes last wins.
2. Read ambiguity: after restart, a router loads whichever report was written last — possibly the wrong exchange's.
3. No exchange validation: `read<T>()` returns untyped JSON; the caller cannot verify which exchange the report describes.

### Recommended Solution: Scheme A — Exchange-Prefixed Filename via ExecutionRouter

```typescript
// ExecutionRouter.ts (updateBiasReport)
const store = new ReportStore({ filename: `bias.${this.exchange}.json` });

// ExecutionRouter.ts (loadBiasReportFromDisk)
const store = new ReportStore({ filename: `bias.${this.exchange}.json` });
```

**Why Scheme A over Scheme B (modifying ReportStoreConfig directly):**

- ExecutionRouter already knows its exchange — no new config plumbing needed.
- ReportStore remains a generic atomic file store; exchange isolation is a routing concern.
- No need to add exchange validation logic inside ReportStore.

### Hard Constraints

- Bitget Router must NEVER write to or read from `bias.binance.json` (or shared `bias.json`).
- Binance Router must NEVER write to or read from `bias.bitget.json`.
- No fallback to exchange-agnostic old `bias.json` after migration.
- Old `bias.json` may remain on disk but must never be loaded automatically.
- File read that returns missing or mismatched `report.exchange` must fail closed (return `null`, log warning).
- Atomic write/rename semantics remain unchanged.

### Migration

1. Add `exchange` field to `MarketBiasReport`.
2. Update `SlowPipeline` to produce reports with `exchange`.
3. Update `ExecutionRouter.updateBiasReport` to write `bias.${exchange}.json`.
4. Update `ExecutionRouter.loadBiasReportFromDisk` to read `bias.${exchange}.json`, validate `report.exchange`.
5. Remove automatic loading of old `bias.json` after migration window.

---

## 6. Composition Root Contract

### TradingRuntime

`TradingRuntime` already has `options.exchange` (required, validated). During 3B4C4 it must propagate this to all child components:

```typescript
// Current structure (simplified)
const marketData = createMarketDataRuntime({ exchange, ... });
const fastPipeline = new FastPipeline({ exchange, ... });          // NEW: pass exchange
const slowPipeline = new SlowPipeline({ exchange, ... });          // NEW: pass exchange
const ks = new KillSwitch(exchange, options.killSwitchConfig);     // NEW: create exchange-bound KS
const router = new ExecutionRouter({ exchange, killSwitch: ks, ... }); // NEW: router gets exchange + KS
```

**Caller-injected router:**

```typescript
if (options.router) {
  if (options.router.exchange !== exchange) {
    throw new Error(`TradingRuntime: injected router exchange ${options.router.exchange} !== ${exchange}`);
  }
  // Use caller's router
}
```

**Caller-injected KillSwitch (via routerConfig.killSwitch):**

```typescript
if (options.routerConfig?.killSwitch) {
  if (options.routerConfig.killSwitch.exchange !== exchange) {
    throw new Error(`TradingRuntime: injected killSwitch exchange ${options.routerConfig.killSwitch.exchange} !== ${exchange}`);
  }
}
```

**Caller-injected bus:**

```typescript
// bus is already accepted via options.bus (no exchange binding needed — it's a transport)
// EventBus validates exchange at publish boundary (see §7)
```

### Composition Root Wrappers

No change to `createBitgetTradingRuntime` / `createBinanceTradingRuntime` — they already fix `exchange: 'bitget'` and `exchange: 'binance'` respectively. 3B4C4 changes are internal to TradingRuntime.

`createExchangeTradingRuntime` (exchange discriminator) — same.

`MultiExchangeRuntime` — isolation checks remain. No shared-router / shared-KS relaxation.

---

## 7. EventBus Provenance Contract

### Current State

- `market.ticker.updated`: validates `ticker.exchange` ✅
- `market.kline.closed`: validates `kline.exchange` ✅
- `research.bias.updated`: **no exchange validation** ❌

### 3B4C4 Addition

```typescript
// TradingEventBus.ts publish()
if (type === 'research.bias.updated') {
  const p = payload as TradingEventPayloadMap['research.bias.updated'];
  if (!p || !p.report) {
    throw new InvalidExchangeProvenanceError('research.bias.updated requires report payload');
  }
  if (!isExchangeId((p.report as { exchange?: unknown }).exchange)) {
    throw new InvalidExchangeProvenanceError(
      `research.bias.updated: invalid report.exchange: ${JSON.stringify((p.report as { exchange?: unknown }).exchange)}`,
    );
  }
}
```

### Validation Rules

```
research.bias.updated:
  - report MUST exist
  - report.exchange MUST be a valid ExchangeId (isExchangeId)
  - No additional independent `source` or `exchange` field on the event envelope
  - Validation happens at publish boundary (same as ticker/kline)
```

### Prohibited Patterns

```typescript
// PROHIBITED — two exchange fields that could disagree
{ exchange: 'binance', report: { exchange: 'bitget' } }

// PROHIBITED — additional source field
{ report: MarketBiasReportFull, source: 'bitget' }

// REQUIRED — single exchange inside report
{ report: { exchange: 'bitget', ... }, receivedAt: ... }
```

---

## 8. Execution Safety Boundary

3B4C4 scope is strictly limited to:

| Activity | Status |
|---|---|
| Type propagation (add `exchange` to types/structs) | ✅ IN SCOPE |
| Config binding (validate exchange at construction) | ✅ IN SCOPE |
| Provenance validation (fail closed on mismatch) | ✅ IN SCOPE |
| Risk state dimensionality (exchange-isolated KS counters) | ✅ IN SCOPE |
| Disk isolation (exchange-prefixed report files) | ✅ IN SCOPE |
| Offline tests | ✅ IN SCOPE |

**NOT in scope (neither 3B4C4 nor later — prohibited by project roadmap):**

| Activity | Status |
|---|---|
| Real order placement | ❌ NEVER |
| Private WebSocket connections | ❌ NEVER |
| REST account access | ❌ NEVER |
| API key / secret handling | ❌ NEVER |
| Balance / position synchronization | ❌ NEVER |
| Order routing | ❌ NEVER |
| Cross-exchange automated execution | ❌ NEVER |
| Best-price / fallback-exchange logic | ❌ NEVER |
| Arbitrage detection or execution | ❌ NEVER |
| Shared Router / KillSwitch between exchanges | ❌ NEVER |
| Observability integration (Hermes monitor) | ❌ STAGE 3B4C5+ |

`FastPipelineResult.decision = 'trade'` remains a *decision object* — it does NOT produce any order side effects. This invariant holds before and after 3B4C4.

---

## 9. Migration Plan — Atomic Sequence

### Phase 1: Types (standalone commit)

| Step | File | Change |
|------|------|--------|
| 1.1 | `types/market-bias.ts` | Add `readonly exchange: ExchangeId` to `MarketBiasReport` |
| 1.2 | `types/market-bias.ts` | `MarketBiasReportFull` inherits it automatically |
| 1.3 | `router/KillSwitch.ts` | Add `readonly exchange: ExchangeId` to `RiskSnapshot` |
| 1.4 | `router/KillSwitch.ts` | Add `readonly exchange: ExchangeId` to `KillSwitch` class |

**Atomic unit**: KillSwitch + RiskSnapshot + MarketBiasReport get exchange.
**Test**: All existing test fixtures break — fix after full commit.

### Phase 2: KillSwitch signatures (must land with Phase 1)

| Step | File | Change |
|------|------|--------|
| 2.1 | `KillSwitch.ts` | Constructor takes `(exchange: ExchangeId, config?)`, validates via `isExchangeId` |
| 2.2 | `KillSwitch.ts` | `check(exchange, symbol, positionUsd)` — validate === this.exchange |
| 2.3 | `KillSwitch.ts` | `recordLoss(exchange, usd)` — validate |
| 2.4 | `KillSwitch.ts` | `lock(exchange, reason)` — validate |
| 2.5 | `KillSwitch.ts` | `unlock(exchange)` — validate |
| 2.6 | `KillSwitch.ts` | `snapshot(exchange): RiskSnapshot` — return includes `this.exchange` |

### Phase 3: ReportStore isolation (can be standalone)

| Step | File | Change |
|------|------|--------|
| 3.1 | `store/ReportStore.ts` | No change (already accepts `filename` in config) |
| 3.2 | `router/ExecutionRouter.ts` | `updateBiasReport`: write to `bias.${this.exchange}.json` |
| 3.3 | `router/ExecutionRouter.ts` | `loadBiasReportFromDisk`: read from `bias.${this.exchange}.json`, validate `report.exchange` |

### Phase 4: ExecutionRouter binding (MUST land with Phases 1+2)

| Step | File | Change |
|------|------|--------|
| 4.1 | `ExecutionRouter.ts` | Add `readonly exchange: ExchangeId` |
| 4.2 | `ExecutionRouter.ts` | `RouterConfig` gains `readonly exchange: ExchangeId` |
| 4.3 | `ExecutionRouter.ts` | Constructor validates `config.exchange` |
| 4.4 | `ExecutionRouter.ts` | `route(signal)` — signal gains `exchange`, validate |
| 4.5 | `ExecutionRouter.ts` | `RouteDecision` gains `exchange` |
| 4.6 | `ExecutionRouter.ts` | `updateBiasReport(report)` — validate `report.exchange === this.exchange` |
| 4.7 | `ExecutionRouter.ts` | `loadBiasReportFromDisk` — validate loaded report |

**Why must land together with Phases 1+2:**
- Router calls `ks.lock(reason)` — after Phase 2, signature is `lock(exchange, reason)`.
- Router `killSwitch` is constructed with `exchange` — same commit.

### Phase 5: SlowPipeline (standalone after Phases 1–4)

| Step | File | Change |
|------|------|--------|
| 5.1 | `SlowPipeline.ts` | `SlowPipelineConfig` gains `readonly exchange: ExchangeId` |
| 5.2 | `SlowPipeline.ts` | Constructor validates `config.exchange` |
| 5.3 | `SlowPipeline.ts` | `run(exchange, symbol, tradeDate?)` — validate |
| 5.4 | `SlowPipeline.ts` | Adapter payload gains `exchange` |
| 5.5 | `SlowPipeline.ts` | Normal report: spread then override `exchange` |
| 5.6 | `SlowPipeline.ts` | `buildFallbackReport` takes and uses `exchange` param |
| 5.7 | `SlowPipeline.ts` | Router `updateBiasReport` called after exchange override |

### Phase 6: FastPipeline (standalone after Phases 1–4)

| Step | File | Change |
|------|------|--------|
| 6.1 | `FastPipeline.ts` | `FastPipelineConfig` gains `readonly exchange: ExchangeId` |
| 6.2 | `FastPipeline.ts` | Constructor validates `config.exchange` + `marketData.exchange` match |
| 6.3 | `FastPipeline.ts` | `execute(signal)` — signal gains `exchange`, validate |
| 6.4 | `FastPipeline.ts` | `FastPipelineResult` gains `exchange` |
| 6.5 | `FastPipeline.ts` | `decision_made` event payload gains `exchange` |
| 6.6 | `FastPipeline.ts` | KillSwitch calls: `this.config.router.killSwitch.check(this.config.exchange, ...)` |

### Phase 7: EventBus validation (standalone after Phase 1)

| Step | File | Change |
|------|------|--------|
| 7.1 | `TradingEventBus.ts` | `publish` — add `research.bias.updated` exchange validation |

### Phase 8: TradingRuntime composition (MUST land with all above)

| Step | File | Change |
|------|------|--------|
| 8.1 | `TradingRuntime.ts` | Pass `exchange` to `FastPipelineConfig` construction |
| 8.2 | `TradingRuntime.ts` | Pass `exchange` to `SlowPipelineConfig` construction |
| 8.3 | `TradingRuntime.ts` | Pass `exchange` to `KillSwitch` constructor |
| 8.4 | `TradingRuntime.ts` | Pass `exchange` to `ExecutionRouter(RouterConfig)` construction |
| 8.5 | `TradingRuntime.ts` | Validate caller-injected `router.exchange` === `exchange` |
| 8.6 | `TradingRuntime.ts` | Validate caller-injected `killSwitch.exchange` === `exchange` |

**Why all together:** Every component now requires exchange at construction. TradingRuntime creates them all. An intermediate commit would either (a) not compile, or (b) compile with unbound components that would fail at runtime.

### Phase 9: Wrappers (no-change)

`BitgetTradingRuntime.ts` / `BinanceTradingRuntime.ts` / `ExchangeTradingRuntime.ts` — no changes needed. They already fix `exchange: 'bitget'` / `'binance'` and pass options through. The exchange propagates into `TradingRuntime` which now creates bound components.

### Phase 10: Test fixtures + tests

All test files listed in §1C. Tests should be fixed in the same commit as the production change they test.

**Recommended merge strategy:**
- 3 atomic commits:
  1. **Phase 1+2+3**: Types, KillSwitch, ReportStore isolation (no callers break if nothing calls new signatures)
  2. **Phase 4+5+6+7**: Router, SlowPipeline, FastPipeline, EventBus (tests fix alongside)
  3. **Phase 8+9+10**: TradingRuntime composition + wrappers + MultiExchange regression

---

## 10. Test Matrix

### MarketBiasReport

| Test | Expected |
|------|----------|
| Normal report includes exchange | report.exchange is valid ExchangeId |
| Fallback report includes exchange | fallback report.exchange matches bound exchange |
| Adapter returns report with wrong exchange | SlowPipeline overrides with bound exchange |
| Adapter returns report without exchange | SlowPipeline sets exchange to bound value |
| EventBus rejects report without exchange | InvalidExchangeProvenanceError thrown |
| EventBus rejects report with invalid exchange | InvalidExchangeProvenanceError thrown |

### ReportStore

| Test | Expected |
|------|----------|
| Bitget writes to `bias.bitget.json` | Binance file unchanged |
| Binance writes to `bias.binance.json` | Bitget file unchanged |
| Bitget reads own file | Report loaded correctly |
| Bitget reads `bias.binance.json` (via path injection) | Not possible — store is exchange-scoped at caller |
| Report lacking exchange on disk | `loadBiasReportFromDisk` returns null |
| Report with mismatched exchange on disk | `loadBiasReportFromDisk` returns null |
| Old `bias.json` exists but is not read | Not loaded by exchange-scoped router |

### EventBus

| Test | Expected |
|------|----------|
| `research.bias.updated` with valid report.exchange | Published, delivered |
| `research.bias.updated` with missing report.exchange | InvalidExchangeProvenanceError |
| `research.bias.updated` with `report.exchange='coinbase'` | InvalidExchangeProvenanceError |
| `research.bias.updated` with `report.exchange='BITGET'` | InvalidExchangeProvenanceError |
| No additional `source`/`exchange` field on event envelope | Event shape unchanged |

### FastPipeline

| Test | Expected |
|------|----------|
| execute with matching exchange | Proceeds normally |
| execute with mismatched exchange | Returns skip with mismatch reason |
| FastPipelineResult includes exchange | exchange === config.exchange |
| Config without exchange | Constructor throws |
| marketData.exchange !== config.exchange | Constructor throws (optional, config wins) |
| KillSwitch called with correct exchange | ks.check(config.exchange, ...) |
| decision_made event includes exchange | event.exchange === config.exchange |
| Router bias report mismatch | FastPipeline reads correct exchange report |
| No marketData — still has exchange | Pipeline still uses config.exchange |

### SlowPipeline

| Test | Expected |
|------|----------|
| run with matching exchange | Proceeds normally |
| run with mismatched exchange | Throws error |
| Adapter payload includes exchange | payload.exchange === config.exchange |
| Normal report exchange | report.exchange === config.exchange |
| Fallback report exchange | report.exchange === config.exchange |
| Adapter returns wrong exchange | Overridden by SlowPipeline |
| publishReport calls router.updateBiasReport with exchange-bound report | Router validates |
| bus.publish includes report with exchange | EventBus validates |

### ExecutionRouter

| Test | Expected |
|------|----------|
| Router construction without exchange | Throws |
| route signal with matching exchange | Routes normally |
| route signal with mismatched exchange | Throws |
| RouteDecision includes exchange | decision.exchange === router.exchange |
| updateBiasReport with matching report | Report accepted |
| updateBiasReport with mismatched exchange | Throws |
| loadBiasReportFromDisk with correct file | Report loaded |
| loadBiasReportFromDisk with no file | Returns null |
| loadBiasReportFromDisk with mismatched report | Returns null |
| checkFastPathTimeout passes exchange to KS lock | ks.lock(router.exchange, ...) |

### KillSwitch

| Test | Expected |
|------|----------|
| Constructor without exchange | Throws |
| check with matching exchange | Normal check |
| check with mismatched exchange | Throws |
| recordLoss with matching exchange | Loss recorded |
| recordLoss with mismatched exchange | Throws |
| lock with matching exchange | Locked |
| lock with mismatched exchange | Throws |
| unlock with matching exchange | Unlocked |
| unlock with mismatched exchange | Throws |
| snapshot includes exchange | snapshot.exchange === ks.exchange |
| Bitget and Binance KS independent | loss on one does not affect the other |

### TradingRuntime

| Test | Expected |
|------|----------|
| All child components have matching exchange | Verified at construction |
| Caller injects router with wrong exchange | Throws |
| Caller injects KillSwitch with wrong exchange | Throws |
| Composition root creates bound components | All components share exchange |

### MultiExchangeRuntime

| Test | Expected |
|------|----------|
| Both sides produce distinguishable reports | report.exchange differs |
| Both sides produce distinguishable decisions | result.exchange differs |
| Both sides produce distinguishable risk snapshots | snapshot.exchange differs |
| Existing lifecycle tests pass | 56/56 unchanged |
| Existing isolation tests pass | bus/router/KS still rejected |
| Apply does not cross-exchange | report isolation maintained |

---

## 11. Baseline Test Count (pre-migration)

| Suite | Tests | Status |
|------|-------|--------|
| MultiExchangeRuntime | 56 | ✅ All passing |
| TradingRuntime | 68 | ✅ All passing |
| BitgetTradingRuntime | 46 | ✅ All passing |
| BinanceTradingRuntime | 16 | ✅ All passing |
| ExchangeTradingRuntime | 15 | ✅ All passing |
| ExchangeProvider | 20 | ✅ All passing |
| MarketDataRuntime | 28 | ✅ All passing |
| FastPipeline | 18 | ✅ All passing |
| MarketSnapshotStore | 27 | ✅ All passing |
| CandleSeriesStore | 25 | ✅ All passing |
| EventBus | 21 | ✅ All passing |
| BitgetV2PublicCollector | 68 | ✅ All passing |
| BinanceV2PublicCollector | 33 | ✅ All passing |
| KillSwitch | ~25 | ✅ All passing (pre-migration) |
| ExecutionRouter | ~30 | ✅ All passing (pre-migration) |
| SlowPipeline | ~15 | ✅ All passing (pre-migration) |
| ReportStore | ~8 | ✅ All passing (pre-migration) |
| **Total** | **~539** | — |

---

## 12. Implementation File List

### Production files (modify — 11 files)

| # | File | Phase | Changes |
|---|------|-------|---------|
| 1 | `src/types/market-bias.ts` | 1 | Add `exchange: ExchangeId` to `MarketBiasReport` |
| 2 | `src/router/KillSwitch.ts` | 1, 2 | Constructor + `exchange` param on every method; `RiskSnapshot.exchange` |
| 3 | `src/store/ReportStore.ts` | 3 | No change (already accepts `filename`) |
| 4 | `src/router/ExecutionRouter.ts` | 3, 4 | `exchange` on `RouterConfig`, class, `route` I/O, report validation, file isolation |
| 5 | `src/pipeline/SlowPipeline.ts` | 5 | `Config.exchange`, `run(exchange)`, adapter payload, report override |
| 6 | `src/pipeline/FastPipeline.ts` | 6 | `Config.exchange`, `execute(signal)` I/O, result, validation |
| 7 | `src/events/TradingEventBus.ts` | 7 | Add `research.bias.updated` exchange validation |
| 8 | `src/runtime/trading/TradingRuntime.ts` | 8 | Pass exchange to all child components; validate injected |

### Production files (no change — wrappers)

| File | Reason |
|------|--------|
| `src/runtime/trading/BitgetTradingRuntime.ts` | Already fixes `exchange: 'bitget'` |
| `src/runtime/trading/BinanceTradingRuntime.ts` | Already fixes `exchange: 'binance'` |
| `src/runtime/trading/ExchangeTradingRuntime.ts` | Already uses discriminator exchange |
| `src/runtime/trading/MultiExchangeRuntime.ts` | Isolation checks unchanged |

### Test files (modify — 7+ files)

| File | Phase |
|------|-------|
| `tests/router/kill-switch.test.ts` | 2 |
| `tests/router/execution-router.test.ts` | 3, 4 |
| `tests/pipeline/slow-pipeline.test.ts` | 5 |
| `tests/pipeline/fast-pipeline-market.test.ts` | 6 |
| `tests/events/trading-event-bus.test.ts` | 7 |
| `tests/runtime/trading/trading-runtime.test.ts` | 8 |
| `tests/runtime/trading/multi-exchange-runtime.test.ts` | 8 |
| `tests/store/report-store.test.ts` | (no change — already accepts config) |

### Commit plan

```
Commit A:   feat(data): add exchange to MarketBiasReport and RiskSnapshot
            1 file (types/market-bias.ts)
            1 file (router/KillSwitch.ts) — signatures only, no callers break yet

Commit B:   feat(router): exchange-aware ExecutionRouter + ReportStore isolation
            1 file (router/ExecutionRouter.ts)
            + test fix (execution-router.test.ts, report-store.test.ts)

Commit C:   feat(pipeline): exchange-bound SlowPipeline and FastPipeline
            2 files (SlowPipeline.ts, FastPipeline.ts)
            + test fix (slow-pipeline.test.ts, fast-pipeline-market.test.ts)

Commit D:   feat(event-bus): validate report.exchange on research.bias.updated
            1 file (TradingEventBus.ts)
            + test fix (trading-event-bus.test.ts)

Commit E:   feat(runtime): propagate exchange to all decision/risk components
            1 file (TradingRuntime.ts)
            + test fix (trading-runtime.test.ts, multi-exchange-runtime.test.ts)
            + regression verify all wrappers unchanged
```

---

## Revision History

| Rev | Date | Author | Changes |
|-----|------|--------|---------|
| 1 | 2026-07-19 | — | Initial audit (Stage 3B4C4-AUDIT) |
