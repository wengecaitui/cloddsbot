# Python Bridge Runtime 配置

## 原理
CloddsBot 使用 Python 子进程执行两类任务：
1. **Quant Engine**（`quant_engine/daemon.py`）：执行技术指标计算、协议校验
2. **TradingAgents**（`quant_engine/tradingagents_adapter.py`）：多 Agent 研究分析

两者有不同依赖和 Python 环境需求，可以隔离运行。

## 解释器选择优先级（fail-fast）

1. `constructor pythonExecutable`（构造参数显式传入）— 最高优先级
2. `QUANT_ENGINE_PYTHON` — 用于 Quant Engine daemon（不设置时跳至 4）
3. `TRADINGAGENTS_PYTHON` — 用于 TradingAgents adapter（不设置时跳至 4）
4. `PYTHONBRIDGE_PYTHON` — 通用 fallback
5. `python` — 系统 PATH（隐式默认，最后兜底）

### 重要规则
- 如果 1-4 任一提供了**显式文件路径但该路径不存在**：**立即报错**，不会静默回退到其他解释器
- 只有完全不提供任何显式配置时，才会使用 PATH 中的 `python`
- `python` 字符串不做存在性检查（它可以是 PATH 解析的命令，不必须是文件）

## 环境区别

### Quant Engine
- 子进程自动清除继承的 `PYTHONPATH`、`PYTHONHOME`、`VIRTUAL_ENV`
- 目的：防止 Hermes Agent 在进程中注入的 site-packages 污染 .venv-cloddsbot
- 建议运行在独立 venv 中

### TradingAgents
- 保留继承的运行环境（含 Hermes venv 的 `PYTHONPATH`）
- 因为 TradingAgents 依赖 `tradingagents` 包，装在 Hermes venv 中

## Windows 配置示例

```powershell
# 1. 创建 Quant Engine 独立 venv
.venv-cloddsbot\Scripts\python.exe -m venv .venv-cloddsbot

# 2. 安装量化引擎依赖
.venv-cloddsbot\Scripts\python.exe -m pip install -r quant_engine\requirements.txt

# 3. 设置 runtime 环境变量（仅为当前 shell 有效，不写入仓库）
$env:QUANT_ENGINE_PYTHON = "<repo-root>\.venv-cloddsbot\Scripts\python.exe"

# 4. 验证
.venv-cloddsbot\Scripts\python.exe -u quant_engine\daemon.py
```

## 验证命令

### Direct PING
```powershell
echo '{"type":"PING","correlationId":"test"}' | <python> -u quant_engine/daemon.py
```
预期响应：`{"type":"PONG","correlationId":"test","status":"READY"}`

### 真实 CALC（HullSuite 指标）
```python
payload = {
    "type": "CALC",
    "correlationId": "calc-test",
    "asset": "BTC/USDT",
    "series": [/* OHLCV data */],
    "indicators": [{"name": "HullSuite", "params": {"period": 200}}],
}
```

## stderr 尾部捕获
Python 子进程的 stderr 会被有界缓冲区捕获（最大 16 KB）。
当进程提前退出、超时或返回非零退出码时，stderr 尾部会附加在错误消息中。

## 安全事项
- `.env` 文件包含 API keys 和路径，已列入 `.gitignore`，**不提交到 Git**
- `.env.example` 使用空模板，不包含真实路径或密钥
- `.venv-cloddsbot/` 已加入 `.gitignore`，不提交到 Git
