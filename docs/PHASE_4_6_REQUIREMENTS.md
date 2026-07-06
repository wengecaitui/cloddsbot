# Phase 4.6 精度基准测试 — 需求清单

## 我有什么（已完成）

| 项目 | 状态 |
|------|------|
| **Python 指标代码** | ✅ 11 个指标已实现（Hull Suite / Chandelier Exit / UT Bot / STC / Stochastic / Mean Reversion / Trend Impulse / DeltaFlow / ElliottWave / Fibonacci Entry / SRRange） |
| **Mock OHLCV 数据** | ✅ seed=42, 200 根 K 线，`docs/python_values/{indicator}.csv` 已生成 |
| **精度测试框架** | ✅ `quant_engine/precision_tests/base.py` + `run_all.py` |
| **报告模板** | ✅ `docs/precision_reports/{indicator}.json`（待填充） |

---

## 我需要什么（缺）

### 核心需求：TradingView Pine Script 源码

**为什么需要 Pine 源码？**
Phase 4.6 的目标是把我们的 Python 实现和 TradingView 的官方指标逐 bar 对比，确保精度 ≤ 1e-6。这个"官方值"只能从 TradingView 里来——要么加载 Pine 脚本导出 CSV，要么截图手动对比。

**14 个指标的 Pine 源码（来自 TradingView Pine Editor）**

| 批次 | 指标名 | 作者 | 优先级 |
|------|--------|------|--------|
| P0 | Hull Suite | `kivanccoban` | 🔴 最高 |
| P0 | Chandelier Exit | `KivancOzbilgic` | 🔴 最高 |
| P0 | UT Bot Alerts | `HPotter` | 🔴 最高 |
| P1 | STC Indicator | `shayankm` | 🟡 中 |
| P1 | Stochastic Overlay | `Zeiierman` | 🟡 中 |
| P1 | Mean Reversion Probability Zones | `BigBeluga` | 🟡 中 |
| P1 | Trend Impulse Channels | `Lonsby` | 🟡 中 |
| P2 | DeltaFlow Volume Profile | `LnxBil` | 🟡 中 |
| P2 | Elliott Wave [LuxAlgo] | `LuxAlgo` | 🟡 中 |
| P2 | Fibonacci Entry Bands | `NikoF` | 🟡 中 |
| P2 | Support and Resistance Range | `LuxAlgo` | 🟡 中 |
| P3 | Comprehensive Trading Toolkit | — | 🟢 低 |
| P3 | TradeIQ | — | 🟢 低 |
| P1/P3 | Volume Profile | — | ⏸️ 跳过（缺 Tick 数据） |

**每种获取方式（按推荐顺序）：**

1. **Pine Editor 直接导出**（最准）
   - 打开 TradingView → 任意图表 → Pine Editor
   - 粘贴指标源码 → 加载到图表
   - 等计算完 → 右键指标 → "Export data to CSV"
   - 把 CSV 发给我

2. **GitHub 搜索 Pine 仓库**（快速但需人工验证版本匹配）
   - 格式：`https://github.com/{author}/{repo}` 的 `*.pine` 文件
   - 我需人工核对代码与 TV 上的是否一致

3. **截屏指标值**（最慢但最准）
   - TradingView 图表加载 Pine + mock OHLCV
   - 截取指标值截图
   - 我人工对比

---

## 我有（可以做的）

| 项目 | 状态 |
|------|------|
| **Mock OHLCV CSV** | ✅ `docs/python_values/mock_ohlcv.csv`（200 根，seed=42） |
| **Python 端计算值** | ✅ `docs/python_values/{indicator}.csv`（11 个指标） |
| **精度报告模板** | ✅ `docs/precision_reports/{indicator}.json` |

---

## 最小可行路径（立刻能做）

如果我找不到对应 Pine 源码，可以走 **人工对比** 路径：

1. 我把 mock OHLCV 转换成 TradingView 可导入的格式
2. 你在 TradingView 加载 Pine + mock 数据 → 导出指标值
3. 我自动跑精度对比脚本

**现在可以开始做的事：**
- [ ] 把 mock OHLCV 导出成 TradingView 导入格式（CSV/JSON）
- [ ] 创建精度对比脚本 `quant_engine/precision_tests/compare_tv_vs_python.py`
- [ ] 生成对比报告模板 `docs/precision_reports/INDICATOR_TEMPLATE.json`
