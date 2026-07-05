"""Smoke test — 验证 P2 4个新指标可计算"""
import sys, os, time, statistics
sys.path.insert(0, ".")

import pandas as pd
import numpy as np
from quant_engine.indicators import P2_INDICATORS, P1_INDICATORS
from quant_engine.daemon import INDICATOR_DISPATCH, P0_INDICATORS

print(f"INDICATOR_DISPATCH: {len(INDICATOR_DISPATCH)} 个指标")

np.random.seed(42)
n = 200
close = 100 + np.cumsum(np.random.randn(n) * 0.5)
df = pd.DataFrame({
    "open": close + np.random.uniform(-0.3, 0.3, n),
    "high": close + np.abs(np.random.randn(n)) * 0.3,
    "low": close - np.abs(np.random.randn(n)) * 0.3,
    "close": close,
    "volume": np.random.uniform(1000, 5000, n),
})

for name, fn in sorted(INDICATOR_DISPATCH.items()):
    try:
        r = fn(df, {})
        lag = r.get("lag_bars", "?")
        sig = r.get("signal", r.get("position", r.get("trend", "-")))
        status = "✅" if "error" not in r else f"❌ {r.get('error')}"
        print(f"  {name:25} lag_bars={lag:>4} signal={str(sig):12} {status}")
    except Exception as e:
        print(f"  {name:25} ❌ {type(e).__name__}: {e}")

print("\nP2 Strict_Lag_Offset 验证:")
for name in ["ElliottWave", "FibonacciEntryBands", "SRRange", "DeltaFlow"]:
    if name in INDICATOR_DISPATCH:
        r = INDICATOR_DISPATCH[name](df, {})
        lag = r.get("lag_bars", 0)
        ok = "✅" if (isinstance(lag, int) and lag > 0) else "❌"
        print(f"  {ok} {name}: lag_bars={lag}")
