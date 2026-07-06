
import sys
sys.path.insert(0, "E:\\Workplace\\CloddsBot")
import pandas as pd
import numpy as np
from quant_engine.daemon import INDICATOR_DISPATCH
np.random.seed(42)
n = 200; close = 100 + np.cumsum(np.random.randn(n)*0.5)
df = pd.DataFrame({"open":close+np.random.uniform(-0.3,0.3,n),"high":close+np.abs(np.random.randn(n))*0.3,"low":close-np.abs(np.random.randn(n))*0.3,"close":close,"volume":np.random.uniform(1000,5000,n)})
ok = []
for name, fn in sorted(INDICATOR_DISPATCH.items()):
    try:
        r = fn(df, {})
        ok.append("OK" if "error" not in r else f"ERR:{r.get('error','?')}")
    except Exception as e:
        ok.append(f"EX:{type(e).__name__}")
import json
with open(r"E:\\Workplace\\CloddsBot\\docs\\smoke_12indicators.json", "w") as f:
    json.dump({"dispatch": len(INDICATOR_DISPATCH), "results": {name: s for name, s in zip(sorted(INDICATOR_DISPATCH.keys()), ok)}}, f)
