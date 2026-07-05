"""
quant_engine/indicators/trend_impulse.py
P1 批次 — Trend Impulse Channels (Zeiierman)

ATR 通道:
  SMA(close, period) ± mult * ATR(period)

参数:
  period: int (default=34)
  mult: float (default=2.0)
"""

import pandas as pd
import numpy as np
from typing import Dict, Any


def _atr(df: pd.DataFrame, period: int) -> pd.Series:
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - df["close"].shift(1)).abs(),
        (df["low"] - df["close"].shift(1)).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    period = int(params.get("period", 34))
    mult = float(params.get("mult", 2.0))

    if len(df) < period + 5:
        return {"error": f"数据不足，需要 {period + 5} 根 K 线"}

    close = df["close"]
    sma = close.rolling(period, min_periods=period).mean()
    atr = _atr(df, period)

    upper = sma + mult * atr
    lower = sma - mult * atr

    lc = float(close.iloc[-1])
    lu = float(upper.iloc[-1]) if not np.isnan(upper.iloc[-1]) else lc
    ll = float(lower.iloc[-1]) if not np.isnan(lower.iloc[-1]) else lc
    lm = float(sma.iloc[-1]) if not np.isnan(sma.iloc[-1]) else lc

    if lc > lu:
        zone, signal = "OVERBOUGHT", "BEAR"
    elif lc < ll:
        zone, signal = "OVERSOLD", "BULL"
    elif lc > lm:
        zone, signal = "BULL_ZONE", "BULL"
    else:
        zone, signal = "BEAR_ZONE", "BEAR"

    return {
        "name": "TrendImpulse",
        "period": period,
        "mult": mult,
        "close": lc,
        "upper": round(lu, 4),
        "mid": round(lm, 4),
        "lower": round(ll, 4),
        "zone": zone,
        "signal": signal,
        "lag_bars": 0
    }
