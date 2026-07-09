# Phase 3: 快慢分道架构 — 实现计划

> **状态**: 设计完成，待实施
> **优先级**: P0 (Phase 0 延迟基准已验证 P99=40s >> 5s 阈值)
> **作者**: Jewel (GLM-5.2) + Council
> **创建**: 2026-07-06
> **预估工期**: 3 天

---

## 1. 背景与决策依据

### 1.1 Phase 0 实测数据
- 4 Analyst 并发 P50=14.62s
- 1 轮 Debate P50=13.05s
- Research Manager P50=12.38s
- **总耗时 P99=40.05s** (单次实测, 50 次采样待补)

### 1.2 阈值决策
| 阈值 | 实测 | 结论 |
|------|------|------|
| 5s (人工可接受) | 40.05s | ❌ FAIL — 必须分道 |
| 2s (快道路标) | N/A (Python 实测 13.78ms) | ✅ PASS — Python 指标可承担 |
| 60s (慢道周期) | 40.05s + 20s 缓冲 | ✅ PASS — 留足 LLM 抖动余量 |

### 1.3 核心约束
1. **快道零阻塞**: 13ms 周期内严禁任何网络/LLM 调用
2. **bias 单向注入**: 慢道 → 快道，单向数据流，快道只读快照
3. **复合指标脱水**: Indicator 13/14 在快道用纯数学模式，禁调 LLM
4. **状态机报复**: LLM 失败时快道进入 DEGRADED 而非崩溃

---

## 2. 总体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CloddsBot Phase 3                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  慢道 SlowPipeline (Cron 周期 60s)                          │  │
│  │                                                              │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │ Step 1: 4 Analyst 并发 (Bull/Bear/Sentiment/Macro)   │   │  │
│  │  │ Step 2: Bull ↔ Bear Debate                           │   │  │
│  │  │ Step 3: Manager 出 MarketBiasReport                  │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                                                              │  │
│  │  Step 4: BiasCacheStore.atomic_write(report)                │  │
│  │           └──► 内存原子引用替换 (无锁)                      │  │
│  │                                                              │  │
│  │  Step 5: 失败重试 + 指数退避 + DEGRADED 降级               │  │
│  └────────────────────────────────┬────────────────────────────┘  │
│                                   ↓                                 │
│                       ┌───────────────────────┐                     │
│                       │ BiasCacheStore       │ (内存单例)          │
│                       │ ───────────────      │                     │
│                       │ report: AtomicRef   │ ← 慢道 atomic write │
│                       │ last_update: int     │                     │
│                       │ expiry_ms: int       │                     │
│                       └───────────┬───────────┘                     │
│                                   ↓ snapshot()                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  快道 FastPipeline (Tick 驱动, 周期 ~13ms)                 │  │
│  │                                                              │  │
│  │  Step 1: bias = BiasCacheStore.snapshot()  ~50µs            │  │
│  │          (检查 expiry_ts；过期则用上次有效值 + DEGRADED)    │  │
│  │                                                              │  │
│  │  Step 2: 执行 14 个 Python 指标                             │  │
│  │          P0 (3): HullSuite / ChandelierExit / UTBotAlerts  │  │
│  │          P1 (4): STC / Stochastic / MeanRev / TrendImpulse  │  │
│  │          P2 (5): ElliottWave / Fibonacci / SRRange /        │  │
│  │                  DeltaFlow / VolumeProfile                   │  │
│  │          P3 (2): CompositeMomentum ◄── bias.regime_state 注入│  │
│  │                  SmartOrderBlock   ◄── bias + VP VAH/VAL    │  │
│  │                                                              │  │
│  │  Step 3: DecisionEngine 综合 14 指标 + bias 出决策          │  │
│  │                                                              │  │
│  │  Step 4: 触发 ExecutionRouter (非 HOLD 时)                 │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 系统级 5 态状态机

### 3.1 状态定义

```
ACTIVE     — 正常运行, 慢道按时刷新, 快道正常计算
COOLDOWN   — 短期降速 (连续亏损 / 高波动 /DEX 异常), 拒绝开新仓
HALTED     — 长期降级 (API 限流升级 / KillSwitch 触发), 全停
DEGRADED   — 慢道失效 (LLM 故障 / 网络 timeout), 快道用 stale bias 跑
BACKTEST   — 回测模式, 不发实盘单, 全链路 dry-run
```

### 3.2 状态转迁图

```
                    ┌─────────────┐
                    │  BACKTEST   │ ◄─── 用户手动切换
                    └──────┬──────┘
                           │ 切回实盘
                           ↓
                    ┌─────────────┐
        ┌───────────│   ACTIVE     │───────────┐
        │           └──────┬──────┘            │
        │ LLM 故障         │ 连亏 3 笔         │ API 限流
        │ (慢道 timeout)   │ (单日 PnL < -3%) │ (>50% 429)
        ↓                  ↓                    ↓
   ┌───────────┐    ┌─────────────┐    ┌─────────────┐
   │ DEGRADED  │    │  COOLDOWN   │    │   HALTED    │
   └─────┬─────┘    └──────┬──────┘    └──────┬──────┘
         │ 慢道恢复        │ 60s 计时器        │ 用户手动恢复
         └────────────────┘                  │
                                                   ↓
                                           ┌─────────────┐
                                           │   ACTIVE     │
                                           └─────────────┘
```

### 3.3 转迁条件表

| From → To | 触发条件 | 动作 |
|-----------|---------|------|
| ACTIVE → COOLDOWN | 连亏 3 笔 \| PnL < -3% \| 高波动 | 拒新仓 60s, 持仓保留 |
| ACTIVE → DEGRADED | 慢道 LLM 失败 \| bias 过期 > 5min | 用 stale bias 跑, 告警 |
| ACTIVE → HALTED | API 限流 > 50% (429) \| KillSwitch 触发 | 全停, 等待用户恢复 |
| COOLDOWN → ACTIVE | 60s 计时到 + 无连亏信号 | 恢复正常 |
| DEGRADED → ACTIVE | 慢道 LLM 恢复 (健康检查通过) | 拉新 bias, 清 stale |
| HALTED → ACTIVE | 用户手动恢复 + 健康检查 | 全链路重启 |
| 任何 → BACKTEST | 用户手动切换 | 不发实盘单 |
| BACKTEST → ACTIVE | 用户手动切回 | 恢实盘 |

---

## 4. 核心数据结构

### 4.1 MarketBiasReport (慢道产物)

```typescript
interface MarketBiasReport {
  regime_state: RegimeState;
  confidence: number;        // 0~100
  bias_score: number;        // -1.0 ~ +1.0
  expiry_ms: number;         // 有效期absolute timestamp (ms)
  generated_at: number;      // 生成时间 (ms)
  stop_loss?: number;        // 价格
  take_profit?: number;      // 价格
  rationale: string;         // 综合理由
  bull_bear_consensus: string; // 共识点
  divergence: string;        // 分歧点
}

type RegimeState = 
  | "STRONG_BULLISH"
  | "WEAK_BULLISH"
  | "NEUTRAL"
  | "WEAK_BEARISH"
  | "STRONG_BEARISH";
```

### 4.2 SystemState (系统状态机)

```typescript
type SystemState = 
  | "ACTIVE"
  | "COOLDOWN"
  | "HALTED"
  | "DEGRADED"
  | "BACKTEST";

interface SystemStateContext {
  current: SystemState;
  entered_at: number;
  reason: string;
  cooldown_until?: number;
  degraded_due_to?: string;
}
```

### 4.3 BiasCacheStore (内存单例, 跨进程共享)

```typescript
class BiasCacheStore {
  private report: MarketBiasReport | null = null;
  private last_update_ms: number = 0;
  private expiry_ms: number = 60_000; // 默认 60s
  
  // 慢道调用: 原子替换 (无锁, 引用切换)
  atomic_write(report: MarketBiasReport): void;
  
  // 快道调用: 读快照 (零阻塞)
  snapshot(): BiasSnapshot;
  
  // 健康检查 (慢道调用)
  is_stale(max_age_ms: number): boolean;
}

interface BiasSnapshot {
  report: MarketBiasReport | null;
  is_stale: boolean;
  age_ms: number;
}
```

### 4.4 FastPipelineContext (快道上下文)

```python
@dataclass
class FastPipelineContext:
    """快道一次 Tick 的上下文"""
    bias: BiasSnapshot           # 慢道注入的快照
    system_state: SystemState     # 系统状态
   ohlcv_df: pd.DataFrame        # K线数据 (300 bars)
    ticks: List[Dict]            # 当前 bar 逐笔数据
    indicator_results: Dict       # 14 指标结果
    final_decision: Decision       # 最终决策
    timestamp: int                # ms
```

---

## 5. 慢道详细设计

### 5.1 SlowPipeline 序列图

```
[Cron 60s 触发]
       │
       ↓
[Step 1] 4 Analyst 并发调用 (ThreadPoolExecutor, max_workers=4)
       │  timeout=30s, 失败重试 2 次, 指数退避
       ↓
[Step 2] Bull ↔ Bear Debate (串行)
       │  timeout=20s
       ↓
[Step 3] Manager 出 MarketBiasReport (串行)
       │  timeout=20s, 输出必须 JSON 解析通过
       ↓
[Step 4] BiasCacheStore.atomic_write(report)
       │  原子引用替换, 无锁
       ↓
[Step 5] 写 SlowPipeline Audit Log
       │  含 token 用量 / 延迟 / 错误码
```

### 5.2 容错与降级

| 场景 | 行为 |
|------|------|
| 4 Analyst 任一失败 | 重试 2 次, 仍失败该 Analyst 用 "N/A" 占位 |
| Debate 失败 | 跳过 Debate, Manager 直接用 4 Analyst 报告 |
| Manager 失败 | 整轮 SlowPipeline 跳过, bias 保持旧值 (stale) |
| Manager 输出非 JSON | 重试 1 次, 仍失败用 fallback_parser 抽取 |
| 慢道总超时 (>90s) | 写 audit log, 触发 DEGRADED 状态 |

### 5.3 Cron 调度

```yaml
slow_pipeline_schedule:
  interval: 60s
  jitter: 5s                # 防止多实例同步触发
  timeout: 90s              # 硬超时
  retry:
    max_attempts: 2
    backoff: exponential
    initial_delay: 5s
```

---

## 6. 快道详细设计

### 6.1 FastPipeline 时序 (单次 Tick)

```
[Tick 信号到达]
       │
       ↓
[Step 1] BiasCacheStore.snapshot()        ~50µs
       │  读内存原子引用 + 检查 expiry
       ↓
[Step 2] 系统状态检查                       ~10µs
       │  HALTED/BACKTEST 即返回 HOLD
       ↓
[Step 3] 14 指标并行/串行计算              ~12ms
       │  P0 (3): 内置 daemon
       │  P1 (4): STC/Stoch/MeanRev/TrendImpulse
       │  P2 (5): Elliott/Fib/SR/Delta/VP
       │  P3 (2): CompositeMomentum ◄── 注入 bias.regime_state
       │          SmartOrderBlock   ◄── 注入 bias + VP
       ↓
[Step 4] DecisionEngine 综合判断            ~500µs
       │  14 指标多数投票 + bias 调整
       ↓
[Step 5] 触发 ExecutionRouter              ~100µs
       │  非 HOLD 时进入风控→下单
       │
       ↓ (total ~13.78ms)
```

### 6.2 关键代码约束 (写入 IMPLEMENTATION规约)

**严禁清单**:
- ❌ `requests.post()`, `aiohttp`, `httpx` 等任何网络库
- ❌ `subprocess` 调用 daemon.py 之外的外部进程
- ❌ `open()` 写文件 (除审计日志外, 且用 async)
- ❌ `time.sleep()` 阻塞 > 1ms
- ❌ Indicator 13/14 调用 LLM API

**允许清单**:
- ✅ `pandas` / `numpy` 计算库
- ✅ `BiasCacheStore.snapshot()` 内存读取
- ✅ 已收盘的 OHLCV DataFrame
- ✅ Tick 切片 (内存中)
- ✅ Feature Store 同步写入 (Phase 5 引入)

### 6.3 Indicator 13/14 脱水模式设计

Indicator 13/14 当前接收 `regime_state` 参数, 在 Phase 3 改造为:

```python
# 慢道调用模式 (LLM 介入) ← 已被禁用
result = CompositeMomentum.calculate(df, {
    "regime_state": "STRONG_BULLISH"  # 来自 LLM Manager
})

# 快道调用模式 (纯数学) ← Phase 3 默认
result = CompositeMomentum.calculate(df, {
    "regime_state": bias_snapshot.report.regime_state,  # 从 bias 注入
    "fast_mode": True  # 标记: 禁用 fallback_LLM 路径
})
```

`fast_mode=True` 时:
- 不调用 LLM
- regime_state 必须从 params 传入
- 如 bias_snapshot.is_stale, regime_state 用 "NEUTRAL" fallback
- 内部状态机照常运转 (只用 params + 历史)

### 6.4 FastPipeline Tick 触发机制

```
触发源: Bitget WebSocket Tick 流 (Phase 5 整合前 mock)
触发频率: 1 次 / 100ms (节流后)
节流策略:
  if last_run_age < 13ms: skip  # 防止过快
  if last_run_age > 200ms: force_run  # 防止过慢
```

---

## 7. 接口规约

### 7.1 SlowPipeline 接口

```typescript
class SlowPipeline {
  // 主入口: 由 Cron 调用
  async run_once(): Promise<MarketBiasReport>;
  
  // 健康检查
  async health_check(): Promise<{
    healthy: boolean;
    last_success_at: number;
    last_error?: string;
  }>;
}
```

### 7.2 FastPipeline 接口

```python
class FastPipeline:
    def __init__(self, bias_store: BiasCacheStore, state_ctx: SystemStateContext):
        ...
    
    def run_tick(self, df: pd.DataFrame, ticks: List[Dict]) -> FastPipelineResult:
        """
        单次 Tick 执行, 必须在 20ms 内完成
        返回: FastPipelineResult { decision, indicators, bias_used, timing_ms }
        """
```

### 7.3 BiasCacheStore 接口

```python
class BiasCacheStore:
    _instance: ClassVar[Optional["BiasCacheStore"]] = None
    _report: MarketBiasReport | None
    _last_update_ms: int
    _expiry_ms: int = 60_000
    
    @classmethod
    def instance(cls) -> "BiasCacheStore":
        """单例"""
    
    def atomic_write(self, report: MarketBiasReport) -> None:
        """慢道: 原子替换引用"""
    
    def snapshot(self) -> BiasSnapshot:
        """快道: 读引用 + 检查过期, 返回 is_stale 标志"""
    
    def is_stale(self, max_age_ms: int = 60_000) -> bool:
        """健康检查用"""
```

---

## 8. 跨语言桥接 (Python ↔ TypeScript)

### 8.1 现状
- daemon.py 已存在 (Phase 4)
- PythonBridgeDaemon.ts 已就位 (Phase 4.2)
- INDICATOR_DISPATCH (14 指标) 已注册

### 8.2 Phase 3 改造点

**daemon.py 新增 `handle_route` 命令**:
```python
# 14 个指标路由 (统一入口)
def handle_route(req: Dict) -> Dict:
    indicator_name = req["indicator"]
    df = pd.DataFrame(req["df"])
    params = req["params"]
    
    # 关键: bias 从 BiasCacheStore 注入, 不调 LLM
    if "regime_state" not in params:
        bias = BiasCacheStore.instance().snapshot()
        params["regime_state"] = (
            bias.report.regime_state if bias.report and not bias.is_stale
            else "NEUTRAL"  # stale fallback
        )
    
    fn = INDICATOR_DISPATCH.get(indicator_name)
    if not fn:
        return {"error": f"unknown indicator: {indicator_name}"}
    return fn(df, params)
```

**新增 `handle_system_state` 命令**:
```python
def handle_system_state(req: Dict) -> Dict:
    """返回当前系统状态 + bias 快照"""
    bias = BiasCacheStore.instance().snapshot()
    state = SystemStateContext.current()
    return {
        "system_state": state.current,
        "bias": bias.__dict__,
        "cooldown_remaining_ms": state.cooldown_until - now() if state.cooldown_until else 0
    }
```

### 8.3 协议格式保持 Phase 4.3 一致

```
[PythonBridgeDaemon.ts] ──stdin JSON──► daemon.py
                            ◄──stdout JSON──
                            单行协议, correlationId 匹配, 2s 硬熔断
```

---

## 9. 实施步骤 (3 天拆解)

### Day 1: 核心数据结构 + 状态机

| 任务 | 文件 | 验收 |
|------|------|------|
| 9.1 MarketBiasReport schema | `src/types/MarketBiasReport.ts` | tsc + JSON schema validate |
| 9.2 SystemStateContext 状态机 | `src/state/SystemState.ts` | 5 态转迁单测全过 |
| 9.3 BiasCacheStore 内存单例 | `src/cache/BiasCacheStore.ts` | atomic_write 后 snapshot 立即可读 |
| 9.4 Python 镜像 | `quant_engine/state/*` | mirror TS 类型 |

### Day 2: SlowPipeline 改造

| 任务 | 文件 | 验收 |
|------|------|------|
| 10.1 LLM 调用序列化 | `src/pipeline/SlowPipeline.ts` 改 | 4 Analyst 并发 → Debate → Manager |
| 10.2 atomic_write 集成 | SlowPipeline 末尾 | atomic_write 调用 + audit log |
| 10.3 失败重试 + 降级 | 各步骤异常处理 | LLM 失败 → 不挂快道, bias stale |
| 10.4 Cron 调度接入 | `src/cron/SlowPipelineCron.ts` | 60s 间隔 + 5s jitter + 90s 硬超时 |

### Day 3: FastPipeline 改造 + Indicator 13/14 脱水

| 任务 | 文件 | 验收 |
|------|------|------|
| 11.1 FastPipeline Tick 入口 | `src/pipeline/FastPipeline.ts` 改 | snapshot → 指标 → 决策 |
| 11.2 IndicatorManager 调度 | `src/indicators/IndicatorManager.ts` 新 | 14 指标统一调用 |
| 11.3 indicator 13/14 fast_mode | `quant_engine/indicators/composite_momentum.py` 等 | fast_mode=True 不调 LLM |
| 11.4 DecisionEngine 综合 | `src/engine/DecisionEngine.ts` 新 | 14 指标 + bias 投票 |
| 11.5 End-to-end 集成测试 | `tests/phase3_e2e.test.ts` | bias 注入 + 13ms 周期达标 |

---

## 10. 测试方案

### 10.1 单元测试

| 测试 | 目标 |
|------|------|
| test_bias_cache_store.py | atomic_write 后并发 snapshot 无竞态 |
| test_system_state.ts | 5 态转迁全覆盖 + 边界条件 |
| test_indicator_fast_mode.py | 13/14 在 fast_mode=True 时纯数学运行 |
| test_decision_engine.ts | 14 指标决策边界 (5 BUY / 5 SELL / 4 NEUTRAL) |

### 10.2 集成测试

| 测试 | 目标 |
|------|------|
| test_slow_pipeline_e2e.ts | 一次完整慢道循环产出有效 MarketBiasReport |
| test_fast_pipeline_tick.ts | 单次快道 Tick < 20ms 达标 |
| test_bias_injection.ts | bias 注入 → 13/14 regime_state 字段一致 |

### 10.3 压力测试

| 测试 | 目标 |
|------|------|
| test_fast_pipeline_1000_ticks.ts | 1000 次快道 Tick P99 < 20ms |
| test_slow_pipeline_stall.ts | 模拟 LLM 故障 → DEGRADED 转迁 |
| test_state_machine_churn.ts | 状态频繁切换不丢 bias |

---

## 11. 监控与可观测性

### 11.1 关键指标

```
slow_pipeline_cycle_s (P50/P95/P99)  — 慢道周期, 期望 <60s
slow_pipeline_failure_rate           — 失败率, 期望 <5%
fast_pipeline_tick_ms (P99)          — 快道 Tick, 期望 <20ms
bias_age_ms                          — bias 新鲜度, 期望 <60s
system_state_transitions             — 状态机切换频率
degraded_duration_ms                 — DEGRADED 持续时长
```

### 11.2 告警规则

```
slow_pipeline_failure_rate > 10% (5min) → 告警
fast_pipeline_tick_ms P99 > 50ms (1min) → 告警
bias_age_ms > 300s (5min) → DEGRADED 自动转迁
system_state == HALTED → 立即告警 (人工介入)
```

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 快道 Python ↔ TS 桥接开销超 13ms 预算 | 长连接 daemon (Phase 4.2 已就位), 单次 RPC <1ms |
| 跨进程 BiasCacheStore 一致性 | 进程内单例, 慢道写入是原子引用替换, 快道读快照是常量复制 |
| LLM API 限流升级 | DEGRADED + HALTED 双层防护, 限流 > 50% 转 HALTED |
| Indicator 13/14 fast_mode 漏写代码 | 单元测试断言不调 LLM (mock 检测网络调用次数 = 0) |
| 50 次压测未补 → 阈值不稳定 | Phase 0 数据已 1 次实测, 阈值 5s vs 40s 差 8 倍, 容差充足 |

---

## 13. 完成验收清单

- [ ] BiasCacheStore 单测全过 (atomic + zero-copy 读)
- [ ] SystemState 5 态转迁单测全过
- [ ] SlowPipeline "run_once" 端到端产出有效 MarketBiasReport
- [ ] SlowPipeline 失败降级: LLM timeout 不挂快道
- [ ] FastPipeline Tick P99 < 20ms (1000 次采样)
- [ ] Indicator 13/14 fast_mode 单测确认零 LLM 调用
- [ ] Indicator 13 regime_state 字段正确接收 bias 注入
- [ ] Indicator 14 phase3_bridge_signal 正确联动
- [ ] DecisionEngine 综合 14 指标 + bias 出决策
- [ ] 状态机 DEGRADED 自动转迁 + 恢复测试
- [ ] Cron 60s 调度稳定运行 24h
- [ ] 审计日志完整 (SlowPipeline / FastPipeline / State)
- [ ] 文档更新: PHASE_PROGRESS.md Phase 3 完成

---

## 14. 状态机伪代码 (实现参考)

```python
# quant_engine/state/system_state.py

from dataclasses import dataclass, field
from enum import Enum
import time

class SystemState(Enum):
    ACTIVE = "ACTIVE"
    COOLDOWN = "COOLDOWN"
    HALTED = "HALTED"
    DEGRADED = "DEGRADED"
    BACKTEST = "BACKTEST"

@dataclass
class SystemStateContext:
    current: SystemState = SystemState.ACTIVE
    entered_at: int = 0
    reason: str = ""
    cooldown_until: int = 0
    degraded_due_to: str = ""
    conloss_count: int = 0
    daily_pnl_pct: float = 0.0
    api_429_rate: float = 0.0
    
    def transition(self, to: SystemState, reason: str = ""):
        old = self.current
        self.current = to
        self.entered_at = int(time.time() * 1000)
        self.reason = reason
        if to == SystemState.COOLDOWN:
            self.cooldown_until = self.entered_at + 60_000
        elif to == SystemState.DEGRADED:
            self.degraded_due_to = reason
        # 审计日志
        log_state_transition(old, to, reason)
    
    def tick(self, bias_snapshot):
        """每个快道 Tick 调用一次, 评估是否需要转迁"""
        if self.current == SystemState.HALTED:
            return  # 等待用户手动恢复
        if self.current == SystemState.BACKTEST:
            return  # 用户主动切换
        
        if self.current == SystemState.ACTIVE:
            # 检查降级触发
            if bias_snapshot.is_stale and bias_snapshot.age_ms > 300_000:
                self.transition(SystemState.DEGRADED, "bias stale > 5min")
            elif self.conloss_count >= 3 or self.daily_pnl_pct < -0.03:
                self.transition(SystemState.COOLDOWN, "conloss/PnL trigger")
            elif self.api_429_rate > 0.5:
                self.transition(SystemState.HALTED, "API 429 rate > 50%")
        
        elif self.current == SystemState.COOLDOWN:
            if int(time.time()*1000) >= self.cooldown_until:
                if self.conloss_count < 3 and self.daily_pnl_pct > -0.03:
                    self.transition(SystemState.ACTIVE, "cooldown elapsed, signals clear")
        
        elif self.current == SystemState.DEGRADED:
            if not bias_snapshot.is_stale:
                self.transition(SystemState.ACTIVE, "bias refreshed")
```

---

## 15. BiasCacheStore 伪代码

```python
# quant_engine/cache/bias_cache_store.py

import threading, time
from dataclasses import dataclass
from typing import Optional
from quant_engine.types import MarketBiasReport

@dataclass
class BiasSnapshot:
    report: Optional[MarketBiasReport]
    is_stale: bool
    age_ms: int

class BiasCacheStore:
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self):
        self._report: Optional[MarketBiasReport] = None
        self._last_update_ms: int = 0
        self._expiry_ms: int = 60_000  # 默认 60s
    
    @classmethod
    def instance(cls) -> "BiasCacheStore":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance
    
    def atomic_write(self, report: MarketBiasReport) -> None:
        """慢道调用: 原子替换引用 (Python GIL 保证指针赋值原子)"""
        self._report = report
        self._last_update_ms = int(time.time() * 1000)
    
    def snapshot(self) -> BiasSnapshot:
        """快道调用: 零阻塞读取快照"""
        now_ms = int(time.time() * 1000)
        age = now_ms - self._last_update_ms
        is_stale = age > self._expiry_ms
        # 返回快照对象 (浅拷贝引用), 快道拿到的是常量
        return BiasSnapshot(
            report=self._report,
            is_stale=is_stale,
            age_ms=age,
        )
    
    def is_stale(self, max_age_ms: int = 60_000) -> bool:
        return (int(time.time()*1000) - self._last_update_ms) > max_age_ms
```

---

## 16. 启动顺序与依赖

```
1. BiasCacheStore 单例初始化 (空)
2. SystemStateContext 进入 ACTIVE
3. daemon.py 启动 (Python 进程, IPC server 就位)
4. SlowPipeline Cron 启动 (60s 第一次执行)
5. FastPipeline Tick 监听启动 (Bitget WebSocket / mock)
6. ExecutionRouter 启动 (待命)
7. KillSwitch 启动 (监控中)
```

启动后 0~60s 内 SlowPipeline 第一次跑完前, FastPipeline 用 `bias=None, is_stale=True` 跑, state 会立即转 DEGRADED → 等 SlowPipeline 出料后回 ACTIVE。

---

## 17. 文件清单 (待创建/修改)

### 待创建
- `src/types/MarketBiasReport.ts` 
- `src/state/SystemState.ts`
- `src/cache/BiasCacheStore.ts`
- `src/pipeline/SlowPipeline.ts` (改造)
- `src/pipeline/FastPipeline.ts` (改造)
- `src/indicators/IndicatorManager.ts`
- `src/engine/DecisionEngine.ts`
- `src/cron/SlowPipelineCron.ts`
- `quant_engine/types/bias_report.py`
- `quant_engine/state/system_state.py`
- `quant_engine/cache/bias_cache_store.py`
- `quant_engine/pipeline/slow_pipeline.py`
- `quant_engine/pipeline/fast_pipeline.py`

### 待修改
- `src/pipeline/FastPipeline.ts` — 接 BiasCacheStore + IndicatorManager
- `quant_engine/indicators/composite_momentum.py` — 加 fast_mode 参数
- `quant_engine/indicators/smart_order_block.py` — 加 fast_mode 参数
- `quant_engine/daemon.py` — 加 handle_route + handle_system_state 命令
- `PHASE_PROGRESS.md` — Phase 3 状态

### 测试文件
- `tests/state/SystemState.test.ts`
- `tests/cache/BiasCacheStore.test.ts`
- `tests/pipeline/SlowPipelineE2E.test.ts`
- `tests/pipeline/FastPipelineTick.test.ts`
- `tests/indicators/Indicator13_14_fast_mode.test.py`
- `tests/e2e/phase3_integration.test.ts`

---

## 18. 完成定义 (Definition of Done)

✅ **架构层**
- 快道 Tick P99 < 20ms (1000 次采样)
- 慢道 Cron 60s 稳定, P99 < 90s
- 状态机 5 态全部测试覆盖
- bias 注入延迟 < 100µs

✅ **代码层**
- Indicator 13/14 fast_mode 单测确认零 LLM 调用
- BiasCacheStore 并发读写无竞态
- SlowPipeline 失败降级测试通过
- DecisionEngine 综合判出 BUY/SELL/HOLD

✅ **集成层**
- bitget-trader 联调 (现货 + 合约)
- 24 小时无人值守稳定运行
- 审计日志: SlowPipeline / FastPipeline / StateTransitions 完整

✅ **文档层**
- PHASE_PROGRESS.md Phase 3 完成
- ARCHITECTURE.md 更新双管道图
- README.md 更新运行说明

---

**设计完成,等待实施批准。**
