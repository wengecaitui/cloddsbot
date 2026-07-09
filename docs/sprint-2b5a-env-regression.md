# Sprint 2B.5A — 环境回归调查报告

**时间**: 当前会话  
**状态**: 根因已确定，未修改任何代码

---

## Phase A — 环境快照

### Python 运行时
| 项目 | 值 |
|------|-----|
| `python` executable | `C:\Users\Dujunyi\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe` |
| venv | Hermes 内置 venv（非 TA 专用） |
| cwd（当前） | `E:/Hermes` |

### 环境变量（**全部为空**）
```
OPENAI_API_KEY=            (unset)
OPENAI_COMPATIBLE_API_KEY= (unset)
TRADINGAGENTS_LLM_PROVIDER= (unset)
TRADINGAGENTS_LLM_BACKEND_URL= (unset)
TRADINGAGENTS_DEEP_THINK_LLM= (unset)
TRADINGAGENTS_QUICK_THINK_LLM= (unset)
```

### TradingAgents 安装状态
```
Name: tradingagents
Version: 0.3.0
Editable project location: E:/Workplace/TradingAgents
```

### adapter 路径修改状态
```
quant_engine/tradingagents_adapter.py:
  ✅ _TA_ROOT sys.path.insert 已移除（Phase B 修复）
  ✅ 直接 import tradingagents.*
```

---

## Phase B — Config 解析链

```
default_config.py
  DEFAULT_CONFIG = _apply_env_overrides({
    "llm_provider":    "openai",        ← 硬编码默认值
    "deep_think_llm":  "gpt-5.5",
    "quick_think_llm": "gpt-5.4-mini",
    "backend_url":     None,
  })

  _apply_env_overrides():
    TRADINGAGENTS_LLM_PROVIDER  → config["llm_provider"]
    TRADINGAGENTS_DEEP_THINK_LLM→ config["deep_think_llm"]
    TRADINGAGENTS_LLM_BACKEND_URL → config["backend_url"]

  ↓ 环境变量全部为空 → 保留硬编码默认值

adapter get_graph():
  config = DEFAULT_CONFIG.copy()   ← llm_provider="openai"
  env_provider = os.environ.get("TRADINGAGENTS_LLM_PROVIDER")  ← None
  → config["llm_provider"] 保持 "openai"

TradingAgentsGraph.__init__():
  deep_client = create_llm_client(provider="openai", model="gpt-5.5", base_url=None)

openai_client.py get_llm():
  provider = "openai"
  api_key_env = get_api_key_env("openai")  ← "OPENAI_API_KEY"
  api_key = os.environ.get("OPENAI_API_KEY")  ← None
  → raise ValueError("API key for provider 'openai' is not set")
```

---

## Phase C — 回归对比

| 维度 | 成功运行（前次） | 当前运行 |
|------|--------------|---------|
| CWD | `E:/Workplace/CloddsBot` (TA 根目录) | `E:/Hermes` (Hermes 根目录) |
| .env 加载 | TA 的 `.env` 被自动加载 | 未加载 |
| `TRADINGAGENTS_LLM_PROVIDER` | `openai_compatible` (来自 TA .env) | unset → fallback `openai` |
| `OPENAI_COMPATIBLE_API_KEY` | 已设置 (来自 TA .env) | unset |
| `OPENAI_API_KEY` | 不需要 (openai_compatible 不走这个 key) | 需要 (因为 fallback openai) |
| provider 实际值 | `openai_compatible` | `openai` |

**第一个分歧点**: CWD 从 `E:/Workplace/CloddsBot` 变为 `E:/Hermes`

---

## Phase D — 根因

**根因**: CWD 不是 TA 项目根目录，导致 `python-dotenv` 未能加载 `E:/Workplace/TradingAgents/.env`，`TRADINGAGENTS_LLM_PROVIDER` 等环境变量全部为空，DEFAULT_CONFIG 回退到硬编码的 `llm_provider="openai"`，从而要求 `OPENAI_API_KEY`（未设置）并抛出 ValueError。

**证据链**:
1. `cat /e/Workplace/TradingAgents/.env` 显示正确的配置（`TRADINGAGENTS_LLM_PROVIDER=openai_compatible`, `OPENAI_COMPATIBLE_API_KEY=sk-...`, `TRADINGAGENTS_LLM_BACKEND_URL=https://api4.orangeai.cc/v1`）
2. 当前 `echo $TRADINGAGENTS_LLM_PROVIDER` → unset
3. `DEFAULT_CONFIG` 硬编码 `llm_provider="openai"`
4. `get_api_key_env("openai")` → `OPENAI_API_KEY`（未设置）→ raise ValueError

---

## Phase E — 最小修复建议

**修复**: 在 `quant_engine/tradingagents_adapter.py` 的 `get_graph()` 函数中，加载 DEFAULT_CONFIG 之前，先显式加载 TA 的 .env 文件。

**最小代码修改**（1 行，在 `get_graph()` 开头添加）:
```python
# TA 的 .env 可能不在默认搜索路径中（CWD 不同时）
from pathlib import Path
_TA_ENV = Path(__file__).resolve().parent.parent / "TradingAgents" / ".env"
if _TA_ENV.is_file():
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=_TA_ENV, override=False)
```

**或者**（更彻底）：在模块顶层（adapter 初始化时）调用一次 `load_dotenv`，确保 TA 的 .env 被加载。

---

## 附加信息

- TA `.env` 当前路径: `E:/Workplace/TradingAgents/.env`
- TA 使用 `python-dotenv` 加载 .env（`default_config.py` 依赖此机制）
- 修复后 `TRADINGAGENTS_LLM_PROVIDER=openai_compatible` → `get_api_key_env("openai_compatible")` → `OPENAI_COMPATIBLE_API_KEY` → key 已设置 → **不报错**
