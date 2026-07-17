# Multi-Exchange Runtime Architecture Audit & Design

**Stage**: 3B4C
**Baseline HEAD**: `5bf6c2ae4b5453fdb809097e6a630708136121e6`
**Scope**: Bitget + Binance 同时运行的安全架构设计
**Constraint**: 本阶段**禁止修改生产代码**，仅产出设计文档。所有发现的阻断项/非阻断项均基于当前真实代码审计。

---

## 0. 审计基础事实（基于当前 HEAD）

| 模块 | 文件 | 关键事实（行号） |
|------|------|------------------|
| TradingRuntime | `src/runtime/trading/TradingRuntime.ts` (437) | 单 `universe`、`bus`、`store`、`candleStore`、`fastPipeline`、`slowPipeline` 均在 runtime 内创建；`start`/`stop`/`applyUniversePlan` 单一生命周期 (L254-435) |
| MarketDataRuntime | `src/runtime/market/MarketDataRuntime.ts` (203) | 持有 `bus` + `store` + `candleStore`；`collector.onTicker` → `bus.publish('market.ticker.updated')` 直接透传 `ticker` (L128-141) |
| PlanAwareCollector | `src/runtime/trading/PlanAwareCollector.ts` (83) | **将 `ticker.instId` / `kline.instId` 从 exchangeSymbol 重写为 canonical symbol** (L66, L78)；**抹掉源标识** |
| ExchangeMarketDataProvider | `src/runtime/trading/ExchangeMarketDataProvider.ts` (26) | 仅 `exchange` + `createCollector(plan)`；不持有 Store/EventBus |
| Bitget/Binance Provider | `BitgetMarketDataProvider.ts` (196) / `BinanceMarketDataProvider.ts` (172) | 仅快照配置 + 构造 Collector；**不接触 Store/EventBus** |
| EventBus | `src/events/TradingEventBus.ts` (68) + `TradingEvent.ts` (27) | 3 种事件：`market.ticker.updated` / `market.kline.closed` / `research.bias.updated`；`payload.ticker` / `payload.kline` 为裸 `WsTicker`/`WsKline`，**无 exchange 字段** |
| MarketSnapshotStore | `src/data/MarketSnapshotStore.ts` (222) | key = `ticker.instId` / `kline.instId` (L120, L168)；**无 exchange 维度** |
| CandleSeriesStore | `src/data/CandleSeriesStore.ts` (166) | key = `${symbol}::${interval}` (L78)；**无 exchange 维度** |
| UniverseManager | `src/runtime/market/UniverseManager.ts` (340) | 单交易所全局；`version` 单调自增无 exchange 维度 (L159)；`registry.toExchange(symbol)` 默认 Bitget 映射 (L185) |
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
（即使两个 Runtime 各自创建独立 Store，FastPipeline 也不知向哪个 Store 查询，见 §6。）

---

## 2. 推荐拓扑（Topology Comparison）

### 方案 A — 两个完全独立 TradingRuntime

```
BinanceTradingRuntime (store_B, candle_B, bus_B, universe_B, fast_B, slow_B)
BitgetTradingRuntime  (store_G, candle_G, bus_G, universe_G, fast_G, slow_G)
```

| 维度 | 评估 |
|------|------|
| 生命周期 | 各自独立 `start`/`stop`/`applyUniversePlan`；无协调层 |
| Store 隔离 | 天然隔离（各自 `createTradingRuntime` 内部新建 Store） |
| Universe 隔离 | 天然隔离（各自 UniverseManager） |
| 故障域 | 完全隔离；一个崩溃不影响另一个 |
| 数据来源追踪 | 天然（store 物理隔离） |
| Pipeline 重复执行 | **重复**：两个 Fast/Slow Pipeline 实例，双份指标计算 |
| 风控和路由 | KillSwitch/ExecutionRouter 需**每交易所一份**或共享需改造 |
| 实现复杂度 | **最低** — 复用现有单交易所 Runtime，零内部改动 |

### 方案 B — 父级 MultiExchangeRuntime 管理两个子 Runtime ★ 推荐

```
MultiExchangeRuntime
  ├─ runtimes: Map<ExchangeId, TradingRuntime>
  ├─ coordinator (start/stop/apply/health)
  └─ 共享 KillSwitch + 共享 ExecutionRouter（带 source 维度）
```

| 维度 | 评估 |
|------|------|
| 生命周期 | 协调层统一 `start`（允许 partial running）、`stop`（并行、幂等）、`applyUniversePlan(exchange)` |
| Store 隔离 | 每子 Runtime 独立 Store；父层不共享 Store |
| Universe 隔离 | 每子 Runtime 独立 UniverseManager |
| 故障域 | 独立故障域；一侧故障 → `degraded` 状态，另一侧继续 |
| 数据来源追踪 | 每子 Runtime 独立 Store + 每事件携带 `exchange` 字段 |
| Pipeline 重复执行 | 仍每交易所一份 Fast/Slow（初期可接受；见 §6） |
| 风控和路由 | **共享** KillSwitch + ExecutionRouter，但所有 signal 携带 `exchange` 维度 |
| 实现复杂度 | 中 — 新增协调层 + 各模块加 `exchange` 字段（3B4C1/2/4） |

### 方案 C — 单 TradingRuntime + CompositeCollector

```
TradingRuntime (单一)
  └─ CompositeCollector (内部 fan-out 到 Bitget+Binance Collector)
```

| 维度 | 评估 |
|------|------|
| 生命周期 | 单一；无法对单交易所独立 `applyUniversePlan` |
| Store 隔离 | **必须**改造 Store 加 exchange 维度，否则碰撞 |
| Universe 隔离 | 单一 Universe 无法区分交易所符号映射 |
| 故障域 | **耦合** — 一个 Collector 故障可能拖垮整体 |
| 数据来源追踪 | 依赖 Store/EventBus 改造 |
| Pipeline 重复执行 | 单 Pipeline 但输入需按 exchange 分桶 |
| 风控和路由 | 单 Router 需完全 exchange-aware |
| 实现复杂度 | **最高** — 违反"不实现 CompositeCollector"边界，且 Store 改造风险大 |

### 唯一推荐：**方案 B**

**理由**：
1. 复用现有单交易所 Runtime（3B4A/3B4B 已验证），**不改其内部行为**
2. 故障域隔离满足"健康交易所继续提供行情"的硬要求
3. 允许 `degraded` 状态，不阻断整体
4. 避免方案 C 的 CompositeCollector（本阶段明确禁止）
5. 比方案 A 多了协调层，但换来统一健康模型与共享风控

---

## 3. 市场数据模型（Market Data Model）

### 3.1 来源标识契约

```typescript
// 新增类型（建议 src/data/market-identity.ts）
export type ExchangeId = 'bitget' | 'binance';  // 复用 ExchangeMarketDataProvider.ExchangeId

export interface MarketSource {
  readonly exchange: ExchangeId;
  readonly symbol: string;          // canonical, e.g. 'BTC/USDT'
}

// 复合 key 工具
export function sourceKey(s: MarketSource): string {
  return `${s.exchange}:${s.symbol}`;  // 'binance:BTC/USDT' | 'bitget:BTC/USDT'
}
```

### 3.2 字段必须存在的层级

| 层级 | 当前 | 改造要求 |
|------|------|----------|
| Collector 输出 (`WsTicker`/`WsKline`) | 无 `exchange` | **必须加** `exchange: ExchangeId`（3B4C1） |
| PlanAwareCollector 输出 | 重写为 canonical，无 exchange | 保留 `exchange` 透传（3B4C1） |
| Store key | `symbol` | 改为 `sourceKey`：`${exchange}:${symbol}`（3B4C2） |
| EventBus event | 无 exchange | `payload` 增加 `source: MarketSource`（3B4C2） |
| Pipeline input | `signal.symbol` | `signal` 增加 `exchange`（3B4C4） |
| 报告/日志 | canonical symbol | 所有日志带 `exchange` 前缀（3B4C4） |

### 3.3 必须修改的现有类型（本阶段不修改，仅标记）

- `src/data/types.ts` — `WsTicker` / `WsKline` 增加 `exchange?`
- `src/events/TradingEvent.ts` — 3 种 payload 增加 `source: MarketSource`
- `src/data/MarketSnapshot.ts` — `MarketSnapshot.symbol` → 语义改为 `sourceKey`，或新增 `source`
- `src/data/MarketSnapshotStore.ts` — `updateTicker` / `updateClosedKline` / `getSnapshot` 接受 `sourceKey`
- `src/data/CandleSeriesStore.ts` — `keyOf` 改为 `sourceKey`
- `src/runtime/trading/PlanAwareCollector.ts` — 不抹掉 `exchange`

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
- 一边更新 Universe **不重启**另一边（满足 §7）

### 5.5 restart 回滚

- 单交易所 restart 失败 → 该侧保持 `failed`，不影响另一侧
- 不允许故障交易所旧数据继续参与决策（Store 隔离 + 状态门控）

### 5.6 状态模型

```
type MultiExchangeRuntimeState =
  | 'stopped'
  | 'running'        // 全部健康
  | 'degraded'       // ≥1 健康，≥1 故障/未启动
  | 'failed';        // 全部故障

interface PerExchangeStatus {
  exchange: ExchangeId;
  state: 'running' | 'degraded' | 'failed' | 'stopped';
  planVersion: number | null;
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

## 7. Universe 设计（Universe Design）

| 要求 | 设计 |
|------|------|
| 每交易所独立 UniverseManager | ✅ 方案 B 每子 Runtime 独立 `universe` |
| 相同 canonical symbol 可同时存在 | ✅ `binance:BTC/USDT` 与 `bitget:BTC/USDT` 各自 Universe 独立 |
| exchangeSymbol 映射不跨交易所复用 | ⚠️ **阻断项**：当前 `SymbolFormat.registry.toExchange(symbol)` 默认返回 Bitget 映射（UniverseManager L185）；Binance 需要独立 `SymbolRegistry` 或 `toExchange(symbol, exchange)` 维度化 |
| planVersion 带 exchange 维度 | ⚠️ **阻断项**：当前 `SubscriptionPlan.version` 无 exchange（UniverseManager L13, L159）；需 `Map<ExchangeId, number>` 或 `PlanVersion = {exchange, version}` |
| 一边更新不重启另一边 | ✅ `applyUniversePlan(exchange)` 仅操作目标子 Runtime |

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
  readonly planVersion: number | null;
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

### 3B4C1 — exchange-aware market identity

**文件范围**：
- `src/data/types.ts`（WsTicker/WsKline + `exchange`）
- `src/runtime/trading/PlanAwareCollector.ts`（保留 `exchange` 透传）
- `src/data/bitget/*`、`src/data/binance/*`（Collector 输出打 `exchange`）

**不变量**：Collector 输出必带 `exchange`；PlanAwareCollector 不得抹掉 `exchange`

**测试要求**：Collector 输出含 `exchange`；PlanAwareCollector 透传 `exchange`

**回滚边界**：仅类型扩展，不影响单交易所行为（exchange 字段可选）

**禁止**：修改 TradingRuntime 生命周期；实现 CompositeCollector

---

### 3B4C2 — Store/EventBus source isolation

**文件范围**：
- `src/data/MarketSnapshotStore.ts`（`sourceKey` 替代 `symbol` key）
- `src/data/CandleSeriesStore.ts`（`keyOf` 改为 `sourceKey`）
- `src/events/TradingEvent.ts`（payload + `source: MarketSource`）
- `src/runtime/market/MarketDataRuntime.ts`（publish 时注入 `source`）

**不变量**：`binance:BTC/USDT` 与 `bitget:BTC/USDT` 写入不同 key，互不覆盖

**测试要求**：双交易所同 symbol 数据独立；EventBus 事件带 `exchange`

**回滚边界**：Store key 格式变更；需同步更新 FastPipeline 查询（3B4C4）

**禁止**：共享 Store 跨交易所；静默覆盖

---

### 3B4C3 — MultiExchangeRuntime coordinator

**文件范围**：
- `src/runtime/trading/MultiExchangeRuntime.ts`（新增）
- 复用 `createExchangeTradingRuntime`（3B4B）

**不变量**：`start` 允许 partial；`stop` 并行幂等；`applyUniversePlan(exchange)` 仅目标侧

**测试要求**：一交易所故障不影响另一；degraded 状态正确；stop 幂等

**回滚边界**：协调层独立；子 Runtime 不变

**禁止**：修改单交易所 Runtime；实现 CompositeCollector

---

### 3B4C4 — Pipeline/risk source propagation

**文件范围**：
- `src/pipeline/FastPipeline.ts`（`signal` + `exchange`；查询按 `sourceKey`）
- `src/router/ExecutionRouter.ts`（`route` / `SignalSource` + `exchange`）
- `src/router/KillSwitch.ts`（`check(exchange, symbol, positionUsd)`）

**不变量**：所有 signal 携带 `exchange`；风控识别来源；禁止跨交易所自动下单

**测试要求**：双交易所同 symbol 信号独立；KillSwitch 按来源记录

**回滚边界**：信号结构扩展；下单路由仍禁用

**禁止**：跨交易所自动下单；套利策略

---

### 3B4C5 — 离线双交易所集成测试

**文件范围**：
- `tests/runtime/trading/multi-exchange-runtime.test.ts`（新增）
- 复用 `FakeWSFactory` + `FakeScheduler`

**不变量**：双交易所并行运行；数据隔离；故障隔离；degraded 状态

**测试要求**：
- 两交易所同时 start，数据不串
- 一交易所 socket 故障，另一继续
- applyUniversePlan 逐交易所
- stop 幂等

**回滚边界**：纯测试，无生产代码

**禁止**：接私有 WS；读 API keys；账户/持仓/下单；套利

---

## 10. 阻断项与非阻断项（Blockers & Non-Blockers）

### 阻断项（Blockers — 必须在 3B4C1/2 解决）

1. **Store key 无 exchange 维度**（MarketSnapshotStore L120/L168, CandleSeriesStore L78）
   → 双交易所同 symbol 数据碰撞覆盖。必须先做 3B4C2。

2. **PlanAwareCollector 抹掉 exchangeSymbol**（PlanAwareCollector L66/L78）
   → 源标识在 Runtime 边界丢失。必须 3B4C1 保留透传。

3. **SymbolFormat 默认 Bitget 映射**（UniverseManager L185 `registry.toExchange`）
   → Binance Universe 会生成错误 exchangeSymbol。需 `toExchange(symbol, exchange)` 维度化。

4. **planVersion 无 exchange 维度**（UniverseManager L13/L159）
   → 双交易所 planVersion 无法区分。需 `PlanVersion = {exchange, version}` 或 `Map<ExchangeId, number>`。

### 非阻断项（Non-Blockers — 可延后）

1. **Pipeline 指标重复计算**（每交易所独立 Fast/Slow）
   → 初期可接受；后续可共享 IndicatorService（纯函数）。

2. **ExecutionRouter/KillSwitch 无 exchange 维度**
   → 3B4C4 扩展；初期若仅行情不下单，不影响运行。

3. **SlowPipeline 报告无 exchange 维度**
   → 初期研究报告按 canonical symbol；exchange-aware 研究报告后续阶段。

---

## 11. 边界遵守声明（Boundary Compliance）

- ✅ 不修改生产代码（本阶段仅文档）
- ✅ 不实现 CompositeCollector（方案 B 明确排除）
- ✅ 不接私有 WS / 账户 / API keys / 下单
- ✅ 不实现套利策略
- ✅ 不修改现有单交易所 Runtime 行为（3B4C3 仅新增协调层）
- ✅ 初期完全隔离，不聚合

---

*Generated for Stage 3B4C — Multi-Exchange Runtime Architecture Audit.*
*All code references verified against HEAD `5bf6c2ae4b5453fdb809097e6a630708136121e6`.*
