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
- **src/router/PythonBridgeDaemon.ts** — TS ↔ Python 双向管道桥接器
  - correlationId 精确匹配 + 超时控制
  - panicMeltdown 熔断机制
  - 2s 硬超时守门
- **tests/pipeline.test.ts** — P0 联调断言验证脚本
- **quant_engine/requirements.txt** — pandas/numpy 依赖声明

---

## 待完成

### Phase 4.3 — JSON Bridge 协议标准化 (等待 4.2 验证后)
### Phase 4.4 — Bridge Benchmark (延迟/并发/内存/崩溃恢复)
**⚠️ 并发阈值检测（已修正）：**
```
并发 10：  P99 < 10ms（正常）
并发 50：  P99 < 30ms（警告线）
并发 100： P99 < 50ms（触发阈值）
并发 100+：P99 指数飙升 → 立即停止，进入 Phase 4.4b 进程池改造
```
**Phase 4.4b 自动触发条件（不等 Phase 10）：**
- 单管道吞吐在并发 50/100 时 P99 > 50ms
- 立即引入 `PythonBridgeDaemonPool.ts`（进程池轮询）
- 4/8 个 daemon.py 实例 + Round-Robin 分发
- 目标：1000 req/s 下 P99 < 50ms

### Phase 4.5 — 指标迁移批次
- P0 ✅ (已内置 daemon.py)
- P1: STC / Stochastic / Mean Reversion / Trend Impulse / Volume Profile
- P2: DeltaFlow Volume Profile / Elliott Wave / Fibonacci / S-R (需 Strict_Lag_Offset)
- P3: Comprehensive Toolkit / TradeIQ

### Phase 4.6 — 精度基准测试 (TradingView 对比, ≤ 1e-6)
**⚠️ 修正：拒绝鸵鸟策略（已修正）**
```
匹配（≤ 1e-6） → Python 通过
不匹配 → 挂起阻断 + 人工审计 + Bug 死磕
  - 日志记录：TV 值 vs Python 值逐 bar 差异
  - 强制标注：TV 首根 Bar 初始化问题？还是 Python Bug？
  - 发布门禁：精度不通过 → 指标不能进入 Feature Store
  - 责任人：必须有人签字确认才能放行
绝对禁止：不匹配 → Python 成为唯一权威 → 修改文档粉饰太平
```

### Phase 5 — 统一数据层 (WebSocket + REST + Cache + Replay)
**⚠️ Feature Store 数据新鲜度修正（已修正）：**
```
快路径（Fast Pipeline）：
  └─ Python 计算完 → 原子写 Feature Store 当前快照（不经过缓存 TTL）
  └─ 强制更新 store.last_updated = now()

慢路径（Slow Pipeline）：
  └─ 读取前检查：if (now - store.last_updated > 60s) → 告警，强制触发一次 Python 实时计算
  └─ 不经过 TTL 缓存，直接读最新快照

TTL 缓存只用于：历史归档数据（如 7 天前的指标）
```

### Phase 6 — 多 Agent 大脑 (LangGraph: Research → Bull → Bear → Manager → Risk → PM)
### Phase 3b — 管线整合 (替换所有 mock, 接真实数据)
### Phase 7 — Hermes Protocol (Health + Lifecycle + Failure Detection)
### Phase 8 — 执行层 (Exchange Adapters + Broker Abstraction + 人工审批)
### Phase 9 — 性能优化 (Prompt / Context / Serialization / Token 优化)
### Phase 10 — 验证 (Replay Engine + Shadow Trading + 7天连续跑 + 压力测试)
