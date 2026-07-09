# CloddsBot 改造工程日志

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
- **src/router/PythonBridgeDaemon.ts** — TS ↔ Python 双向管道桥接器
  - correlationId 精确匹配 + 超时控制
  - panicMeltdown 熔断机制
  - 2s 硬超时守门
- **tests/pipeline.test.ts** — P0 联调断言验证脚本
- **quant_engine/requirements.txt** — pandas/numpy 依赖声明

## Phase 4.3 — JSON Bridge 协议标准化 ⏳ (规划中)
**目标**: 将临时协议固化为正式规范，强制 JSON Schema 校验。

## Phase 4.4 — Bridge Benchmark ⏳ (规划中)
**目标**: 量化管道性能边界。

**并发阈值检测（已修正）:**
```
并发 10：  P99 < 10ms（正常）
并发 50：  P99 < 30ms（警告线）
并发 100： P99 < 50ms（触发阈值）
并发 100+：P99 指数飙升 → 立即停止，进入 Phase 4.4b 进程池改造
```

**Phase 4.4b 自动触发条件（不等 Phase 10）:**
- 单管道吞吐在并发 50/100 时 P99 > 50ms
- 立即引入 `PythonBridgeDaemonPool.ts`（进程池轮询）
- 4/8 个 daemon.py 实例 + Round-Robin 分发
- 目标：1000 req/s 下 P99 < 50ms

## Phase 4.5 — 指标迁移批次 ⏳ (待开始)
**P0** ✅ (已内置 daemon.py)
- P1: STC / Stochastic / Mean Reversion / Trend Impulse ✅
  ⚠️ Volume Profile → 跳过 (等 Phase 5 Tick 数据层，议会裁决: skip_VP 3.5/3.5)
- P2: DeltaFlow Volume Profile / Elliott Wave / Fibonacci / S-R (需 Strict_Lag_Offset)
- P3: Comprehensive Toolkit / TradeIQ

## Phase 4.6 — 精度基准测试 ⏳ (待开始)
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

## Phase 5 — 统一数据层 ⏳ (待开始)
**⚠️ Feature Store 数据新鲜度修正（2026-07-05 审计修正）**
```
快路径（Fast Pipeline）：
  └─ Python 计算完 → 原子写 Feature Store 当前快照（不经过缓存 TTL）
  └─ 强制更新 store.last_updated = now()

慢路径（Slow Pipeline）：
  └─ 读取前检查：if (now - store.last_updated > 60s) → 告警，强制触发一次 Python 实时计算
  └─ 不经过 TTL 缓存，直接读最新快照

TTL 缓存只用于：历史归档数据（如 7 天前的指标）
```

## Phase 6 — 多 Agent 大脑 ⏳ (待开始)
## Phase 3b — 管线整合 ⏳ (等 P4+P6 完成后收尾)
## Phase 7 — Hermes Protocol ⏳ (待开始)
## Phase 8 — 执行层 ⏳ (待开始)
## Phase 9 — 性能优化 ⏳ (待开始)
## Phase 10 — 验证 ⏳ (待开始)

---
# Changelog

All notable changes to Clodds will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

### Added (Sprint 1)
- **IndicatorService**: FastPipeline 抽象层
- **E2E Test**: `tests/step-1-7-e2e.test.ts`

