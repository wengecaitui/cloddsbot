"""Phase 4 闭环 smoke test — 14 个指标全跑 + P3 复合输出"""
import sys, json
sys.path.insert(0, "E:\\Workplace\\CloddsBot")

import pandas as pd
import numpy as np
from quant_engine.daemon import INDICATOR_DISPATCH
from quant_engine.indicators import P3_INDICATORS

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

print(f"DISPATCH: {len(INDICATOR_DISPATCH)}")
print(f"P3: {list(P3_INDICATORS.keys())}\n")

results = {}
for name, fn in sorted(INDICATOR_DISPATCH.items()):
    try:
        r = fn(df, {})
        ok = "OK" if "error" not in r else f"ERR: {r.get('error','?')}"
        results[name] = ok
    except Exception as e:
        results[name] = f"EX:{type(e).__name__}"
    print(f"  {'✅' if results[name]=='OK' else '❌'} {name}: {results[name]}")

ok = sum(1 for v in results.values() if v == "OK")
print(f"\n✅ 通过: {ok}/{len(results)}")

# P3 复合输出验证
print("\n=== P3 复合输出接口验证 ===")
cm = P3_INDICATORS["CompositeMomentum"](df, {"reset_inst": True})
print(f"CompositeMomentum:")
print(f"  composite_score: {cm.get('composite_score')}")
print(f"  regime_state: {cm.get('regime_state')}")
print(f"  in_cooldown: {cm.get('in_cooldown')}")
print(f"  dims: {list(cm.get('dimension_scores', {}).keys())}")

sob = P3_INDICATORS["SmartOrderBlock"](df, {
    "reset_inst": True,
    "vah": float(df["close"].max() * 1.01),
    "val": float(df["close"].min() * 0.99),
    "regime_state": "STRONG_BULLISH",
})
print(f"\nSmartOrderBlock:")
print(f"  has_active_ob: {sob.get('has_active_ob')}")
print(f"  ob_strength_weight: {sob.get('ob_strength_weight')}")
print(f"  nearest_bullish_ob: {sob.get('nearest_bullish_ob')}")
print(f"  bridge_signal: {sob.get('phase3_bridge_signal', {})}")

# 写入验证结果
with open(r"E:\Workplace\CloddsBot\docs\smoke_14indicators.json", "w") as f:
    json.dump({
        "dispatch": len(INDICATOR_DISPATCH),
        "passed": ok,
        "total": len(results),
        "p3_composite_score": cm.get("composite_score"),
        "p3_bridge_confluence": sob.get("phase3_bridge_signal", {}).get("confluence_triggered"),
    }, f, ensure_ascii=False, indent=2)
print("\n✅ 验证结果写入 docs/smoke_14indicators.json")
