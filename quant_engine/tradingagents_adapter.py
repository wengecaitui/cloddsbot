# quant_engine/tradingagents_adapter.py
# Sprint 2B: Hermes ←→ TradingAgents Adapter
#
# 职责：Hermes 和 TradingAgents 之间的单向适配器。
# - 通过 stdin/stdout JSON Lines 接收 Hermes 请求
# - 调用 TradingAgentsGraph.propagate()（已验证 API，不修改）
# - 将 Pydantic 输出转换为 MarketBiasReportFull 兼容 JSON（三层解析回退链）
# - 通过 stdout JSON Lines 返回结果
#
# 设计原则：
# - TradingAgents 永远不会被修改（pip 依赖）
# - 适配器是唯一知道两端的模块
# - 所有映射逻辑在此文件内，不泄漏
#
# Sprint 2B.5.1 (env init): 显式加载 TA/.env，不依赖 CWD。
# Sprint 2B.4  (三层解析): _convert_to_report 支持 pydantic/json/自由文本。

import json
import sys
import os
import re
import time
import traceback
from pathlib import Path

# ─── 环境初始化：加载 TradingAgents/.env（CWD 无关）────────────────────────
# 必须在 from tradingagents.* import 之前执行，因为
# default_config._apply_env_overrides() 在 import 时立即读 os.environ。
# override=False: 不覆盖系统已注入的变量（让 env 变量优先）。
_ta_pkg_root = Path(__import__("tradingagents").__file__).resolve().parent.parent
_ta_env_file = _ta_pkg_root / ".env"
if _ta_env_file.is_file():
    try:
        from dotenv import load_dotenv
        load_dotenv(dotenv_path=str(_ta_env_file), override=False)
    except ImportError:
        pass

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.agents.schemas import PortfolioDecision, TraderProposal, PortfolioRating

# ─── 版本 ────────────────────────────────────────────────────────────────────
ADAPTER_VERSION = "1.0.0"

# ─── 全局 Graph 实例（惰性初始化，跨请求复用） ──────────────────────────────
_graph: TradingAgentsGraph | None = None


def get_graph() -> TradingAgentsGraph:
    """获取或初始化全局 TradingAgentsGraph 实例。"""
    global _graph
    if _graph is None:
        config = DEFAULT_CONFIG.copy()
        # 从环境变量覆盖——与环境变量优先级保留
        env_provider = os.environ.get("TRADINGAGENTS_LLM_PROVIDER")
        if env_provider:
            config["llm_provider"] = env_provider
        env_deep = os.environ.get("TRADINGAGENTS_DEEP_THINK_LLM")
        if env_deep:
            config["deep_think_llm"] = env_deep
        env_quick = os.environ.get("TRADINGAGENTS_QUICK_THINK_LLM")
        if env_quick:
            config["quick_think_llm"] = env_quick

        _graph = TradingAgentsGraph(debug=False, config=config)
    return _graph


def handle_analyze(payload: dict) -> dict:
    """处理 ANALYZE 请求：调用 TradingAgentsGraph.propagate()。"""
    symbol = payload.get("symbol", "")
    trade_date = payload.get("timestamp", "")

    if not symbol:
        return {"success": False, "error": "symbol 是必填字段", "payload": {"request": payload}}

    if not trade_date:
        trade_date = time.strftime("%Y-%m-%d")

    try:
        graph = get_graph()
        start_ms = int(time.time() * 1000)
        final_state, decision = graph.propagate(symbol, trade_date)
        elapsed_ms = int(time.time() * 1000) - start_ms

        report = _convert_to_report(final_state, decision, symbol, trade_date, elapsed_ms)

        return {
            "success": True,
            "elapsed_ms": elapsed_ms,
            "report": report,
            "metrics": {
                "signal": decision if isinstance(decision, str) else str(decision),
                "provider": graph.config.get("llm_provider", "unknown"),
                "deep_model": graph.config.get("deep_think_llm", "unknown"),
            },
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
            "elapsed_ms": 0,
            "report": None,
        }


def _convert_to_report(
    final_state: dict, decision, symbol: str, trade_date: str, elapsed_ms: int
) -> dict:
    """将 TradingAgents 的输出转换为 MarketBiasReportFull 兼容 JSON。

    三层解析策略（回退链）：
      1. Pydantic model_dump() — 如果 decision 或 final_state 含 Pydantic
      2. JSON 字符串解析 — 如果 final_trade_decision 是 JSON
      3. 自由文本正则提取 — 从 Markdown/普通文本中提取评级、方向
    """
    now_ms = int(time.time() * 1000)
    degraded = False

    pm_text = final_state.get("final_trade_decision", "")
    raw_rating = None
    raw_confidence = None
    raw_direction = None
    raw_reason = None

    # Level 1: Pydantic model_dump()
    portfolio_decision = final_state.get("portfolio_decision")
    if portfolio_decision is not None and hasattr(portfolio_decision, "model_dump"):
        try:
            pd_data = portfolio_decision.model_dump()
            raw_rating = pd_data.get("rating") or pd_data.get("Rating")
            raw_confidence = pd_data.get("confidence") or pd_data.get("Confidence")
        except Exception:
            pass

    # Level 2: JSON 字符串解析
    if not raw_rating and pm_text.strip().startswith("{"):
        try:
            jd = json.loads(pm_text)
            if isinstance(jd, dict):
                raw_rating = (jd.get("rating") or jd.get("Rating") or
                              jd.get("decision") or jd.get("Decisao"))
                raw_confidence = (jd.get("confidence") or jd.get("Confidence"))
                raw_direction = (jd.get("direction") or jd.get("Direction") or
                                 jd.get("side") or jd.get("Side"))
                raw_reason = (jd.get("reason") or jd.get("Reason") or
                              jd.get("rationale") or jd.get("summary"))
        except (json.JSONDecodeError, TypeError):
            pass

    # Level 3: 自由文本正则提取
    if not raw_rating:
        degraded = True
        raw_rating, raw_confidence, raw_direction, raw_reason = _parse_free_text(pm_text)

    # ─── 归一化评级 ────────────────────────────────────────────────────
    rating_str = _normalize_rating(raw_rating) if raw_rating else "Hold"

    # ─── 映射评级 → 方向 ──────────────────────────────────────────────
    rating_to_direction = {
        "Buy": "long", "Overweight": "long", "Hold": "hold",
        "Underweight": "short", "Sell": "short",
    }
    direction = raw_direction if raw_direction in ("long", "short", "hold") else rating_to_direction.get(rating_str, "hold")

    # ─── 置信度 ────────────────────────────────────────────────────────
    if raw_confidence is not None:
        try:
            confidence = max(0, min(100, int(float(raw_confidence))))
        except (ValueError, TypeError):
            confidence = 50
    else:
        rating_to_confidence = {
            "Buy": 90, "Overweight": 75, "Hold": 50,
            "Underweight": 25, "Sell": 10,
        }
        confidence = rating_to_confidence.get(rating_str, 50)

    # ─── 全局偏向 ──────────────────────────────────────────────────────
    direction_to_bias = {"long": "bullish", "hold": "neutral", "short": "bearish"}
    global_bias = direction_to_bias.get(direction, "neutral")

    # ─── 理由摘要 ──────────────────────────────────────────────────────
    if raw_reason:
        entry_condition = raw_reason
    else:
        entry_condition = _extract_field(pm_text, "Executive Summary")
        if entry_condition == "No data":
            entry_condition = (_extract_field(pm_text, "Reasoning") or
                               _extract_field(pm_text, "Summary") or
                               pm_text[:250] if pm_text else "No data")

    # ─── 构建报告 ───────────────────────────────────────────────────────
    report = {
        "timestamp": now_ms,
        "updatedAt": now_ms,
        "globalBias": global_bias,
        "confidence": confidence,
        "assets": [{
            "symbol": symbol,
            "bias": global_bias,
            "confidence": confidence,
            "volatility": 50,
            "direction": direction,
            "suggestedPositionPct": 0.15 if direction != "hold" else 0.0,
            "entryCondition": entry_condition,
            "stopLoss": "-",
            "takeProfit": "-",
        }],
        "globalLongShortRatio": 1.0,
        "globalVolatility": 50,
        "fearGreedIndex": 50,
        "fundingStatus": "neutral",
        "whitelist": [symbol],
        "blacklist": [],
        "riskEvents": [],
        "meta": {
            "source": "tradingagents_adapter",
            "modelVersion": get_graph().config.get("deep_think_llm", "unknown"),
            "generationTimeMs": elapsed_ms,
            "inputSummary": f"TradingAgents analysis of {symbol} on {trade_date}",
        },
    }

    if degraded:
        report["_degraded"] = True

    return report


def _parse_free_text(text: str):
    """从自由文本（Markdown/纯文本）中提取评级、置信度、方向。"""
    rating = None
    confidence = None
    direction = None
    reason = None

    rating_keys = [
        r"\*\*Rating\*\*[\s:：]*([^\n]+)", r"\*\*评级\*\*[\s:：]*([^\n]+)",
        r"(?:^|\n)\s*Rating[\s:：]+([^\n]+)", r"(?:^|\n)\s*评级[\s:：]+([^\n]+)",
        r"\*\*Decisao\*\*[\s:：]*([^\n]+)", r"\*\*决策\*\*[\s:：]*([^\n]+)",
    ]
    for pat in rating_keys:
        m = re.search(pat, text, re.IGNORECASE | re.MULTILINE)
        if m:
            rating = m.group(1).strip()
            break

    confidence_keys = [
        r"\*\*Confidence\*\*[\s:：]*(\d+)", r"\*\*置信度\*\*[\s:：]*(\d+)",
        r"(?:^|\n)\s*Confidence[\s:：]+(\d+)", r"(?:^|\n)\s*置信度[\s:：]+(\d+)",
    ]
    for pat in confidence_keys:
        m = re.search(pat, text, re.IGNORECASE | re.MULTILINE)
        if m:
            confidence = m.group(1).strip()
            break

    direction_keys = [
        r"\*\*Direction\*\*[\s:：]*([^\n]+)", r"\*\*方向\*\*[\s:：]*([^\n]+)",
        r"(?:^|\n)\s*Direction[\s:：]+([^\n]+)", r"(?:^|\n)\s*方向[\s:：]+([^\n]+)",
        r"\*\*Side\*\*[\s:：]*([^\n]+)",
    ]
    for pat in direction_keys:
        m = re.search(pat, text, re.IGNORECASE | re.MULTILINE)
        if m:
            raw_dir = m.group(1).strip().lower()
            norm = {"long": "long", "short": "short", "hold": "hold",
                    "buy": "long", "sell": "short",
                    "买入": "long", "卖出": "short", "持有": "hold",
                    "做多": "long", "做空": "short"}
            direction = norm.get(raw_dir)
            break

    reason_keys = [
        r"\*\*Executive Summary\*\*[\s:：]*([^\n]*)", r"\*\*Rationale\*\*[\s:：]*([^\n]*)",
        r"\*\*Reasoning\*\*[\s:：]*([^\n]*)", r"\*\*理由\*\*[\s:：]*([^\n]*)",
        r"\*\*Summary\*\*[\s:：]*([^\n]*)",
    ]
    for pat in reason_keys:
        m = re.search(pat, text, re.IGNORECASE | re.MULTILINE)
        if m:
            reason = m.group(1).strip()
            break

    return rating, confidence, direction, reason


def _normalize_rating(rating: str) -> str:
    """将中英文评级归一化为标准英文风格。"""
    rating_clean = rating.strip().strip("*").strip()
    norm_map = {
        "buy": "Buy", "买入": "Buy", "strong buy": "Buy", "强力买入": "Buy",
        "overweight": "Overweight", "超配": "Overweight",
        "hold": "Hold", "持有": "Hold", "neutral": "Hold",
        "underweight": "Underweight", "低配": "Underweight",
        "sell": "Sell", "卖出": "Sell", "strong sell": "Sell", "强力卖出": "Sell",
    }
    return norm_map.get(rating_clean.lower(), rating_clean)


def _extract_field(text: str, field_name: str) -> str:
    """从 markdown 文本中提取指定字段的内容。"""
    for line in text.split("\n"):
        line_stripped = line.strip()
        if line_stripped.startswith(f"**{field_name}**"):
            return line_stripped.split(":", 1)[1].strip() if ":" in line else ""
    return "No data"


def handle_ping() -> dict:
    """处理 PING 请求。"""
    return {"success": True, "pong": True}


def handle_health() -> dict:
    """处理 HEALTH 请求（不需要 Graph 实例）。"""
    return {
        "success": True,
        "metadata": {
            "adapter_version": ADAPTER_VERSION,
            "graph": "TradingAgentsGraph",
            "provider": os.environ.get("TRADINGAGENTS_LLM_PROVIDER", "not_configured"),
            "deep_model": os.environ.get("TRADINGAGENTS_DEEP_THINK_LLM", "not_configured"),
            "quick_model": os.environ.get("TRADINGAGENTS_QUICK_THINK_LLM", "not_configured"),
        },
    }


def handle_version() -> dict:
    """处理 VERSION 请求。"""
    return {"success": True, "adapter_version": ADAPTER_VERSION}


def handle_not_implemented(request_type: str) -> dict:
    """处理不支持的请求类型。"""
    return {"success": False, "error": "NOT_IMPLEMENTED", "request_type": request_type}


# ─── 请求分发 ─────────────────────────────────────────────────────────────────
HANDLERS = {
    "ANALYZE": lambda p: handle_analyze(p),
    "CALC": lambda p: handle_analyze(p),      # 兼容 PythonBridgeDaemon.calculate()
    "PING": lambda p: handle_ping(),
    "HEALTH": lambda p: handle_health(),
    "VERSION": lambda p: handle_version(),
}


def main():
    """主循环：从 stdin 读取 JSON Lines 请求，处理后写入 stdout。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}), flush=True)
            continue

        request_type = request.get("type", "")
        correlation_id = request.get("correlationId", "")
        # Stage 3B4C6: flatten-top-level protocol compatibility.
        # sendPayload spreads body fields flat: {type, correlationId, asset, ...}.
        # Legacy tradingagents_adapter sent {type, payload: {asset, ...}}.
        # Merge both: nested "payload" is baseline, top-level fields fill gaps.
        payload = request.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}
        for key, val in request.items():
            if key in ("type", "correlationId", "payload"):
                continue
            payload.setdefault(key, val)

        handler = HANDLERS.get(request_type)
        if handler is None:
            response = handle_not_implemented(request_type)
        else:
            response = handler(payload)

        response["correlationId"] = correlation_id
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
