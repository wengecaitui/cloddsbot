# Multi-Exchange Runtime Architecture Audit & Design

**Stage**: 3B4C-AUDIT-R1
**Baseline HEAD**: `f1133b578204a4d493ea582e4f49428f7d35dc00`
**Scope**: Bitget + Binance 同时运行的安全架构设计
**Constraint**: 本阶段**禁止修改生产代码**，仅产出设计文档。所有发现的阻断项/非阻断项均基于当前真实代码审计。

---

## 0. 审计基础事实（基于当前 HEAD）

| 模块 | 文件 | 关键事实（行号） |
|------|------|------------------|
| TradingRuntime | `src/runtime/trading/TradingRuntime.ts` (437) | 单 `universe`、`bus`、`store`、`candleStore`、`fastPipeline`、`slowPipeline` 均在 runtime 内创建；`start`/`stop`/`applyUniversePlan` 单一生命周期 (L254-435) |
| MarketDataRuntime | `src/runtime/market/MarketDataRuntime.ts` (203) | 持有 `bus` + `store` + `candleStore`；`collector.onTicker` → `bus.publish('market.ticker.updated')` 直接透传 `ticker` (L128-141) |
| PlanAwareCollector | `src/runtime/trading/PlanAwareCollector.ts` (83) | 将 `ticker.instId` / `kline.instId` 从 exchangeSymbol 重写为 canonical symbol (L66, L78)；**抹掉源标识** |
| ExchangeMarketDataProvider | `src/runtime/trading/ExchangeMarketDataProvider.ts` (26) | 仅 `exchange` + `createCollector(plan)`；不持有 Store/EventBus |
| Bitget/Binance Provider | `BitgetMarketDataProvider.ts` (196) / `BinanceMarketDataProvider.ts` (172) | 仅快照配置 + 构造 Collector；**不接触 Store/EventBus** |
| EventBus | `src/events/TradingEventBus.ts` (68) + `TradingEvent.ts` (27) | 3 种事件：`market.ticker.updated` / `market.kline.closed` / `research.bias.updated`；`payload.ticker` / `payload.kline` 为裸 `WsTicker`/`WsKline`，**无 exchange 字段** |
| MarketSnapshotStore | `src/data/MarketSnapshotStore.ts` (222) | key = `ticker.instId` / `kline.instId` (L120, L168)；**无 exchange 维度** |
| CandleSeriesStore | `src/data/CandleSeriesStore.ts` (166) | key = `${symbol}::${interval}` (L78)；**无 exchange 维度** |
| SymbolRegistry | `src/runtime/market/SymbolFormat.ts` (92) | **exchange-agnostic 显式映射容器**；`toExchange(canonical)` 仅依据注入的 mappings 表查 `canonMap` (L64-70)；`createSymbolRegistry` 强制至少一条映射 (L22-25)，canonical/exchange 双向唯一 (L51-56) |
| UniverseManager | `src/runtime/market/UniverseManager.ts` (340) | 接收 `UniverseConfig.registry` 注入 (L19, L148-151)；`buildEntry` 通过 `registry.toExchange(symbol)` 生成 `exchangeSymbol` (L185)；`version` 单调自增 (L159)，仅本 Universe 范围内 |
| FastPipeline | `src/pipeline/FastPipeline.ts` (318) | `signal.symbol` (canonical) 直接查 `snapshotStore.getSnapshot(symbol)` / `candleStore.getSeries(symbol, interval, ...)` (L188, L235, L247)；**无 exchange 维度** |
| SlowPipeline | `src/pipeline/SlowPipeline.ts` (217) | 产出 `MarketBiasReport`，symbol 为 canonical；`bus` 可注入但无 exchange 概念 |
| ExecutionRouter | `src/router/ExecutionRouter.ts` (210) | 按 `SignalSource` 分流；`killSwitch.check(symbol, positionUsd)` (L78, L165)；**无 exchange 维度** |
| KillSwitch | `src/router/KillSwitch.ts` (140) | `check(symbol, positionUsd)`；全局风险预算；**无 exchange 维度** |

---

## 1. 数据身份冲突（Data Identity Conflict）

### 1.1 问题

`binance:BTC/USDT` 和 `bitget:BTC/USDT` 在现有管道中都会归一化为 canonical `BTC/USDT`：

```
Collector (Binance)  → instId=BTCUSDT        → PlanAwareCollector → instId=BTC/USDT
Collector (Bitget)   → instId=BTCUSDT_UMCBL  → PlanAwareCollector → instId=BTC/USDT
```

两者随后进入 `MarketSnapshotStore` 与 `CandleSeriesStore`，以 `BTC/USDT` 为 key
（store 无 exchange 维度）。**结果：后到的 exchange 数据覆盖先到的，且无法区分来源。**

### 1.2 当前 Store/EventBus 能否区分？

| 组件 | 能否区分 `binance:BTC/USDT` vs `bitget:BTC/USDT` |
|------|---------------------------------------------------|
| MarketSnapshotStore | **否** — key = `ticker.instId` (canonical)，无 exchange |
| CandleSeriesStore | **否** — key = `${symbol}::${interval}`，无 exchange |
| EventBus `market.ticker.updated` | **否** — `WsTicker` 无 `exchange` 字段 |
| EventBus `market.kline.closed` | **否** — `WsKline` 无 `exchange` 字段 |
| PlanAwareCollector 输出 | **否** — 主动抹掉 `exchangeSymbol` |

### 1.3 硬约束

> **禁止在未增加来源标识时把两边数据写入同一 `symbol` key。**

当前代码**违反**此约束——若同时运行两个 Runtime 且共享 `store`/`candleStore`，必然发生数据覆盖。
**前提条件**：方案 B 的两个子 Runtime 各自创建独立 Store（不共享），不存在跨 Runtime 写入同一 Store 的情况。Store 内部 key 仍需 exchange 维度，以便单 Runtime 演进到 CompositeCollector 时不会碰撞。

---

## 2. 推荐拓扑（Topology Comparison）— 方案 B ★

```
MultiExchangeRuntime (协调器)
  ├─ runtimes: Map<ExchangeId, TradingRuntime>
  │   ├─ BitgetTradingRuntime (store_G, candle_G, bus_G, universe_G, registry_G, fast_G, slow_G)
  │   └─ BinanceTradingRuntime (store_B, candle_B, bus_B, universe_B, registry_B, fast_B, slow_B)
  ├─ 共享 KillSwitch + 共享 ExecutionRouter（带 exchange 维度）
  └─ coordinator (start / stop / apply / health)
```

| 维度 | 评估 |
|------|------|
| 生命周期 | 协调层统一 `start`（允许 partial running）、`stop`（并行、幂等）、`applyUniversePlan(exchange)` 仅目标侧 |
| Store 隔离 | 每子 Runtime 独立 Store；父层不共享 Store |
| Universe 隔离 | 每子 Runtime 独立 UniverseManager + **独立 SymbolRegistry** |
| 故障域 | 独立故障域；一侧崩溃 → `degraded`，另一侧继续 |
| 数据来源追踪 | 每子 Runtime 独立 Store + 每事件携带 `exchange` 字段（3B4C1） |
| Pipeline 重复执行 | 仍每交易所一份 Fast/Slow（初期可接受；见 §6） |
| 风控和路由 | **共享** KillSwitch + ExecutionRouter，但所有 signal 携带 `exchange` 维度 |
| 实现复杂度 | 中 — 新增协调层 + 各模块加 `exchange` 字段（3B4C1/2/4） |

**排除方案**：

- **方案 A（两个完全独立 Runtime 无协调层）**：缺统一健康模型与共享风控
- **方案 C（单 TradingRuntime + CompositeCollector）**：违反"不实现 CompositeCollector"边界，且 Store 改造风险大

---

## 3. 市场数据模型（Market Data Model）— 唯一数据身份来源

### 3.1 来源标识契约（强制必修类型）

```typescript
// 新增类型（建议 src/data/market-identity.ts）
export type ExchangeId = 'bitget' | 'binance';  // 复用 ExchangeMarketDataProvider.ExchangeId

export interface ExchangeAwareMarketData {
  readonly exchange: ExchangeId;     // 必填，禁止 optional / unknown / 默认值
  readonly instId: string;            // Collector 输出阶段为 exchangeSymbol；PlanAwareCollector 输出阶段为 canonical symbol
}
```

### 3.2 数据在各层级的身份语义（**唯一来源**）

| 层级 | 输出 `instId` | 输出 `exchange` |
|------|---------------|-----------------|
| **Collector 原始输出** | `exchangeSymbol` (Bitget: `BTCUSDT_UMCBL`；Binance: `BTCUSDT`) | **必填**（3B4C1） |
| **PlanAwareCollector 输出** | canonical symbol (`BTC/USDT`) — 经 `registry.toCanonical` 重写 | **原样保留**（3B4C1，禁止抹掉） |
| **进入 Runtime 后** | canonical symbol | exchange + canonical instId 共同构成唯一身份 |
| **Store key** | `sourceKey(exchange, canonicalSymbol)` | 形如 `binance:BTC/USDT` / `bitget:BTC/USDT` |
| **EventBus event** | `ticker.instId` / `kline.instId`（canonical） | `ticker.exchange` / `kline.exchange` |
| **Pipeline signal** | `signal.symbol`（canonical） | `signal.exchange` |
| **Router/KillSwitch** | `symbol`（canonical） | `exchange` 维度 |

### 3.3 严格不变量

- **禁止** `exchange` 可选（`exchange?`）/ 设为 `unknown` / `0` / 默认交易所占位符
- **MarketSource 从 `ticker.exchange` / `kline.exchange` 派生**，不重新构造
- **EventBus 不再额外保存一份可能与 payload 冲突的独立 `source` 字段** — 来源信息直接在 `ticker.exchange` / `kline.exchange` 上，EventBus 透传即可
- Store key 必须使用 `sourceKey(exchange, canonicalSymbol)`，禁止仅用 `canonicalSymbol`
- Binance Runtime 必须**注入 Binance 映射**到自己的 SymbolRegistry；Bitget Runtime 必须**注入 Bitget 映射**
- Provider 与 Registry exchange 不匹配属于**配置错误**，未来由 composition root 校验（3B4C3 实施）

### 3.4 必须修改的现有类型（本阶段不修改，仅标记）

- `src/data/types.ts` — `WsTicker` / `WsKline` 增加 `exchange: ExchangeId`（必填）
- `src/data/MarketSnapshot.ts` / `MarketSnapshotStore.ts` — Store key 改为 `sourceKey`
- `src/data/CandleSeriesStore.ts` — `keyOf` 改为 `sourceKey`
- `src/events/TradingEvent.ts` — payload 不再额外增加 `source` 字段（exchange 已在 `ticker`/`kline` 内）
- `src/runtime/trading/PlanAwareCollector.ts` — 保留 `exchange` 透传，禁止抹掉

---

## 4. 聚合语义（Aggregation Semantics）

**系统初期采用：完全隔离，不聚合。**

| 策略 | 初期是否采用 | 原因 |
|------|--------------|------|
| 完全隔离，不聚合 | ✅ **采用** | 安全、可观测、无歧义 |
| primary/fallback | ❌ | 隐含"覆盖"语义，风险高 |
| best-price selection | ❌ | 需跨交易所比价，复杂度高 |
| cross-exchange consolidated feed | ❌ | 违反隔离原则 |
| arbitrage comparison | ❌ | 禁止套利策略（边界） |

**硬约束**：
> 不得静默选择最新价格或覆盖另一个交易所数据。
> 每个交易所的数据独立存储、独立参与各自决策。

---

## 5. 生命周期语义（Lifecycle Semantics）

### 5.1 start

- **允许 partial running**：`start()` 并发 `start` 两个子 Runtime；只要 ≥1 成功即返回 resolved，但结果标记每个交易所状态
- 全部失败 → rejected

### 5.2 故障隔离

- 一个交易所故障**不停止**另一个
- 故障侧进入 `degraded` / `failed` 状态
- 健康侧继续提供行情与决策

### 5.3 stop

- **并行**调用各子 Runtime `stop()`
- **幂等**：重复调用无副作用（子 Runtime `stop` 已幂等，见 TradingRuntime L186-201）
- 全部停止后父层状态 → `stopped`

### 5.4 applyUniversePlan

- **逐交易所**：`applyUniversePlan(exchange: ExchangeId)` 只重启目标子 Runtime
- 一边更新 Universe **不重启**另一边（满足 §7 配置不变量）

### 5.5 restart 回滚

- 单交易所 restart 失败 → 该侧保持 `failed`，不影响另一侧
- 不允许故障交易所旧数据继续参与决策（Store 隔离 + 状态门控）

### 5.6 状态模型

```typescript
type MultiExchangeRuntimeState =
  | 'stopped'
  | 'running'        // 全部健康
  | 'degraded'       // ≥1 健康，≥1 故障/未启动
  | 'failed';        // 全部故障

interface PerExchangeStatus {
  exchange: ExchangeId;
  state: 'running' | 'degraded' | 'failed' | 'stopped';
  planVersion: number;        // 子 Runtime 内 planVersion，保持 number 类型
  lastError?: string;
}
```

---

## 6. Pipeline 和决策边界（Pipeline & Decision Boundary）

### 6.1 每交易所独立 Fast/Slow Pipeline

- 初期：每个子 TradingRuntime 自带 Fast/Slow（方案 B 继承）
- 指标计算重复，但**安全且隔离**；后续可优化共享 IndicatorService（见 6.2）

### 6.2 是否共享 IndicatorService？

- **可以共享**（纯函数，无状态）——但输入必须按 `exchange` 分桶查询各自 Store
- 禁止：用 A 交易所的 candle 喂 B 交易所的指标

### 6.3 是否共享 ExecutionRouter？

- **共享**（方案 B），但 `route()` / `killSwitch.check()` 必须接收 `exchange` 维度
- 当前 `KillSwitch.check(symbol, positionUsd)` 无 exchange → 需扩展为 `check(exchange, symbol, positionUsd)`

### 6.4 相同 canonical symbol 重复信号

- `binance:BTC/USDT` 与 `bitget:BTC/USDT` 会各自产生信号
- **允许同时存在**，但风控必须识别来源（6.3）
- 禁止：跨交易所自动合并信号

### 6.5 风控识别信号来源

- 所有 `FastPipelineResult` / `RouteDecision` 必须携带 `exchange`
- KillSwitch 预算可按 exchange 分桶或全局共享（初期全局共享 + 来源标记）

### 6.6 硬禁止

> 在尚未建立 exchange-aware execution 前，**禁止跨交易所自动下单**。
> 初期两个交易所的 Runtime 仅提供行情 + 独立信号；下单路由不在本阶段范围。

---

## 7. Universe & Registry 设计（Universe & Symbol Registry Design）

### 7.1 配置不变量（Configuration Invariant — 非 Blocker）

**事实**：`SymbolRegistry` 是 exchange-agnostic 的显式映射容器（`SymbolFormat.ts` L22-92）。`toExchange(canonical)` 仅根据注入的 `mappings` 查 `canonMap`（L64-70），**不存在"默认 Bitget 映射"**——文档先前结论错误，已修正。

**正确不变量**：

| 要求 | 设计 |
|------|------|
| 每子 Runtime 独立 SymbolRegistry | ✅ 方案 B：每子 Runtime 注入该交易所专属 mappings |
| Binance Runtime 注入 Binance 映射 | ✅ `createSymbolRegistry([{ canonical: 'BTC/USDT', exchange: 'BTCUSDT' }, ...])` |
| Bitget Runtime 注入 Bitget 映射 | ✅ `createSymbolRegistry([{ canonical: 'BTC/USDT', exchange: 'BTCUSDT_UMCBL' }, ...])` |
| 初期不修改 `toExchange(canonical)` API | ✅ 保持单参数 API；每个 Registry 只持有本交易所映射，无歧义 |
| Provider 与 Registry exchange 不匹配 | 由 composition root（3B4C3）校验：构造子 Runtime 时 `assert(provider.exchange === registry mappings 的目标 exchange)`，不匹配抛配置错误 |

**重要纠正**：先前版本将"SymbolFormat 默认 Bitget 映射"列为 Blocker，**此项错误，已删除**。`SymbolRegistry` 不存在任何"默认"行为；它只忠实反映注入的映射。

### 7.2 planVersion 模型（非 Blocker — 空 ID 维度由父层承担）

**事实**：`SubscriptionPlan.version` 在 `UniverseManager` 内单调自增（L159），仅在本 Universe 范围内有效。两个独立 UniverseManager 自然有两个独立 `version` 序列。

**正确设计**：

| 要求 | 设计 |
|------|------|
| 子 Runtime 内 `planVersion` 保持 `number` | ✅ 不修改 `UniverseManager` 与 `SubscriptionPlan` 类型 |
| 父协调器维度化 | ✅ 协调器视角下版本由 `{ exchange, planVersion }` 元组表达；`statuses: Map<ExchangeId, PerExchangeStatus>` 以 ExchangeId 为 key |
| 一侧 Universe 更新不影响另一侧版本 | ✅ 各 UniverseManager 独立；`applyUniversePlan(bitget)` 不会触碰 binance 的 version |

**重要纠正**：先前版本将"planVersion 必须增加 exchange 字段"列为 Blocker，**此项错误，已删除**。子 Runtime 的 `planVersion: number` 不变，父协调器通过 `ExchangeId` key 索引各子 Runtime 的 `planVersion`，天然实现跨交易所维度。

### 7.3 真正的 Universe 范围 Blocker

无。两个独立 UniverseManager + 两个独立 SymbolRegistry 即可满足所有 Universe 范围要求。Universe 维度的所有"跨交易所冲突"在物理隔离下不存在。

---

## 8. 状态和 API 草案（Interface Draft — 不编码）

```typescript
export type MultiExchangeRuntimeState =
  | 'stopped'
  | 'running'
  | 'degraded'
  | 'failed';

export interface PerExchangeStatus {
  readonly exchange: ExchangeId;
  readonly state: 'running' | 'degraded' | 'failed' | 'stopped';
  readonly planVersion: number;        // 子 Runtime 内 planVersion 保持 number
  readonly lastError?: string;
}

export interface MultiExchangeStartResult {
  readonly started: ReadonlyArray<ExchangeId>;
  readonly failed: ReadonlyArray<{ exchange: ExchangeId; error: string }>;
  readonly partial: boolean;  // true if some but not all started
}

export interface MultiExchangeRuntime {
  readonly runtimes: ReadonlyMap<ExchangeId, TradingRuntime>;
  readonly state: MultiExchangeRuntimeState;
  readonly statuses: ReadonlyMap<ExchangeId, PerExchangeStatus>;

  start(): Promise<MultiExchangeStartResult>;
  stop(): void;
  applyUniversePlan(exchange: ExchangeId): Promise<UniverseApplyResult>;
  getRuntime(exchange: ExchangeId): TradingRuntime;
  getStatus(exchange: ExchangeId): PerExchangeStatus;
}
```

---

## 9. 分阶段实施计划（Phased Plan）

> **3B4C2 单 commit 完整迁移原则**：Store API + EventBus + MarketDataRuntime + FastPipeline 所有 Store 查询必须在同一 commit 内完成迁移，禁止中间不一致状态。

### 3B4C1 — exchange-aware market identity

**文件范围**：
- `src/data/types.ts`（`WsTicker` / `WsKline` 增加 `exchange: ExchangeId` **必填**）
- `src/runtime/trading/PlanAwareCollector.ts`（保留 `exchange` 透传，禁止抹掉）
- `src/data/bitget/*`、`src/data/binance/*`（Collector 输出强制标记 `exchange`）

**不变量**：
- Collector 输出必带 `exchange`（必填，禁止 optional / unknown / 默认值）
- PlanAwareCollector 不得抹掉 `exchange`
- Binance Collector → `exchange: 'binance'`；Bitget Collector → `exchange: 'bitget'`

**测试要求**：Collector 输出含 `exchange`；PlanAwareCollector 透传 `exchange`

**回滚边界**：仅类型扩展 + Collector 赋值，不影响单交易所行为（exchange 字段对单交易所场景无害）

**禁止**：修改 TradingRuntime 生命周期；实现 CompositeCollector；将 `exchange` 设为可选

---

### 3B4C2 — Store sourceKey + EventBus + MarketDataRuntime + FastPipeline 同步迁移

**文件范围（必须单 commit）**：
- `src/data/MarketSnapshotStore.ts`（`sourceKey` 替代 `symbol` key）
- `src/data/CandleSeriesStore.ts`（`keyOf` 改为 `sourceKey`）
- `src/events/TradingEvent.ts`（**不**新增 `source` 字段；exchange 已在 `ticker`/`kline` 内，EventBus 透传）
- `src/runtime/market/MarketDataRuntime.ts`（publish 时透传含 `exchange` 的 `ticker`/`kline`）
- `src/pipeline/FastPipeline.ts`（所有 Store 查询迁移到 `sourceKey(exchange, symbol)`）

**不变量**：
- `binance:BTC/USDT` 与 `bitget:BTC/USDT` 写入不同 key，互不覆盖
- EventBus 事件中 `ticker.exchange` / `kline.exchange` 必填
- FastPipeline 查询 Snapshot/CandleStore 时使用 `sourceKey(signal.exchange, signal.symbol)`
- **不存在中间不一致状态**：Store 改了 key 但 Pipeline 还在用旧 key 的查询路径，禁止

**测试要求**：双交易所同 symbol 数据独立；EventBus 事件 `ticker.exchange` / `kline.exchange` 非空；FastPipeline 双交易所分别查询各自 Store

**回滚边界**：Store key 格式变更；单交易所 Runtime 也需相应更新查询（exchange 字段在 3B4C1 已存在）

**禁止**：共享 Store 跨交易所；静默覆盖；EventBus 独立保存可能与 payload 冲突的 `source` 字段

---

### 3B4C3 — MultiExchangeRuntime coordinator

**文件范围**：
- `src/runtime/trading/MultiExchangeRuntime.ts`（新增）
- 复用 `createExchangeTradingRuntime`（3B4B）+ 独立 UniverseManager / SymbolRegistry / Store / Bus / Pipeline 每子 Runtime

**不变量**：
- `start` 允许 partial running；`stop` 并行幂等；`applyUniversePlan(exchange)` 仅目标侧
- 每子 Runtime 独立 Store/Bus/Universe/Pipeline
- Composition root 校验 `provider.exchange === registry 目标 exchange`，不匹配抛配置错误
- `statuses` 以 `ExchangeId` 为 key，`planVersion` 为子 Runtime 内的 number

**测试要求**：一交易所故障不影响另一；degraded 状态正确；stop 幂等；composition root 配置错误校验

**回滚边界**：协调层独立；子 Runtime 不变

**禁止**：修改单交易所 Runtime 内部行为；实现 CompositeCollector；共享 Store

---

### 3B4C4 — Signal / SlowPipeline / Router / KillSwitch exchange 传播

**文件范围**：
- `src/pipeline/FastPipeline.ts`（`FastPipelineResult` + `exchange`）
- `src/pipeline/SlowPipeline.ts`（`MarketBiasReport` / `SlowPipeline` + `exchange`）
- `src/router/ExecutionRouter.ts`（`route` / `SignalSource` + `exchange`；`RouteDecision` + `exchange`）
- `src/router/KillSwitch.ts`（`check(exchange, symbol, positionUsd)`；`RiskSnapshot` + per-exchange 字段）

**不变量**：
- 所有 signal 携带 `exchange`；决策结果携带 `exchange`
- 风控识别来源；KillSwitch 可按来源记账
- **仍禁止真实下单和跨交易所执行**（本阶段仅传播维度）

**测试要求**：双交易所同 symbol 信号独立；KillSwitch 按来源记录；RouteDecision 携带 `exchange`

**回滚边界**：信号结构与 Router/KillSwitch API 扩展；下单路由仍禁用

**禁止**：跨交易所自动下单；套利策略；合并不同交易所的信号

---

### 3B4C5 — 全离线双交易所集成测试

**文件范围**：
- `tests/runtime/trading/multi-exchange-runtime.test.ts`（新增）
- 复用 `FakeWSFactory` + `FakeScheduler`

**不变量**：双交易所并行运行；数据隔离；故障隔离；degraded 状态

**测试要求**：
- 两交易所同时 start，数据不串（store/candle/bus 三个维度均隔离）
- 一交易所 socket 故障，另一继续提供行情
- `applyUniversePlan(bitget)` 不影响 binance 的 planVersion
- stop 幂等；composition root 拒绝错误 Provider/Registry 组合

**回滚边界**：纯测试，无生产代码

**禁止**：接私有 WS；读 API keys；账户/持仓/下单；套利

---

## 10. 阻断项与非阻断项（Blockers & Non-Blockers）

### 阻断项（Blockers — 必须在 3B4C1/2/4 解决）

1. **`WsTicker` / `WsKline` 缺少 `exchange` provenance**（`src/data/types.ts`）
   → Collector 输出来源不可识别。必须先做 3B4C1。

2. **`PlanAwareCollector` 未保留 `exchange`**（PlanAwareCollector L66/L78）
   → 源标识在 Runtime 边界被抹掉。必须 3B4C1 保留透传。

3. **Store key 无 exchange 维度**（MarketSnapshotStore L120/L168, CandleSeriesStore L78）
   → 双交易所同 symbol 数据碰撞覆盖（即使 3B4C3 子 Runtime 物理隔离 Store，单 Runtime 演进 CompositeCollector 仍会碰撞）。必须 3B4C2 改造。

4. **Pipeline Store 查询无 exchange 维度**（FastPipeline L188/L235/L247）
   → FastPipeline 无法区分从哪个交易所 Store 读取。必须 3B4C2 同步迁移。

5. **风控/路由尚未 exchange-aware**（ExecutionRouter L78/L165, KillSwitch check 接口）
   → **仅在执行启用前阻断**——本阶段不下单，此项不阻塞 3B4C1/2/3；3B4C4 实施前禁止接真实下单。

### 已删除的伪 Blocker（错误结论纠正）

- ~~SymbolFormat 默认 Bitget 映射~~ — **错误**：SymbolRegistry 是 exchange-agnostic 显式映射容器，不存在默认行为。改为 Configuration Invariant（§7.1）。
- ~~planVersion 必须增加 exchange 字段~~ — **错误**：两个独立 UniverseManager 自然有独立 version 序列；父协调器通过 `ExchangeId` key 维度化。改为非 Blocker（§7.2）。

### 非阻断项（Non-Blockers — 可延后）

1. **Pipeline 指标重复计算**（每交易所独立 Fast/Slow）
   → 初期可接受；后续可共享 IndicatorService（纯函数）。

2. **SlowPipeline 报告无 exchange 维度**
   → 初期研究报告按 canonical symbol；exchange-aware 研究报告由 3B4C4 同步治理。

---

## 11. 边界遵守声明（Boundary Compliance）

- ✅ 不修改生产代码（本阶段仅文档）
- ✅ 不实现 CompositeCollector（方案 B 明确排除）
- ✅ 不接私有 WS / 账户 / API keys / 下单
- ✅ 不实现套利策略
- ✅ 不修改现有单交易所 Runtime 行为（3B4C3 仅新增协调层）
- ✅ 初期完全隔离，不聚合
- ✅ 禁止 `exchange` optional / unknown / 0 / 默认交易所占位符（§3.3）
- ✅ EventBus 不保存可能与 payload 冲突的独立 `source` 字段（§3.3）

---

## 12. 修订记录

| 版本 | 日期 | HEAD | 修订内容 |
|------|------|------|----------|
| 3B4C | 2026-07-17 | `5bf6c2a` | 初版：审计 + 方案 B + 5 阶段计划 |
| 3B4C-AUDIT-R1 | 2026-07-17 | `f1133b5` | 修正 6 处不变量：SymbolRegistry 改为 Configuration Invariant；planVersion 改为非 Blocker；唯一数据身份来源契约；3B4C2 单 commit 同步迁移；Blockers 精简为 5 项（执行项条件性） |

---

*Generated for Stage 3B4C-AUDIT-R1 — Multi-Exchange Runtime Architecture Audit.*
*All code references verified against HEAD `f1133b578204a4d493ea582e4f49428f7d35dc00`.*
