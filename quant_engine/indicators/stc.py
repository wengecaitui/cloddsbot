"""
quant_engine/indicators/stc.py
P1 批次 — STC Indicator (Schaff Trend Cycle) (shayankm)

核心: MACD 的随机平滑

参数:
  fast: int (default=23)
  slow: int (default=50)
  cycle: int (default=10)
  d1: int (default=3)
  d2: int (default=3)
"""

import pandas as pd
import numpy as np
from typing import Dict, Any


def _ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    fast = int(params.get("fast", 23))
    slow = int(params.get("slow", 50))
    cycle = int(params.get("cycle", 10))
    d1 = int(params.get("d1", 3))
    d2 = int(params.get("d2", 3))

    if len(df) < slow + cycle + 5:
        return {"error": f"数据不足，需要 {slow + cycle + 5} 根 K 线"}

    close = df["close"]
    length = len(close)

    # MACD
    ema_fast = _ema(close, fast).values
    ema_slow = _ema(close, slow).values
    macd = ema_fast - ema_slow

    # Stochastic of MACD
    stc_vals = np.full(length, np.nan)
    for i in range(cycle - 1, length):
        window = macd[max(0, i - cycle + 1):i + 1]
        ll = np.min(window)
        hh = np.max(window)
        stc_vals[i] = 50.0 if hh == ll else (macd[i] - ll) / (hh - ll) * 100.0

    s = pd.Series(stc_vals)
    d_line = s.rolling(d1, min_periods=1).mean()
    stc_final = d_line.rolling(d2, min_periods=1).mean()

    latest = float(stc_final.iloc[-1]) if not np.isnan(stc_final.iloc[-1]) else 50.0
    prev = float(stc_final.iloc[-2]) if len(stc_final.dropna()) >= 2 else latest

    if prev <= 25 and latest > 25:
        signal = "BUY"
    elif prev >= 75 and latest < 75:
        signal = "SELL"
    else:
        signal = "HOLD"

    return {
        "name": "STC",
        "fast": fast, "slow": slow, "cycle": cycle,
        "stc": round(latest, 2),
        "signal": signal,
        "trend": "BULL" if latest > 50 else "BEAR",
        "lag_bars": 0
    }
