
import sys, json
sys.path.insert(0, "E:\\Workplace\\CloddsBot")
import pandas as pd
import numpy as np
from quant_engine.indicators.volume_profile import calculate_from_ticks
from quant_engine.daemon import INDICATOR_DISPATCH

# VP 精确版
ticks = [{"price": 67450 + float(np.random.uniform(-100,100)), "qty": float(np.random.uniform(0.001,0.5)), "side": "buy" if np.random.random()>0.5 else "sell"} for _ in range(2000)]
vp = calculate_from_ticks(ticks)
print("VP_EXACT:", json.dumps({"poc": vp.get("poc"), "method": vp.get("method"), "ticks": vp.get("ticks_used"), "bins": len(vp.get("profile",[]))}, default=str))

# OHLCV mock
np.random.seed(42); n = 200
close = 100 + np.cumsum(np.random.randn(n)*0.5)
df = pd.DataFrame({"open": close+np.random.uniform(-0.3,0.3,n),"high": close+np.abs(np.random.randn(n))*0.3,"low": close-np.abs(np.random.randn(n))*0.3,"close": close,"volume": np.random.uniform(1000,5000,n)})

# VP 近似
vp2 = INDICATOR_DISPATCH["VolumeProfile"](df, {"lookback": 180})
print("VP_OHLCV:", json.dumps({"poc": vp2.get("poc"), "method": vp2.get("method"), "bins": len(vp2.get("profile",[]))}, default=str))

# 12 指标全跑
ok = sum(1 for name,fn in INDICATOR_DISPATCH.items() if "error" not in fn(df,{}))
print(f"DISPATCH: {len(INDICATOR_DISPATCH)} / OK: {ok}/{len(INDICATOR_DISPATCH)}")
