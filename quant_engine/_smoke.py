
import sys, os, json, time
sys.path.insert(0, r"E:\Workplace\CloddsBot")

import pandas as pd
import numpy as np
from quant_engine.daemon import INDICATOR_DISPATCH
from quant_engine.indicators import P2_INDICATORS

print(f"Total: {len(INDICATOR_DISPATCH)}")
print(f"P2: {list(P2_INDICATORS.keys())}")

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

results = []
for name, fn in sorted(INDICATOR_DISPATCH.items()):
    try:
        r = fn(df, {})
        lag = r.get("lag_bars", "?")
        sig = r.get("signal", r.get("position", "-"))
        status = "OK" if "error" not in r else f"ERR: {r.get('error')}"
        results.append({"name": name, "status": status, "lag_bars": lag, "signal": str(sig)})
    except Exception as e:
        results.append({"name": name, "status": f"EXCEPT: {type(e).__name__}", "lag_bars": "?", "signal": "-"})

with open(r"E:\Workplace\CloddsBot\docs\smoke_p2.json", "w") as f:
    json.dump(results, f, indent=2)
print("Results written to docs/smoke_p2.json")
