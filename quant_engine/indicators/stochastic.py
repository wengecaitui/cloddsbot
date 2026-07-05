"""
quant_engine/indicators/stochastic.py
P1 批次 — Stochastic Overlay (Zeiierman)

随机振荡器: 
  %K = (close - lowest_low) / (highest_high - lowest_low) * 100
  %D = SMA(%K, D)

参数:
  k_period: int (default=14)
  d_period: int (default=3)
"""

import pandas as pd
import numpy as np
from typing import Dict, Any


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    k_period = int(params.get("k", 14))
    d_period = int(params.get("d", 3))

    if len(df) < max(k_period, d_period) + 2:
        return {"error": f"数据不足，需要 {max(k_period, d_period) + 2} 根 K 线"}

    high = df["high"]
    low = df["low"]
    close = df["close"]

    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    range_val = highest_high - lowest_low

    k_line = (close - lowest_low) / range_val.replace(0, np.nan) * 100.0
    d_line = k_line.rolling(d_period, min_periods=1).mean()

    latest_k = float(k_line.iloc[-1]) if not np.isnan(k_line.iloc[-1]) else 50.0
    latest_d = float(d_line.iloc[-1]) if not np.isnan(d_line.iloc[-1]) else 50.0

    if latest_k > 80:
        zone = "OVERBOUGHT"
        signal = "SELL" if latest_k < latest_d else "WATCH"
    elif latest_k < 20:
        zone = "OVERSOLD"
        signal = "BUY" if latest_k > latest_d else "WATCH"
    else:
        zone = "NEUTRAL"
        signal = "HOLD"

    return {
        "name": "StochasticOverlay",
        "k_period": k_period,
        "d_period": d_period,
        "k": round(latest_k, 2),
        "d": round(latest_d, 2),
        "zone": zone,
        "signal": signal,
        "lag_bars": 0
    }
