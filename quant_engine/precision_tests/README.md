# Phase 4.6 精度基准测试 — TV vs Python 对齐

## 前提
- TradingView (TV) Pine Script 源码: `docs/all_indicators_pine.txt`
- 相同 mock OHLCV 数据（seed=42，200 bars）

## 测试流程

### 步骤 1: Python 端计算（已自动）
```bash
python -m quant_engine.precision_tests.run_all
```

输出:
- `docs/precision_reports/{indicator}.json` — 逐 bar 对比结果
- `docs/precision_reports/summary.md` — 汇总表格

### 步骤 2: TV 端验证（需人工或 API）

选项 A — **人工验证**（当前推荐）:
1. 打开 TradingView 图表
2. 添加对应 Pine 指标（Hull Suite / Chandelier Exit / UTBot Alerts...）
3. 加载 `docs/mock_ohlcv.csv` 数据（用 CSV 导入或 Pine `request.security` 回测）
4. 导出 TV 计算结果为 CSV
5. 与 Python 输出 `docs/python_values/{indicator}.csv` 对比

选项 B — **API 自动化**（待实现）:
- TradingView 不提供公开 API 计算指标
- 可考虑: 用 `pytradingview` 或自建 Pine 解释器（不推荐，精度风险）

### 步骤 3: 验收标准

| 指标 | 状态 | max_diff | pass_rate |
|------|------|----------|-----------|
| HullSuite | PASS/FAIL | ≤1e-6 | ≥ 99% |
| ChandelierExit | PASS/FAIL | ≤1e-6 | ≥ 99% |
| UTBotAlerts | PASS/FAIL | ≤1e-6 | ≥ 99% |
| ... | ... | ... | ... |

**规则**:
- max_diff ≤ 1e-6 → PASS
- max_diff > 1e-6 → FAIL，挂起阻断，人工审计
- 日志记录: TV 值 vs Python 值逐 bar 差异
- 责任人: 必须有人签字确认才能放行

## 已知风险

- TV Pine Script `nz()` / `na` 处理与 Python NaN 行为差异
- 首根 Bar 初始化: TV 通常用 `bar_index == 0` 或 `barstate.isfirst`，Python 需要同步
- 循环索引: Pine `for i = 0 to length - 1` vs Python `range()` 边界
