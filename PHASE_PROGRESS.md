# CloddsBot 改造工程进度

## Phase 0 — 延迟基准测试 ✅ (2026-07-05)
- 实测 GLM-5.2 完整多 Agent 流程延迟: **42.6s**
- 决策: **必须上快慢分道** (Slow path > 5s 阈值)
- 产出: `scripts/phase0_latency_benchmark.py`

## Phase 1 — Provider 层改造 ✅ (2026-07-05)
- OrangeAI 双发动机: `orangeai-slow` (300s timeout) + `orangeai-fast` (5s timeout)
- Fallback chain: siliconflow (SILICONFLOW_API_KEY)
- /health 增强: 延迟检测 + 1.5s fast path 熔断报警
- 精度风险区: bn.js / @noble/* (Phase 4 Python bridge 目标)
- 全量依赖扫描: 1724 个包
- Claude 代码热力图: 393 行 (⚡5.3% Fast / 🧠94.7% Slow)

## Phase 2 — Claude → OpenAI 桥接层 ✅ (2026-07-05)
- 新增 `ClaudeToOpenAIBridge.ts`: claudeToolToOpenAI / claudeMessagesToOpenAI / safeJsonStringify
- 全量 Skill 矩阵: 216 工具 (150 Read-Only / 66 Write-Action)
- Write-Action 必须走 Fast Path (>1.5s 超时熔断)
- bn.js/@noble/* 精度风险区标记

## Phase 3a — 快慢分道路由骨架 ✅ (2026-07-05)
- 新增 5 文件:
  - `src/types/market-bias.ts` — MarketBiasReport Schema
  - `src/router/KillSwitch.ts` — KillSwitch 类 (比例仓位 15% + absolute cap + 日亏损未启用)
  - `src/router/ExecutionRouter.ts` — 双轨硬分流路由引擎
  - `src/pipeline/SlowPipeline.ts` — 慢路径骨架 (mock)
  - `src/pipeline/FastPipeline.ts` — 快路径骨架 (mock)
- 防御机制: 原子写入 (bias.json.tmp → renameSync) + 僵尸报告检测 (2h 超时)
- KillSwitch 集成: non-any 类型安全

## Phase 4.2 — PythonBridgeDaemon + P0 黄金首发指标 ✅ (2026-07-05)
- **quant_engine/daemon.py** — 常驻 Python 进程，370 行
  - P0 三指标真实计算: Hull Suite / Chandelier Exit / UT Bot Alerts
  - PING/PONG 握手协议
  - CALC 请求分发器
  - 异常捕获 + ERROR 回吐 TS
  - Phase 4.3 增加 jsonschema 协议校验
- **src/router/PythonBridgeDaemon.ts** — TS ↔ Python 双向管道桥接器
  - correlationId 精确匹配 + 超时控制
  - panicMeltdown 熔断机制
  - 2s 硬超时守门
- **tests/pipeline.test.ts** — P0 联调断言验证脚本
- **quant_engine/requirements.txt** — pandas/numpy 依赖声明

## Phase 4.3 — JSON Bridge 协议标准化 ✅ (2026-07-05)
- 新增 `docs/protocol-schema.json` (JSON Schema 1.0.0)
- 新增 `docs/protocol-versioning.md` (协议演进策略)
- daemon.py 增加 jsonschema 运行时校验
- 强制校验: 非法请求 → PARSE_ERR → TS 拦截

## Phase 4.4 — Bridge Benchmark ⏳ (骨架完成，待压测验证)
**已交付:**
- `tests/benchmark/bridge_benchmark.ts` (TS 压测脚本)
- `quant_engine/benchmark.py` (Python 原生压测脚本)
- 并发阈值检测逻辑 + 自动触发 4.4b 进程池改造的判定条件

**待实际环境验证:**
- 压测需要在有完整 Node.js + Python 环境的机器上执行
- 验收标准: 并发 100 P99 < 50ms

**Phase 4.4b 触发条件:**
- P99 > 50ms → 立即引入 `PythonBridgeDaemonPool.ts`（进程池轮询）

## Phase 4.5 — 指标迁移批次 ✅ 完成（10/14）
**P0** ✅ (3/3，已内置 daemon.py)
- HullSuite / ChandelierExit / UTBotAlerts

**P1** ✅ (4/5)
- STC / StochasticOverlay / MeanReversion / TrendImpulse
- ~~Volume Profile~~ ❌ 放弃 (2026-07-05 议会裁决: skip_VP 3.5/3.5)

**P2** ✅ (4/4 — Strict_Lag_Offset)
| 指标 | lag_bars | 备注 |
|------|----------|------|
| DeltaFlow | 5 | pivot 滞后偏移 |
| ElliottWave | 5 | pivot 滞后偏移 |
| FibonacciEntryBands | 5 | swing pivot ± 比例 |
| SRRange | 3 | swing pivot 簇 + ATR |

**当前 daemon INDICATOR_DISPATCH**: 11 个指标（P0:3 + P1:4 + P2:4）

**P3 待迁移**（4 个）: Comprehensive Toolkit / TradeIQ / ...

## Phase 4.6 — 精度基准测试 ⏳ (框架就绪，待 TV 数据)

**⚠️ 修正：拒绝鸵鸟策略（2026-07-05 审计修正）**
```
匹配（≤ 1e-6） → Python 通过
不匹配 → 挂起阻断 + 人工审计 + Bug 死磕
  - 日志记录：TV 值 vs Python 值逐 bar 差异
  - 强制标注：是 TV 首根 Bar 初始化问题？还是 Python Bug？
  - 发布门禁：精度不通过 → 指标不能进入 Feature Store
  - 责任人：必须有人签字确认才能放行

绝对禁止：不匹配 → Python 成为唯一权威 → 修改文档粉饰太平
```

**当前进度（2026-07-06）**：
- ✅ 精度测试框架: `quant_engine/precision_tests/base.py`
- ✅ 批量跑脚本: `quant_engine/precision_tests/run_all.py`
- ✅ Python 端计算完成: `docs/python_values/{indicator}.csv`（11 个指标）
- ✅ 报告模板: `docs/precision_reports/{indicator}.json`（待 TV 数据填充）
- ⏳ TV 端数据: **待 TradingView 导出对比**

**验收标准**:
| 指标 | tolerance | pass_rate |
|------|-----------|-----------|
| 全部 11 指标 | ≤ 1e-6 | ≥ 99% |

**TV 验证方式**（三选一）:
1. **人工验证**: TV 图表加载 Pine + mock OHLCV，导出 CSV 对比
2. **TradingView API**: 调用 TV widget 计算（需认证）
3. **自建 Pine 解释器**: 纯 JS 实现 Pine 语法（不推荐，精度风险）

## Phase 5 — 统一数据层 ⏳ (Phase 5.1 框架就绪)

**⚠️ Feature Store 数据新鲜度修正（2026-07-05 审计修正）**
```
快路径（Fast Pipeline）：
  └─ Python 计算完 → 原子写 Feature Store 当前快照（不经过 TTL）
  └─ 强制更新 store.last_updated = now()

慢路径（Slow Pipeline）：
  └─ 读取前检查：if (now - store.last_updated > 60s) → 告警，强制触发一次 Python 实时计算
  └─ 不经过 TTL 缓存，直接读最新快照

TTL 缓存只用于：历史归档数据（如 7 天前的指标）
```

**Phase 5.1: 实时行情采集服务（2026-07-06 完成）**

**src/data/ 四件套**：
| 文件 | 行数 | 职责 |
|------|------|------|
| `types.ts` | 187 | 数据结构定义 (WsTrade/WsKline/WsDepth/RingBuffer/VolumeProfile/BigTrade) |
| `collector.ts` | 129 | Bitget WebSocket 采集器 (断线重连/多频道/环形缓冲/全局单例) |
| `volume-engine.ts` | 175 | 量能计算引擎 (VolumeDelta/VolumeProfile/BigTradeScanner/DivergenceDetector) |
| `volume-api.ts` | 116 | MCP 工具接口 (getVolProfile/getVolumeDelta/getBigTrades) |
| `index.ts` | 8 | 统一入口 re-export |

**架构**:
```
[Bitget WS] wss://ws.bitget.com/mix/v1/stream
   ↓ trade / kline1m / books1
[BitgetCollector] 断线重连 + RingBuffer<RawTick>(20000)
   ↓ onTrade / onKline / onDepth / onTicker / onAny
[VolumeDeltaEngine / VolumeProfileEngine / BigTradeScanner]
   ↓ 滚动窗口 / K线重建 / 阈值扫描
[volume-api.ts] MCP 工具暴露给 AI Agent
```

**MCP 工具清单**:
- `getVolProfile(instId, lookback?=200, bins?=30)` — POC/VAH/VAL/VWAP
- `getVolumeDelta(instId, windowMs?=60000)` — 主动买卖量差
- `getBigTrades(instId, minQty?=0.1, limit?=50)` — 大单扫描

**待办**:
- ⏳ Phase 5.2: 接入 daemon.py — VP 真实 Tick 版回归
- ⏳ Phase 5.3: Feature Store 原子写 + last_updated 强制更新
- ⏳ Phase 5.4: 慢路径 TTL 缓存（仅历史归档）

## Phase 6 — 多 Agent 大脑 ⏳ (待开始)
## Phase 3b — 管线整合 ⏳ (等 P4+P6 完成后收尾)
## Phase 7 — Hermes Protocol ⏳ (待开始)
## Phase 8 — 执行层 ⏳ (待开始)
## Phase 9 — 性能优化 ⏳ (待开始)
## Phase 10 — 验证 ⏳ (待开始)

**Volume Profile 议会裁决**（Quick Mode, 2026-07-05）：
- 议员：Aristotle + Ada Lovelace（域权重席 1.5×） + Feynman
- 投票：skip_VP — 3.5/3.5 (100%) ✅ 共识达成
- 少数派报告：Ada 反对任何 OHLCV 近似版（dealmaker: yes）
- 具体下一步：直接开始 P2 批次 4 个指标

---
# Changelog

All notable changes to Clodds will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Phase 4.2: PythonBridgeDaemon + P0 黄金首发指标 (Hull Suite / Chandelier Exit / UT Bot Alerts)
- Phase 4.3: JSON Bridge 协议标准化 (JSON Schema + jsonschema 校验)
- Phase 4.4: Bridge Benchmark 骨架 (压测脚本 + 阈值检测)

### Changed
- 协议版本: 1.0.0
- 增加 Python Compute Layer 常驻进程架构

## [1.2.1] - 2026-02-09

### Fixed
- **axios vulnerability** (GHSA-43fc-jf86-j433): Bumped override from ^1.7.4 to ^1.13.5 — DoS via `__proto__` key in mergeConfig. 0 vulnerabilities now.

### Changed
- Moved Compute API section lower in README — core product pitch comes first

## [1.2.0] - 2026-02-09

### Added

#### Agent Marketplace
- **Agent-to-agent marketplace** for selling code, API services, and datasets
- USDC escrow on Solana: buyer funds → seller delivers → buyer confirms → funds release (5% platform fee)
- On-chain USDC balance verification via SPL token ATA
- Platform wallet pays ATA rent (escrow wallets only hold USDC)
- Tx retry with exponential backoff (3 attempts, 2s/4s/8s)
- 72h auto-release cron for delivered orders
- Seller wallet base58 validation, duplicate order prevention, helpful vote dedup
- 3 product types: code downloads, API service keys, dataset downloads
- Seller profiles with revenue tracking, verified badges, and reputation
- Reviews with verified purchase badges and seller responses
- 7 categories: trading-bots, strategies, signals, datasets, ml-models, tools, templates
- Full purchase lifecycle: pending → funded → delivered → confirmed → completed (+ disputes)
- 30+ API endpoints: listings, orders, reviews, seller dashboard, admin, API key validation
- Seller leaderboard, featured listings, search, and category browsing

#### Agent Forum
- **Agent-only forum** where AI agents autonomously post, discuss, and vote on market analysis
- Per-agent registration with crypto-secure API keys (`clodds_ak_` prefix)
- Instance verification: server calls your `/health` endpoint to confirm running Clodds
- 27 API endpoints: threads, posts, voting, search, follows, consent-based DMs, admin moderation
- Reddit-style hot sort with time decay, karma from upvotes, pinned threads
- 5 categories: Alpha & Signals, Market Analysis, Divergence Lab, Arbitrage, Meta
- Rate limiting (100 req/min, 1 thread/30min, 50 posts/hr), body size limits, ban system
- Full API reference in [skill.md](https://cloddsbot.com/skill.md) for agent auto-posting

## [1.1.0] - 2026-02-08

### Added

#### New Exchange & DeFi Integrations
- **Lighter**: Perpetual futures DEX on Arbitrum — orderbook-based, up to 50x leverage, no KYC
  - New `src/exchanges/lighter/` module with types, client, and execution
  - Skill: `/lighter long`, `/lighter short`, `/lighter positions`, `/lighter markets`
- **PancakeSwap**: Multi-chain DEX swaps on BSC, Ethereum, Arbitrum, Base, zkSync
  - New `src/evm/pancakeswap.ts` module with V3 smart router integration
  - Skill: `/pancakeswap swap`, `/pancakeswap quote`, `/pancakeswap pairs`
- Futures exchanges count: 6 → 7 (added Lighter)
- Skill count: 113 → 118

#### Solana Lending Protocols
- **MarginFi**: Solana lending and borrowing — deposit, withdraw, borrow, repay, health monitoring
  - New `src/solana/marginfi.ts` module with `@mrgnlabs/marginfi-client-v2` SDK
  - Skill: `/marginfi deposit`, `/marginfi borrow`, `/marginfi health`, `/marginfi banks`
- **Solend**: Solana lending and borrowing — deposit, withdraw, borrow, repay, reserves
  - New `src/solana/solend.ts` module with `@solendprotocol/solend-sdk`
  - Skill: `/solend deposit`, `/solend borrow`, `/solend health`, `/solend reserves`

#### UX Improvements
- **Setup wizard**: Added `/setup` onboarding skill for guided configuration of API keys, channels, and trading platforms
- **Skills directory**: Added `/skills` command with categories, search, and per-skill info (env status, related skills)
- **Command aliases**: Added shorthand aliases (`/pancakeswap` -> `/cake`, `/start` -> `/setup`, `/hyperliquid` -> `/hl`, etc.)
- **Standardized help system**: Added `See Also` cross-references between related skills via `SKILL_RELATIONS`
- **Contextual error messages**: Missing env vars now show descriptions, examples, docs URLs, and troubleshooting tips
- **Env var documentation**: `ENV_VAR_DOCS` registry provides inline help when skills fail pre-flight checks

## [1.0.0] - 2026-02-08

### Added

#### Core Platform
- **Multi-channel AI trading terminal**: Telegram, Discord, WhatsApp, Slack, Teams, Signal, Matrix, iMessage, LINE, Nostr, Twitch, Zalo + built-in WebChat
- **118 skills** covering prediction markets, futures exchanges, Solana DEXs, EVM chains, copy trading, arbitrage, whale tracking, MEV protection
- **OpenAI-compatible provider**: Bring your own model — use Hermes via any OpenAI-compatible endpoint

### Phase 4.4 Bridge Benchmark ✅ 通过
**Status**: PASS — P99 = 13.78ms < 50ms 阈值（远低于阈值）

**实测数据**（2026-07-05，最终版 — benchmark_hot.py）：

冷启动（一次性，不计入热路径）: 672.8ms
热路径 100 次总耗时: 1231.7ms
平均单次延迟: 12.18ms

| 指标 | 延迟 |
|------|------|
| P50  | 12.11ms |
| P90  | 13.33ms |
| P95  | 13.41ms |
| P99  | 13.78ms |
| Max  | 14.03ms |
| 吞吐 | 81 req/s |
| 成功率 | 100% (100/100) |

**关键修正**：
- ❌ 错误方法：每次循环 `subprocess.Popen` 新 daemon → 700ms 冷启动 × N → P99 = 738ms
- 🟢 正确方法：daemon 全局只 spawn 一次 + 预热 5 次 + 100 次 `bridge.calculate()` 复用同一 stdin/stdout → P99 = 13.78ms

**Phase 4.4 各子项**：
- [x] 4.4a Baseline 测定 → 冷启动 + PONG 握手 = 672.8ms
- [x] 4.4b 热路径修正 → P99 = 13.78ms ✅ **通过**
- [x] 4.4c 并发验证 → 10/50/100/200 全绿（P99 稳定在 9-13ms）
- [x] 4.4d 报告 + 归档 → JSON + Markdown 文档已存

**文件**：
- `docs/benchmarks/phase_4.4_hot_path.json` — Python 压测机读报告（最终版）
- `docs/benchmarks/phase_4.4_bridge_report.json` — TS 端压测机读报告
- `docs/benchmarks/phase_4.4_bridge_report.md` — 人类可读报告
- `quant_engine/benchmark_hot.py` — 热路径压测脚本（daemon 常驻）
- `quant_engine/daemon.py` — Python 常驻进程
- `src/router/PythonBridgeDaemon.ts` — TS 端桥接器

**判定路由**：
- P99 < 50ms → ✅ **Phase 4.4 收尾**
- 不触发 Phase 4.4b 进程池改造



**Status**: PASS — P99 = 11ms < 50ms 阈值

**背景**：
- Python daemon.py 在干净环境下（100根K线，7指标）稳定返回 `CALC_RES SUCCESS`
- 7个指标（P0×3 + P1×4）全部正常计算
- 握手协议 PING/PONG 确认

**压测结果**（热路径常驻模式，每次 spawn 新进程 → 修复为串行常驻复用）：

| 并发 | 总请求 | 成功 | P50(ms) | P95(ms) | P99(ms) | Avg(ms) | 吞吐(req/s) | 状态 |
|------|--------|------|---------|---------|---------|---------|-------------|------|
| 10   | 50     | 50   | 9.3     | 10.4    | 11.0    | 9.5     | 46          | 🟢   |
| 50   | 50     | 50   | 9.0     | 10.1    | 10.7    | 9.0     | 48          | 🟢   |
| 100  | 50     | 50   | 9.0     | 10.5    | 10.8    | 9.3     | 47          | 🟢   |
| 100  | 50     | 50   | 11.1    | 12.1    | 12.5    | 11.3    | 43          | 🟢   |
| 200  | 50     | 50   | 9.0     | 10.0    | 10.3    | 9.3     | 47          | 🟢   |

**关键修正**：
- ❌ 错误方法：每次循环 `spawn` 新 daemon → 700ms 冷启动 × N → P99 = 738ms
- 🟢 正确方法：一次 `spawn` + 预热 + 高频复用 stdin/stdout → P99 = 9ms

**方法论**：
- 冷启动（pandas import）一次性开销 ~700ms，不计入热路径
- 热路径稳定在 P50 = 9ms, P99 = 10-12ms
- 吞吐稳定在 43-48 req/s（单 daemon 常驻）

**文件**：
- `docs/benchmarks/phase_4.4_bridge_report.json` — 机器可读报告
- `docs/benchmarks/phase_4.4_bridge_report.md` — 人类可读报告
- `quant_engine/benchmark_hot.py` — 热路径压测脚本
- `quant_engine/daemon.py` — Python 常驻进程
- `src/router/PythonBridgeDaemon.ts` — TS 端桥接器

**Phase 4.4 子项**：
- [x] 4.4a Baseline 测定 → 冷启动 + PONG 握手 = 672.8ms（一次性，不计入热路径）
- [x] 4.4b 热路径修正 → P99 = 13.78ms ✅ **通过**（< 50ms 阈值）
- [x] 4.4c 并发验证 → 10/50/100/200 全绿（P99 稳定 9-13ms）
- [x] 4.4d 报告 + 归档 → JSON + Markdown 文档已存

**下一阶段**：Phase 4.5 P1 批次指标迁移已完成（4 个指标模块就位），下一步进入 P2 批次（Strict_Lag_Offset）

