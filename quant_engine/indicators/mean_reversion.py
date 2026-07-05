"""
quant_engine/indicators/mean_reversion.py
P1 批次 — Mean Reversion Probability Zones (BigBeluga)

统计驱动的均值回归:
  z_score = (close - rolling_mean) / rolling_std
  prob = 0.5 * (1 + tanh(z / sqrt(2/pi)))  ~  概率 CDF

参数:
  period: int (default=20)
  std_mult: float (default=2.0)
"""

import pandas as pd
import numpy as np
from typing import Dict, Any


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    period = int(params.get("period", 20))
    std_mult = float(params.get("stdMult", 2.0))

    if len(df) < period + 2:
        return {"error": f"数据不足，需要 {period + 2} 根 K 线"}

    close = df["close"]
    rm = close.rolling(period, min_periods=period).mean()
    rs = close.rolling(period, min_periods=period).std(ddof=0)

    z = (close - rm) / rs.replace(0, np.nan)
    prob = 0.5 * (1.0 + np.tanh(z / np.sqrt(2.0 / np.pi)))

    latest_z = float(z.iloc[-1]) if not np.isnan(z.iloc[-1]) else 0.0
    latest_p = float(prob.iloc[-1]) if not np.isnan(prob.iloc[-1]) else 0.5

    if latest_p < 0.15:
        zone, signal = "OVERSOLD", "BUY"
    elif latest_p > 0.85:
        zone, signal = "OVERBOUGHT", "SELL"
    else:
        zone, signal = "NEUTRAL", "HOLD"

    return {
        "name": "MeanReversion",
        "period": period,
        "std_mult": std_mult,
        "z_score": round(latest_z, 4),
        "probability": round(latest_p, 4),
        "zone": zone,
        "close": round(float(close.iloc[-1]), 4),
        "signal": signal,
        "lag_bars": 0
    }
