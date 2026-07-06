"""
quant_engine/precision_tests/run_all.py
批量跑所有指标精度测试（Python 端计算 + 保存 CSV，供 TV 对比）

输出:
  docs/python_values/{indicator}.csv — 逐 bar Python 值
  docs/precision_reports/{indicator}.json — 待 TV 数据填充
"""
import sys, json, csv
sys.path.insert(0, ".")

import pandas as pd
import numpy as np
from pathlib import Path
from quant_engine.daemon import INDICATOR_DISPATCH

# 生成 mock OHLCV（与 TV 端相同 seed）
np.random.seed(42)
n = 200
close = 100 + np.cumsum(np.random.randn(n) * 0.5)
df = pd.DataFrame({
    "bar": range(n),
    "open": close + np.random.uniform(-0.3, 0.3, n),
    "high": close + np.abs(np.random.randn(n)) * 0.3,
    "low": close - np.abs(np.random.randn(n)) * 0.3,
    "close": close,
    "volume": np.random.uniform(1000, 5000, n),
})

# 输出目录
out_csv = Path("docs/python_values")
out_csv.mkdir(parents=True, exist_ok=True)
out_json = Path("docs/precision_reports")
out_json.mkdir(parents=True, exist_ok=True)

results = []
for name, fn in sorted(INDICATOR_DISPATCH.items()):
    try:
        r = fn(df, {})
        # 提取主要输出字段（signal/position/trend + 数值字段）
        csv_row = []
        for col in ["bar", "open", "high", "low", "close", "volume"]:
            csv_row.append(df[col].tolist())
        
        # 根据指标类型选择要导出的字段
        export_fields = []
        if "hma" in r: export_fields.append(("hma", r["hma"]))
        if "long_stop" in r: export_fields.append(("long_stop", r["long_stop"]))
        if "short_stop" in r: export_fields.append(("short_stop", r["short_stop"]))
        if "stc" in r: export_fields.append(("stc", r["stc"]))
        if "k" in r: export_fields.append(("k", r["k"]))
        if "z_score" in r: export_fields.append(("z_score", r["z_score"]))
        if "probability" in r: export_fields.append(("probability", r["probability"]))
        if "upper" in r: export_fields.append(("upper", r["upper"]))
        if "lower" in r: export_fields.append(("lower", r["lower"]))
        if "delta_smooth" in r: export_fields.append(("delta_smooth", r["delta_smooth"]))
        if "wave_pattern" in r: export_fields.append(("wave_pattern", r.get("wave_pattern", "")))
        if "entry_band_lower" in r: export_fields.append(("entry_band_lower", r["entry_band_lower"]))
        if "entry_band_upper" in r: export_fields.append(("entry_band_upper", r["entry_band_upper"]))
        if "resistance" in r: export_fields.append(("resistance", r["resistance"]))
        if "support" in r: export_fields.append(("support", r["support"]))
        
        # 写 CSV（单 bar，仅最新值用于结构模板）
        csv_path = out_csv / f"{name}.csv"
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["bar", "close"] + [f[0] for f in export_fields])
            w.writerow([n-1, round(float(df["close"].iloc[-1]), 6)] + [round(f[1], 6) for f in export_fields])
        
        # 写 JSON 报告模板（等待 TV 数据填充）
        report = {
            "indicator": name,
            "tolerance": 1e-6,
            "status": "PENDING_TV_DATA",
            "py_output": {k: v for k, v in r.items() if k not in ["name", "lag_bars", "note"]},
            "tv_values": None,
            "comparison": None,
        }
        json_path = out_json / f"{name}.json"
        with open(json_path, "w") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        
        results.append({"name": name, "csv": str(csv_path), "json": str(json_path), "status": "OK"})
        print(f"  ✅ {name}: {csv_path.name} + {json_path.name}")
    except Exception as e:
        results.append({"name": name, "status": f"ERR: {e}"})
        print(f"  ❌ {name}: {e}")

# 汇总
print(f"\n{'='*60}")
print(f"Phase 4.6 精度基准准备: {sum(1 for r in results if r['status']=='OK')}/{len(results)} 完成")
print(f"CSV: docs/python_values/  (TV 对比用)")
print(f"JSON: docs/precision_reports/ (待 TV 数据填充)")
print(f"{'='*60}")
