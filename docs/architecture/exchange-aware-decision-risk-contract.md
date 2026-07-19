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

#### Production call sites — exact inventory

Obtained via `rg` against baseline `50a7c4a`. Numbers are file:line.

| Symbol | Production call sites | Notes |
|---|---|---|
| `new KillSwitch(...)` | `src/runtime/trading/TradingRuntime.ts:155` (single site) | Composition root only — production-internal exchange binding |
| `ks.check(...)` | `src/pipeline/FastPipeline.ts:173` (single site) | `killSwitch.check(signal.symbol, 0)` — needs `exchange` |
| `ks.recordLoss(...)` | — (no production caller; only defined at `KillSwitch.ts:103`) | Method is part of contract; future callers must pass exchange |
| `ks.lock(...)` | `src/router/ExecutionRouter.ts:195` (single site) | `killSwitch.lock(\`Fast path timeout...\`)` — needs exchange |
| `ks.unlock(...)` | — (no production caller) | Method is part of contract |
| `ks.snapshot()` | `src/router/ExecutionRouter.ts:181` (single site) | `killSwitch.snapshot().openPositions > 0` — needs exchange |
| `new ExecutionRouter(...)` | `src/runtime/trading/TradingRuntime.ts:156` (single site) | Composition root only |
| `router.updateBiasReport(...)` | `src/pipeline/SlowPipeline.ts:147` (single site) | `this.config.router.updateBiasReport(report)` — report gains `exchange` |
| `router.getBiasReport()` | `src/pipeline/FastPipeline.ts:134` (single site) | `this.config.router.getBiasReport()` — return value gains `exchange` |
| `router.loadBiasReportFromDisk()` | — (no production caller; only defined) | Will be called by TradingRuntime init in 3B4C5+ |
| `router.checkFastPathTimeout(...)` | — (no production caller; only defined) | Hook for future Write-Action tool timeout |
| `router.route(...)` | — (no production caller; only defined at `ExecutionRouter.ts:89`) | Used in tests + future Write-Action dispatcher |
| `new FastPipeline(...)` | `src/runtime/trading/TradingRuntime.ts:214` (single site) | Composition root only |
| `fp.execute(...)` | — (no production caller; only tests) | Future Write-Action dispatcher will call this |
| `new SlowPipeline(...)` | `src/runtime/trading/TradingRuntime.ts:227` (single site) | Composition root only |
| `sp.run(...)` | — (no production caller; only tests) | Hermes Cron adapter will call this in 3B4C5+ |
| `bus.publish('research.bias.updated', ...)` | `src/pipeline/SlowPipeline.ts:159` (single site) | EventBus validation boundary |
| `MarketBiasReport / MarketBiasReportFull` (literal construction) | `tests/pipeline/slow-pipeline.test.ts` (fallback fixture + assertion), `tests/e2e/step-1-7-e2e.test.ts:42` (`makeBiasReport`), `tests/runtime/market/universe-manager.test.ts` (4 fixtures + 1 use), `tests/events/trading-event-bus.test.ts:43` (report fixture) | Test fixtures; production never literally constructs — only spreads `raw.report` from adapter |

#### Why the impact is narrow

The bulk of the changes concentrate in **one** production composition root (`TradingRuntime.ts`) and **three** single-call-site consumers (`FastPipeline.ts:173`, `ExecutionRouter.ts:181+195`, `SlowPipeline.ts:147`). The downstream public API (`fp.execute`, `sp.run`, `router.route`, `router.loadBiasReportFromDisk`, `router.checkFastPathTimeout`) has **zero production callers** — they are integration surfaces for future stages (3B4C5+ Write-Action tool, Hermes Cron adapter). This means:

1. After Phase 1–4, production callers exist only in `TradingRuntime.ts` — the composition root commit (Phase 8) is the single production-breaking commit.
2. Tests are the consumers that need significant fixture updates — this is the bulk of the work, not production rewiring.

#### Per-file change list (production)

| File | Phase | Production changes (line-level) |
|---|---|---|
| `src/types/market-bias.ts` | 1 | Add `readonly exchange: ExchangeId` to `MarketBiasReport` interface |
| `src/router/KillSwitch.ts` | 1+2 | Add `readonly exchange: ExchangeId` to class + `RiskSnapshot`; constructor takes `(exchange, config?)`; all 5 public methods (`check`, `recordLoss`, `lock`, `unlock`, `snapshot`) take `exchange: ExchangeId` as first param and validate `=== this.exchange` |
| `src/router/ExecutionRouter.ts` | 3+4 | Add `readonly exchange: ExchangeId` to `RouterConfig` and class; `route(signal)` requires `signal.exchange`; `RouteDecision` gains `exchange`; `updateBiasReport` validates `report.exchange === this.exchange` and writes to `bias.${exchange}.json`; `loadBiasReportFromDisk` reads exchange-scoped file and validates; `checkFastPathTimeout` passes `this.exchange` to `ks.lock`; `killSwitch.snapshot()` call at line 181 gains `this.exchange` |
| `src/pipeline/SlowPipeline.ts` | 5 | Add `readonly exchange: ExchangeId` to `SlowPipelineConfig`; constructor validates via `isExchangeId`; `run(exchange, symbol, tradeDate?)` validates `=== config.exchange`; adapter payload gains `exchange`; report spread overrides `exchange` with bound value; `buildFallbackReport(exchange, symbol, error, elapsedMs)` uses bound exchange; `publishReport` calls `router.updateBiasReport(report)` after exchange override |
| `src/pipeline/FastPipeline.ts` | 6 | Add `readonly exchange: ExchangeId` to `FastPipelineConfig`; constructor validates `isExchangeId(config.exchange)` and `config.marketData?.exchange === config.exchange` if `marketData` provided; `execute(signal)` requires `signal.exchange` and validates `=== config.exchange`; `FastPipelineResult` gains `exchange: ExchangeId`; `decision_made` event payload gains `exchange`; line 173 `killSwitch.check(signal.symbol, 0)` → `killSwitch.check(this.config.exchange, signal.symbol, 0)` |
| `src/events/TradingEventBus.ts` | 7 | In `publish()`: add `research.bias.updated` validation — `report.exchange` must be a valid ExchangeId; throw `InvalidExchangeProvenanceError` on missing/invalid |
| `src/runtime/trading/TradingRuntime.ts` | 8 | Pass `exchange` to `new KillSwitch(exchange, ...)`, `new ExecutionRouter({ exchange, killSwitch: ks, ... })`, `new FastPipeline({ exchange, router, ... })`, `new SlowPipeline({ exchange, router, ... })`; validate caller-injected `router.exchange === exchange`; validate caller-injected `killSwitch.exchange === exchange` when `routerConfig.killSwitch` provided |

#### Per-file change list (tests)

| File | Phase | Test changes |
|---|---|---|
| `tests/router/kill-switch.test.ts` | 2 | All `new KillSwitch(...)` construction gains `exchange` first param; every method call (`check`, `recordLoss`, `lock`, `unlock`, `snapshot`) gains `exchange` first param; `RiskSnapshot` assertions check `exchange` field |
| `tests/router/execution-router.test.ts` | 3+4 | All `new ExecutionRouter(...)` config gains `exchange`; `route(signal)` calls gain `signal.exchange`; `RouteDecision` assertions check `exchange`; `updateBiasReport(report)` calls pass reports with `exchange` field; `getBiasReport()` assertions check `exchange`; if scoped, add tests for exchange-mismatch throw + exchange-scoped file path |
| `tests/pipeline/slow-pipeline.test.ts` | 5 | All `new SlowPipeline(...)` config gains `exchange`; all `pipeline.run(...)` calls gain `exchange` first param; fixture `makeReport`/`buildFallbackReport` gain `exchange`; mock `updateBiasReport` assertion checks `report.exchange`; existing ~15 tests need fixture updates |
| `tests/pipeline/fast-pipeline-market.test.ts` | 6 | All `new FastPipeline(...)` config gains `exchange`; `fp.execute({ source, symbol })` calls gain `exchange`; `FastPipelineResult` assertions check `exchange`; `decision_made` event subscription assertions check `exchange`; existing 18 tests need signal + result assertions updated |
| `tests/events/trading-event-bus.test.ts` | 7 | `MarketBiasReportFull` fixture at line 43 gains `exchange: 'bitget'`; existing `research.bias.updated` tests pass; add 4 new tests: missing `report.exchange`, invalid `report.exchange`, case-variant `report.exchange`, valid `report.exchange` |
| `tests/store/report-store.test.ts` | 3 | No production change needed — `ReportStore` API unchanged. Optional: add regression that `bias.bitget.json` and `bias.binance.json` can coexist in the same dir. |
| `tests/runtime/trading/trading-runtime.test.ts` | 8 | Tests that inject `router` (line 977) must inject exchange-bound router; tests that inject `killSwitch` must inject exchange-bound KS; existing 68 tests pass once fixtures updated |
| `tests/runtime/trading/bitget-trading-runtime.test.ts` | 9 | No change — wrapper fixes `exchange: 'bitget'` |
| `tests/runtime/trading/binance-trading-runtime.test.ts` | 9 | No change — wrapper fixes `exchange: 'binance'` |
| `tests/runtime/trading/exchange-trading-runtime.test.ts` | 9 | No change — discriminator fixes `exchange` |
| `tests/runtime/trading/multi-exchange-runtime.test.ts` | 9 | No change — isolation checks ensure each side constructs its own exchange-bound router/KS. Add 2 new tests: (a) `multimock.getRadiRuntime('bitget').router.exchange === 'bitget'`, (b) `bias.bitget.json` and `bias.binance.json` are independent files |
| `tests/e2e/step-1-7-e2e.test.ts` | 9 | `makeBiasReport` at line 42 gains `exchange: 'bitget'`; `new FastPipeline(config)` at line 98 gains `exchange: 'bitget'` in config; `fp.execute(...)` calls at lines 111, 129, 156, 170, 189 gain `exchange: 'bitget'` |
| `tests/runtime/market/universe-manager.test.ts` | 9 | 4 `MarketBiasReportFull` fixtures (lines 31, 223, 238, 249, 271, 333, 338) gain `exchange: 'bitget'` (or `'binance'` based on context) |

#### Files NOT changed (correctly identified out-of-scope)

| File | Reason |
|------|--------|
| `src/runtime/trading/BitgetTradingRuntime.ts` | Wrapper that fixes `exchange: 'bitget'`; passes `exchange` through to `TradingRuntime` which now propagates |
| `src/runtime/trading/BinanceTradingRuntime.ts` | Wrapper that fixes `exchange: 'binance'`; same |
| `src/runtime/trading/ExchangeTradingRuntime.ts` | Discriminator that takes `exchange` from caller; passes through |
| `src/runtime/trading/MultiExchangeRuntime.ts` | Isolation enforcement unchanged — exchange binding happens inside each child TradingRuntime |
| `src/store/ReportStore.ts` | Generic atomic file store — exchange isolation is router's concern; `ReportStoreConfig.filename` already accepts any path |
| `src/data/MarketIdentity.ts` | Already canonical: `ExchangeId`, `isExchangeId`, `sourceKey` — no changes |
| `src/data/MarketSnapshot.ts` | Already has `exchange: ExchangeId` on `MarketSnapshot` and store API |
| `src/data/types.ts` | `WsTicker`/`WsKline` already extend `ExchangeAwareMarketData` |
| `src/events/TradingEvent.ts` | Event payload map unchanged — `research.bias.updated` payload is still `{ report, receivedAt }`; exchange arrives inside `report.exchange` |

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

### 3D. Failure Semantics — Unified across all boundaries

Every component touched by 3B4C4 must apply **the same failure semantics** at every exchange boundary. There are exactly two distinct cases:

#### Case A: Construction-time binding (raise-error / fail-fast)

When an `ExchangeId` is bound to a component at construction time, any mismatch with the bound value is a **construction defect**, not a runtime condition. The constructor MUST throw synchronously.

Applies to:
- `new KillSwitch(exchange, config)` — `isExchangeId(exchange)` false → throw
- `new ExecutionRouter({ exchange, ... })` — `isExchangeId(exchange)` false → throw
- `new FastPipeline({ exchange, ... })` — `isExchangeId(exchange)` false → throw
- `new SlowPipeline({ exchange, ... })` — `isExchangeId(exchange)` false → throw
- `new FastPipeline({ exchange, marketData: { exchange, ... } })` — `marketData.exchange !== config.exchange` → throw
- `new TradingRuntime({ exchange, router, routerConfig: { killSwitch, ... } })` — `router.exchange !== exchange` or `killSwitch.exchange !== exchange` → throw

Throw shape (consistent across all components):

```typescript
throw new Error(`${ComponentName}: invalid exchange: ${JSON.stringify(exchange)}`);
// or
throw new Error(`${ComponentName}: exchange mismatch: ${a} !== ${b}`);
```

#### Case B: Runtime call-site (fail-closed / drop)

When a component receives an exchange at a runtime call (not construction), a mismatched exchange is a **provenance violation**. The component MUST fail closed — return a skip/empty result, never throw across the API boundary.

Applies to:
- `FastPipeline.execute(signal)` — `signal.exchange !== config.exchange` → return skip result `{ decision: 'skip', exchange: config.exchange, reason: 'exchange mismatch', ... }`
- `SlowPipeline.run(exchange, ...)` — `exchange !== config.exchange` → throw (this is a programming-error case, not a runtime signal — caller's typo)

The only exception is `SlowPipeline.run` — a mismatch indicates a programming error (caller passed wrong exchange), not an external signal. **Throw, don't skip.** This is intentional asymmetry: external signals fail closed; programming errors fail loud.

#### Validation helper (new in 3B4C4)

Add a single helper in `MarketIdentity.ts`:

```typescript
/**
 * Stage 3B4C4: Construction-time exchange binding validation.
 * Throws synchronously on invalid ExchangeId.
 * Use at every composition root and constructor that binds an exchange.
 */
export function assertExchangeId(componentName: string, exchange: unknown): asserts exchange is ExchangeId {
  if (!isExchangeId(exchange)) {
    throw new Error(`${componentName}: invalid exchange: ${JSON.stringify(exchange)}`);
  }
}
```

All constructors in §4 call `assertExchangeId('ComponentName', exchange)` instead of inlining the check.

### 3E. Explicit-vs-bound debate — resolution

Two viable signature styles were considered for `KillSwitch`:

| Approach | Signature | Pro | Con |
|---|---|---|---|
| **A: Bound** | `ks.check(symbol, positionUsd)` (exchange hidden, bound at construction) | Simpler callers; exchange from construction; impossible to pass wrong exchange to wrong KS instance | Caller can forget which KS they hold; reference-mismatch bugs possible |
| **B: Explicit** | `ks.check(exchange, symbol, positionUsd)` (exchange passed every call) | Fail-safe at every call site; caller must confirm intent; redundant safety in dual-exchange operation | Redundant in single-exchange contexts; more verbose |

**3B4C4 chooses Approach B (explicit) for `KillSwitch`, with the following justification:**

1. **Single-exchange safety** — In single-exchange contexts (only Bitget live), Approach A is safe because there's literally one KS instance. But CloddsBot's roadmap has Bitget + Binance live simultaneously as the target state, not a future option.
2. **Bug class elimination** — `MultiExchangeRuntime.isolateResources()` enforces `bitget.router !== binance.router` and `bitget.router.killSwitch !== binance.router.killSwitch` (§3 of `multi-exchange-runtime.test.ts`). But a developer holding the wrong KS reference (e.g. via a stale closure) would still call the wrong instance silently under Approach A.
3. **Caller intent confirmation** — In fast-path code where decisions happen in <2s, an explicit `ks.check(this.config.exchange, ...)` forces the developer to confirm at every call site that they're using the right exchange's risk state. This is redundant safety; that's the point.
4. **Consistent with existing API shape** — `EventBus.publish` already validates exchange *at the call site*, not at construction. Approach B is the same pattern: validate at every call, not just at construction.
5. **Cheap to drop later** — If Approach B proves too verbose in practice, future Stage 3B4C5+ can wrap KillSwitch in an `ExchangeBoundKillSwitch` facade that hides the param. The reverse (adding param later) is a breaking API change.

**Counterargument considered and rejected:**
- "Approach B has caller overhead" — Yes, but the overhead is one extra argument per call. There are exactly **3 production call sites** for KS methods (§1C). The overhead is trivial.
- "Approach B allows passing the wrong exchange" — Yes, but the wrong exchange triggers `Error('KillSwitch: exchange mismatch')` synchronously, which is louder than Approach A's silent reference-mismatch bug.
- "Approach A is more idiomatic OO" — CloddsBot already uses explicit-exchange validation in `EventBus`, `MarketSnapshot`, `CandleSeriesStore`, `sourceKey`. Approach A would be the *non-idiomatic* choice in this codebase.

**Recommendation for downstream stages:** Apply Approach B to ALL exchange-aware APIs added in 3B4C5+, including Write-Action tool dispatcher, Hermes Cron adapter, and any future cross-exchange coordinator. Approach A is prohibited unless explicitly approved by a Stage R1 correction.

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

All test files listed in §1C. Tests must be fixed in the **same** uncommitted working tree as the production changes they test.

### Atomic delivery (single commit)

3B4C4 MUST be delivered as a single production commit. Internal development order within the working tree:

```
Internal order (within same uncommitted tree):
  1. MarketBiasReport / RiskSnapshot types
  2. KillSwitch constructor + method signatures
  3. ExecutionRouter + exchange-scoped filename
  4. SlowPipeline
  5. FastPipeline
  6. EventBus validation
  7. TradingRuntime composition root
  8. All test fixtures + call-site fixes
  9. MultiExchangeRuntime regression (2 new tests)
  10. Full typecheck + build + targeted regression run
  11. Single commit: feat(runtime): propagate exchange through decision and risk chain
  12. Single push
```

NO commits or pushes are permitted between steps 1–10. The working tree stays dirty until step 10 passes all verification gates.

Why a single commit is REQUIRED (not just recommended):

| If we commit after... | Then... |
|---|---|
| Phase 1 only (types) | KillSwitch.ts exports new signatures → `TradingRuntime.ts:155` fails to compile (`new KillSwitch(config)` → old arity) |
| Phase 2 (KillSwitch) | `ExecutionRouter.ts:195` fails (`ks.lock(reason)` instead of `ks.lock(exchange, reason)`); `FastPipeline.ts:173` fails (`ks.check(symbol, pos)` instead of `ks.check(exchange, symbol, pos)`) |
| Phase 3 (Router) | `SlowPipeline.ts:147` compiles but `router.updateBiasReport(report)` receives report without `exchange` → EventBus validation missing |
| Phase 4 (SlowPipeline) | `TradingRuntime.ts:227` fails (`new SlowPipeline(config)` → missing `exchange` in config) |
| Phase 5 (FastPipeline) | Same as SlowPipeline — composition root breakage |
| Phase 6 (EventBus) | `publish` validation runs but no caller yet publishes reports with `exchange` |
| Phase 7 (TradingRuntime) | Works — but no test or fixture has been updated yet |
| Phase 8 (tests) | Works — but no delivery path from split commit history |

Every intermediate commit between Phase 1 and Phase 7 produces either:
- A **compile error** (arity mismatch, missing required field), or
- A **runtime defect** (report without exchange passes through EventBus, `bias.json` collision continues), or
- A **test failure** (fixtures without exchange).

This is by design. 3B4C4 is an atomic type-propagation + validation layer, not a series of independently deployable features. The value appears at the boundary (a compile-time guarantee that all decision/risk components carry exchange) and is worthless in any intermediate state.

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

Exact test counts obtained from `node --test --import tsx` on each targeted suite against HEAD `50a7c4a`. Approximate values (`~25`, `~30`, `~15`, `~8`, `~539`) are DELETED — only exact counts are recorded.

| Suite | File | Tests (exact) | Status |
|---|---|---|---|
| MultiExchangeRuntime | `tests/runtime/trading/multi-exchange-runtime.test.ts` | 56 | ✅ 56/56 |
| TradingRuntime | `tests/runtime/trading/trading-runtime.test.ts` | 68 | ✅ 68/68 |
| BitgetTradingRuntime | `tests/runtime/trading/bitget-trading-runtime.test.ts` | 46 | ✅ 46/46 |
| BinanceTradingRuntime | `tests/runtime/trading/binance-trading-runtime.test.ts` | 16 | ✅ 16/16 |
| ExchangeTradingRuntime | `tests/runtime/trading/exchange-trading-runtime.test.ts` | 15 | ✅ 15/15 |
| ExchangeProvider | `tests/runtime/trading/exchange-market-data-provider.test.ts` | 20 | ✅ 20/20 |
| MarketDataRuntime | `tests/runtime/market/market-data-runtime.test.ts` | 28 | ✅ 28/28 |
| FastPipeline | `tests/pipeline/fast-pipeline-market.test.ts` | 18 | ✅ 18/18 |
| SlowPipeline | `tests/pipeline/slow-pipeline.test.ts` | 17 | ✅ 17/17 |
| MarketSnapshotStore | `tests/data/market-snapshot-store.test.ts` | 27 | ✅ 27/27 |
| CandleSeriesStore | `tests/data/candle-series-store.test.ts` | 25 | ✅ 25/25 |
| EventBus | `tests/events/trading-event-bus.test.ts` | 21 | ✅ 21/21 |
| BitgetV2PublicCollector | `tests/data/bitget/bitget-v2-public-collector.test.ts` | 68 | ✅ 68/68 |
| BinanceV2PublicCollector | `tests/data/binance/binance-v2-public-collector.test.ts` | 33 | ✅ 33/33 |
| KillSwitch | `tests/router/kill-switch.test.ts` | 27 | ✅ 27/27 |
| ExecutionRouter | `tests/router/execution-router.test.ts` | 32 | ✅ 32/32 |
| ReportStore | `tests/store/report-store.test.ts` | 8 | ✅ 8/8 |
| **Targeted subtotal** | _(17 suites)_ | **525** | — |

Note: `npm test` (full suite) runs 77 test files across the entire repository, including e2e, integration, observability, and unit test suites not listed above. The full suite contains pre-existing failures unrelated to Stage 3B4C3/3B4C4 (e.g. `tests/e2e/*`, `tests/pipeline.test.ts`, `tests/recovery/*`, `tests/trading-safety.test.ts`, API Gateway tests). These pre-existing failures are unchanged by Stage 3B4C4-AUDIT (no production code modified). The targeted 17-suite regression (525 tests, all passing) is the relevant quality baseline for 3B4C4 implementation.

---

## 12. Implementation File List

### Production files modified (7 files)

| # | File | Phase | Changes |
|---|------|-------|---------|
| 1 | `src/types/market-bias.ts` | 1 | Add `readonly exchange: ExchangeId` to `MarketBiasReport` |
| 2 | `src/data/MarketIdentity.ts` | 1 | Add `assertExchangeId(componentName, exchange)` helper |
| 3 | `src/router/KillSwitch.ts` | 1, 2 | Constructor `(exchange, config?)`; `RiskSnapshot.exchange`; all 5 public methods take `exchange` first param and validate |
| 4 | `src/router/ExecutionRouter.ts` | 3, 4 | `RouterConfig.exchange`; class `readonly exchange`; `route(signal)` input + `RouteDecision.exchange`; `updateBiasReport` validates + exchange-scoped filename; `loadBiasReportFromDisk` exchange-scoped + validate; `checkFastPathTimeout` passes exchange to `ks.lock`; line 181 `killSwitch.snapshot(this.exchange)`; line 195 `killSwitch.lock(this.exchange, reason)` |
| 5 | `src/pipeline/SlowPipeline.ts` | 5 | `SlowPipelineConfig.exchange`; constructor validation; `run(exchange, symbol, tradeDate?)` validates; adapter payload gains `exchange`; report spread overrides `exchange`; `buildFallbackReport(exchange, ...)` uses bound exchange |
| 6 | `src/pipeline/FastPipeline.ts` | 6 | `FastPipelineConfig.exchange`; constructor validates `config.exchange` and `config.marketData?.exchange === config.exchange`; `execute(signal)` validates `signal.exchange`; `FastPipelineResult.exchange`; `decision_made` event payload gains `exchange`; line 173 `killSwitch.check(this.config.exchange, signal.symbol, 0)` |
| 7 | `src/events/TradingEventBus.ts` | 7 | `publish()`: validate `report.exchange` for `research.bias.updated`; throw `InvalidExchangeProvenanceError` on missing/invalid |
| 8 | `src/runtime/trading/TradingRuntime.ts` | 8 | Pass `exchange` to `new KillSwitch(exchange, ...)`, `new ExecutionRouter({ exchange, killSwitch: ks, ... })`, `new FastPipeline({ exchange, ... })`, `new SlowPipeline({ exchange, ... })`; validate caller-injected `router.exchange === exchange`; validate caller-injected `killSwitch.exchange === exchange` |

### Production files NOT modified (verified out-of-scope)

| File | Reason |
|------|--------|
| `src/store/ReportStore.ts` | Generic atomic file store — `ReportStoreConfig.filename` already accepts any path; exchange isolation is router's concern |
| `src/runtime/trading/BitgetTradingRuntime.ts` | Wrapper fixes `exchange: 'bitget'`; passes through to TradingRuntime |
| `src/runtime/trading/BinanceTradingRuntime.ts` | Wrapper fixes `exchange: 'binance'`; same |
| `src/runtime/trading/ExchangeTradingRuntime.ts` | Discriminator passes `exchange` from caller |
| `src/runtime/trading/MultiExchangeRuntime.ts` | Isolation enforcement unchanged |
| `src/data/MarketSnapshot.ts` | Already has `exchange: ExchangeId` |
| `src/data/types.ts` | `WsTicker`/`WsKline` already extend `ExchangeAwareMarketData` |
| `src/events/TradingEvent.ts` | Event payload map unchanged — exchange arrives inside `report.exchange` |

### Test files modified (10 files)

| File | Phase | Test changes (brief) |
|------|-------|----------------------|
| `tests/router/kill-switch.test.ts` | 2 | All 27 tests need `exchange` added to constructor + every method call + RiskSnapshot assertions |
| `tests/router/execution-router.test.ts` | 3, 4 | All 32 tests need `exchange` in `RouterConfig`, `route` signal, `RouteDecision` assertions; exchange-scoped file path tests; mismatch-throw tests |
| `tests/pipeline/slow-pipeline.test.ts` | 5 | All 17 tests need `exchange` in `SlowPipelineConfig`, `pipeline.run(exchange, ...)` call signature, fixtures |
| `tests/pipeline/fast-pipeline-market.test.ts` | 6 | All 18 tests need `exchange` in `FastPipelineConfig`, `fp.execute({exchange, ...})` signal, `FastPipelineResult.exchange` assertions, `decision_made` event assertions |
| `tests/events/trading-event-bus.test.ts` | 7 | Fixture at line 43 gains `exchange`; 21 existing tests pass; add 4 new tests (missing/invalid/case-variant/valid exchange) |
| `tests/runtime/trading/trading-runtime.test.ts` | 8 | Line 977 injects exchange-bound router + KS; 68 tests pass once fixtures updated |
| `tests/runtime/trading/multi-exchange-runtime.test.ts` | 8 | Add 2 new tests: `runtime.router.exchange === 'bitget'` (and 'binance'); `bias.bitget.json` and `bias.binance.json` are independent. Existing 56 tests pass unchanged. |
| `tests/e2e/step-1-7-e2e.test.ts` | 9 | `makeBiasReport` fixture at line 42 gains `exchange: 'bitget'`; `new FastPipeline(config)` config gains `exchange`; `fp.execute()` calls at lines 111/129/156/170/189 gain `exchange` |
| `tests/runtime/market/universe-manager.test.ts` | 9 | 4 `MarketBiasReportFull` fixtures at lines 31, 223, 238, 249, 271, 333, 338 gain `exchange` field |
| `tests/store/report-store.test.ts` | _no change_ | API unchanged — `ReportStore` accepts arbitrary filename; optional regression test for coexisting `bias.bitget.json` and `bias.binance.json` |

### Commit plan (single atomic commit)

```
Single commit (working tree accumulated through internal order in §9):

  feat(runtime): propagate exchange through decision and risk chain

  Stage 3B4C4 — atomic exchange-awareness propagation across the
  decision and risk pipeline. Single commit required: every intermediate
  commit between Phase 1 (types) and Phase 7 (composition root) produces
  either a compile error, runtime defect, or test failure. See
  docs/architecture/exchange-aware-decision-risk-contract.md §9 for
  the case-by-case proof.

  Production changes (8 files):
    - src/types/market-bias.ts: MarketBiasReport.exchange
    - src/data/MarketIdentity.ts: assertExchangeId helper
    - src/router/KillSwitch.ts: exchange binding + 5 method signatures
    - src/router/ExecutionRouter.ts: exchange-aware routing + bias-report file isolation
    - src/pipeline/SlowPipeline.ts: exchange-bound SlowPipeline
    - src/pipeline/FastPipeline.ts: exchange-bound FastPipeline
    - src/events/TradingEventBus.ts: research.bias.updated provenance validation
    - src/runtime/trading/TradingRuntime.ts: composition root propagation + injected-component validation

  Test changes (10 files):
    - 5 suite-level fixture/signature updates (kill-switch, execution-router,
      slow-pipeline, fast-pipeline-market, trading-event-bus)
    - 5 call-site fixture updates (trading-runtime, multi-exchange-runtime,
      e2e/step-1-7, universe-manager, plus optional report-store regression)

  Verification:
    - npm run typecheck — 0 errors
    - npm run build — 0 errors
    - Targeted regression: 525 tests across 17 suites (see §11 baseline) — 525/525 passing
    - MultiExchangeRuntime: 56 + 2 new tests = 58 tests
```

After single commit + push, the chain is:

```
HEAD before: 50a7c4a  (3B4C4-AUDIT document)
HEAD after:  <new sha>  (3B4C4 atomic implementation)
```

---

## Revision History

| Rev | Date | Author | Changes |
|-----|------|--------|---------|
| 1 | 2026-07-19 | — | Initial audit (Stage 3B4C4-AUDIT) |
| 2 | 2026-07-19 | — | Stage 3B4C4-AUDIT-R1: corrected atomic strategy (single commit), §3D unified failure semantics, §3E explicit vs bound resolution, §4 doubling fix, §1C exact call-site inventory with `rg` evidence, §11 exact test baseline (525/525 across 17 suites, no approximate counts), §12 single-commit plan with 8 production + 10 test files |
