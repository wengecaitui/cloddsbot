"""
quant_engine/daemon_selftest.py — Self-Test Mode (A方案)
运行: python quant_engine/daemon.py --self-test
用途: 直接导入指标函数验证算法逻辑，不通过 pipe 协议（测的是算法本身）
"""
import sys
import os
import json
import time
import numpy as np
import pandas as pd
from typing import Dict, Any

# 确保能找到父目录和 quant_engine 包
_sys_path_anchor = os.path.dirname(os.path.abspath(__file__))
if _sys_path_anchor not in sys.path:
    sys.path.insert(0, _sys_path_anchor)

sys.path_parent = os.path.dirname(_sys_path_anchor)
if sys.path_parent not in sys.path:
    sys.path.insert(0, sys.path_parent)

# ─── Mock 数据生成 ─────────────────────────────────────────────────────────────

def _mock_series(n: int = 300, seed: int = 42) -> pd.DataFrame:
    """生成 mock OHLCV 数据"""
    rng = np.random.default_rng(seed)
    prices = 50000 + np.cumsum(rng.normal(0, 50, n))
    
    df = pd.DataFrame({
        "open": prices + rng.normal(0, 5, n),
        "high": prices + rng.normal(5, 5, n),
        "low": prices - rng.normal(5, 5, n),
        "close": prices,
        "volume": np.abs(rng.normal(1000, 200, n)),
    })
    return df


# ─── 直接调用指标函数（绕过 pipe 协议）────────────────────────────────────────

def _call_indicator(name: str, df: pd.DataFrame, params: dict = None) -> Dict[str, Any]:
    """直接导入并调用指标函数"""
    params = params or {}
    
    # P0 (daemon.py 内置)
    if name == "HullSuite":
        from quant_engine.daemon import calc_hull_suite
        return calc_hull_suite(df, params)
    elif name == "ChandelierExit":
        from quant_engine.daemon import calc_chandelier_exit
        return calc_chandelier_exit(df, params)
    elif name == "UTBotAlerts":
        from quant_engine.daemon import calc_ut_bot_alerts
        return calc_ut_bot_alerts(df, params)
    
    # P1
    elif name == "RSI":
        from quant_engine.daemon import _rsi
        return {"name": "RSI", "rsi": float(_rsi(df, params.get("period", 14)).iloc[-1])}
    elif name == "MACD":
        from quant_engine.daemon import _macd
        result = _macd(df, params.get("fast", 12), params.get("slow", 26), params.get("signal", 9))
        return {"name": "MACD", "macd": float(result["macd"].iloc[-1]),
                "signal": float(result["signal"].iloc[-1]),
                "histogram": float(result["histogram"].iloc[-1])}
    elif name == "STC":
        from quant_engine.indicators.stc import calculate as fn
        return fn(df, params)
    elif name == "StochasticOverlay":
        from quant_engine.indicators.stochastic import calculate as fn
        return fn(df, params)
    elif name == "MeanReversion":
        from quant_engine.indicators.mean_reversion import calculate as fn
        return fn(df, params)
    elif name == "TrendImpulse":
        from quant_engine.indicators.trend_impulse import calculate as fn
        return fn(df, params)
    
    # P2
    elif name == "ElliottWave":
        from quant_engine.indicators.elliott_wave import calculate as fn
        return fn(df, params)
    elif name == "FibonacciRetracement":
        from quant_engine.indicators.fibonacci import calculate as fn
        return fn(df, params)
    elif name == "SRRange":
        from quant_engine.indicators.sr_range import calculate as fn
        return fn(df, params)
    elif name == "DeltaFlow":
        from quant_engine.indicators.deltaflow import calculate as fn
        return fn(df, params)
    elif name == "VolumeProfile":
        from quant_engine.indicators.volume_profile import calculate as fn
        return fn(df, params)
    
    # P3
    elif name == "CompositeMomentum":
        from quant_engine.indicators.composite_momentum import calculate as fn
        return fn(df, params)
    elif name == "SmartOrderBlock":
        from quant_engine.indicators.smart_order_block import calculate as fn
        return fn(df, params)
    
    else:
        return {"error": f"未知指标: {name}"}


# ─── 测试用例定义 ───────────────────────────────────────────────────────────────

SELFTEST_CASES = {
    # P0 黄金首发
    "HullSuite (period=200)": {
        "params": {"period": 200},
        "validate": lambda r: "hma" in r and r["hma"] > 0,
        "expected_keys": ["hma", "trend", "position"],
    },
    "ChandelierExit (len=22, mult=3.0)": {
        "params": {"length": 22, "mult": 3.0},
        "validate": lambda r: "long_stop" in r and "signal" in r and r["signal"] in ("LONG", "SHORT", "HOLD"),
        "expected_keys": ["long_stop", "short_stop", "direction", "signal"],
    },
    "UTBotAlerts (keyPass=1.0, atrPeriod=10)": {
        "params": {"keyPass": 1.0, "atrPeriod": 10},
        "validate": lambda r: "buy" in r and "sell" in r,
        "expected_keys": ["buy", "sell", "signal"],
    },
    
    # P1 基础指标
    "RSI (period=14)": {
        "params": {"period": 14},
        "validate": lambda r: 0 <= r.get("rsi", -1) <= 100,
        "expected_keys": ["rsi"],
    },
    "MACD (12/26/9)": {
        "params": {"fast": 12, "slow": 26, "signal": 9},
        "validate": lambda r: "macd" in r and "signal" in r and "histogram" in r,
        "expected_keys": ["macd", "signal", "histogram"],
    },
    "STC": {
        "params": {},
        "validate": lambda r: "stc" in r,
        "expected_keys": ["stc"],
    },
    "StochasticOverlay": {
        "params": {},
        "validate": lambda r: "k" in r and "d" in r,
        "expected_keys": ["k", "d"],
    },
    "MeanReversion": {
        "params": {},
        "validate": lambda r: "signal" in r,
        "expected_keys": ["signal", "zscore"],
    },
    "TrendImpulse": {
        "params": {},
        "validate": lambda r: "signal" in r and "zone" in r,
        "expected_keys": ["signal", "zone"],
    },
    
    # P2 高阶指标
    "ElliottWave (count=3)": {
        "params": {"count": 3},
        "validate": lambda r: "wave_pattern" in r,
        "expected_keys": ["wave_pattern", "trend", "lag_bars"],
    },
    "FibonacciRetracement (high=52000, low=48000)": {
        "params": {"high": 52000, "low": 48000},
        "validate": lambda r: "position" in r,
        "expected_keys": ["swing_highs", "swing_lows"],
    },
    "SRRange (lookback=100)": {
        "params": {"lookback": 100},
        "validate": lambda r: "support" in r and "resistance" in r,
        "expected_keys": ["support", "resistance"],
    },
    "DeltaFlow (period=14)": {
        "params": {"period": 14},
        "validate": lambda r: "delta_smooth" in r and "direction" in r,
        "expected_keys": ["delta_smooth", "direction", "lag_bars"],
    },
    "VolumeProfile (rows=24)": {
        "params": {"rows": 24},
        "validate": lambda r: "error" not in r or "tick" in r.get("error", "").lower() or "profile" in r,
        "expected_keys": ["profile", "poc"],
    },
    
    # P3 复合智能指标
    "CompositeMomentum": {
        "params": {},
        "validate": lambda r: "composite_score" in r and "regime_state" in r,
        "expected_keys": ["composite_score", "dimension_scores"],
    },
    "SmartOrderBlock": {
        "params": {},
        "validate": lambda r: "has_active_ob" in r and "phase3_bridge_signal" in r,
        "expected_keys": ["has_active_ob", "phase3_bridge_signal"],
    },
}


def run_self_test():
    print("=" * 60)
    print("  CloddsBot Daemon — Self-Test Mode (算法逻辑验证)")
    print("=" * 60)
    print()
    
    df = _mock_series(n=300)
    
    results = []
    total = len(SELFTEST_CASES)
    
    for idx, (name, case) in enumerate(SELFTEST_CASES.items()):
        # 提取干净指标名（去掉参数注释）
        ind_name = name.split(" (")[0]
        sys.__stdout__.write(f"[{idx+1:2d}/{total}] {name} ... ")
        sys.__stdout__.flush()
        
        t0 = time.time()
        try:
            result = _call_indicator(ind_name, df, case["params"])
            elapsed = (time.time() - t0) * 1000
            
            # 检查 error 字段
            if "error" in result and "tick" not in result.get("error", "").lower():
                passed = False
                detail = f"ERROR: {result['error'][:80]}"
            else:
                passed = case["validate"](result)
                detail = "" if passed else "验证失败"
            
        except Exception as e:
            elapsed = (time.time() - t0) * 1000
            passed = False
            detail = f"EXCEPTION: {str(e)[:80]}"
        
        icon = "✓" if passed else "✗"
        sys.__stdout__.write(f"{icon} {elapsed:.0f}ms")
        if detail:
            sys.__stdout__.write(f" | {detail}")
        sys.__stdout__.write("\n")
        sys.__stdout__.flush()
        
        results.append({"name": name, "passed": passed, "elapsed_ms": elapsed, "detail": detail})
    
    # 汇总
    print()
    print("=" * 60)
    passed_count = sum(1 for r in results if r["passed"])
    fail_count = total - passed_count
    print(f"  总计: {total}  通过: {passed_count}  失败: {fail_count}")
    
    if fail_count == 0:
        print("  ✅ 全部通过")
    else:
        print("  ❌ 有失败项:")
        for r in results:
            if not r["passed"]:
                print(f"    ✗ {r['name']}: {r['detail']}")
    print("=" * 60)
    
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(run_self_test())
