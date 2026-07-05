"""P2 批次指标 smoke test — 验证 4 个新指标可计算且 lag_bars 字段正确"""
import sys
import json
import time
import numpy as np
import pandas as pd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from quant_engine.indicators import (
    P1_INDICATORS, P2_INDICATORS
)
from quant_engine.daemon import INDICATOR_DISPATCH, P0_INDICATORS


def make_mock_df(n=200):
    """生成 n 根 K 线的 mock OHLCV 数据"""
    np.random.seed(42)
    close = 100 + np.cumsum(np.random.randn(n) * 0.5)
    high = close + np.abs(np.random.randn(n)) * 0.3
    low = close - np.abs(np.random.randn(n)) * 0.3
    open_ = close + np.random.randn(n) * 0.1
    volume = np.abs(np.random.randn(n) * 1000 + 5000)
    return pd.DataFrame({
        "open": open_, "high": high, "low": low,
        "close": close, "volume": volume
    })


def main():
    df = make_mock_df(200)
    print(f"Mock 数据: {len(df)} 根 K 线")
    print(f"INDICATOR_DISPATCH 共 {len(INDICATOR_DISPATCH)} 个指标")
    print(f"  P0: {list(P0_INDICATORS.keys())}")
    print(f"  P1: {list(P1_INDICATORS.keys())}")
    print(f"  P2: {list(P2_INDICATORS.keys())}")
    print()

    # 跑全部 11 个指标
    results = {}
    for name, fn in INDICATOR_DISPATCH.items():
        t0 = time.perf_counter()
        try:
            r = fn(df, {})
            elapsed_ms = (time.perf_counter() - t0) * 1000
            results[name] = {
                "ok": "error" not in r,
                "ms": round(elapsed_ms, 2),
                "lag_bars": r.get("lag_bars", "?"),
                "signal": r.get("signal", r.get("position", r.get("trend", "n/a"))),
                "error": r.get("error", None)
            }
        except Exception as e:
            results[name] = {"ok": False, "error": str(e), "ms": 0}

    print(f"{'Indicator':<25} {'OK':<5} {'Lag':<5} {'Signal':<12} {'ms':<8} Error")
    print("-" * 75)
    for name, r in results.items():
        print(f"{name:<25} {'✓' if r['ok'] else '✗':<5} "
              f"{str(r.get('lag_bars', '-')):<5} "
              f"{str(r.get('signal', '-')):<12} "
              f"{r.get('ms', 0):<8} {r.get('error', '')}")

    print()
    ok_count = sum(1 for r in results.values() if r["ok"])
    print(f"通过: {ok_count}/{len(results)}")

    # P2 验证 lag_bars > 0
    print()
    print("P2 Strict_Lag_Offset 验证:")
    for name in P2_INDICATORS:
        r = results[name]
        lag = r.get("lag_bars", 0)
        status = "✅" if (isinstance(lag, int) and lag > 0) else "❌"
        print(f"  {status} {name}: lag_bars={lag}")

    # 性能测试
    print()
    print("性能测试 (100 次调用):")
    timings = []
    for _ in range(100):
        t0 = time.perf_counter()
        for fn in INDICATOR_DISPATCH.values():
            fn(df, {})
        timings.append((time.perf_counter() - t0) * 1000)
    p50 = np.percentile(timings, 50)
    p99 = np.percentile(timings, 99)
    print(f"  全部 {len(INDICATOR_DISPATCH)} 指标 P50={p50:.2f}ms P99={p99:.2f}ms")
    print(f"  阈值 50ms — {'✅ 通过' if p99 < 50 else '❌ 超标'}")

    return ok_count == len(results)


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
