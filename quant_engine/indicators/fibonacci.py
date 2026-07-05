"""quant_engine/indicators/fibonacci.py
Fibonacci Entry Bands [LuxAlgo] — Strict_Lag_Offset
批次: P2 | 难度: 🟡 | 数据依赖: OHLCV
关键约束: 必须 Strict_Lag_Offset — swing pivot 确认延迟 right bars
"""
from typing import Dict, Any
import numpy as np
import pandas as pd


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Fibonacci Entry Bands [LuxAlgo]
    基于 Swing High/Low + Fibonacci 回调/延伸水平
    
    params:
      - lookback: 回看窗口 (default 30)
      - swing_left: 左侧 pivot 确认 bar (default 5)
      - swing_right: 右侧 pivot 确认 bar → Strict_Lag_Offset (default 5)
      - retracement: 回调深度 0.618 (default 0.618)
      - extension: 延伸目标 1.618 (default 1.618)
    """
    lookback = int(params.get("lookback", 30))
    swing_left = int(params.get("swing_left", 5))
    swing_right = int(params.get("swing_right", 5))
    retracement = float(params.get("retracement", 0.618))
    extension = float(params.get("extension", 1.618))

    if len(df) < lookback + swing_left + swing_right + 2:
        return {"error": f"数据不足，需要 {lookback + swing_left + swing_right + 2} 根 K 线"}

    high = df["high"].iloc[-lookback:]
    low = df["low"].iloc[-lookback:]
    close = df["close"]

    def find_swings(series: pd.Series, is_high: bool) -> list:
        vals = series.values
        swings = []
        for i in range(swing_left, len(vals) - swing_right):
            if np.isnan(vals[i]):
                continue
            if is_high and vals[i] == np.nanmax(vals[i-swing_left:i+swing_right+1]):
                swings.append((i, float(vals[i])))
            elif not is_high and vals[i] == np.nanmin(vals[i-swing_left:i+swing_right+1]):
                swings.append((i, float(vals[i])))
        return swings

    swing_highs = find_swings(high, True)
    swing_lows = find_swings(low, False)

    if len(swing_highs) < 1 or len(swing_lows) < 1:
        return {
            "name": "FibonacciEntryBands",
            "swing_highs": len(swing_highs),
            "swing_lows": len(swing_lows),
            "position": "HOLD",
            "lag_bars": swing_right
        }

    # 最近 swing high/low
    last_high_idx, last_high_price = swing_highs[-1]
    last_low_idx, last_low_price = swing_lows[-1]

    # 确定范围
    if last_high_idx > last_low_idx:
        # 上升趋势，从 last_low 开始
        direction = "UP"
        base = last_low_price
        top = last_high_price
    else:
        # 下降趋势，从 last_high 开始
        direction = "DOWN"
        base = last_high_price
        top = last_low_price

    swing_range = abs(top - base)
    if swing_range <= 0:
        return {"error": "swing range <= 0", "name": "FibonacciEntryBands"}

    # Fibonacci levels
    if direction == "UP":
        levels = {
            "0.0": base,
            "0.236": base + 0.236 * swing_range,
            "0.382": base + 0.382 * swing_range,
            "0.5": base + 0.5 * swing_range,
            "0.618": base + 0.618 * swing_range,
            "0.786": base + 0.786 * swing_range,
            "1.0": top,
            "1.618": base + 1.618 * swing_range,
        }
    else:
        levels = {
            "0.0": top,
            "0.236": top - 0.236 * swing_range,
            "0.382": top - 0.382 * swing_range,
            "0.5": top - 0.5 * swing_range,
            "0.618": top - 0.618 * swing_range,
            "0.786": top - 0.786 * swing_range,
            "1.0": base,
            "1.618": top - 1.618 * swing_range,
        }

    latest_close = float(close.iloc[-1])

    # Entry Band: 0.5 ~ 0.786
    entry_lower = levels["0.5"]
    entry_upper = levels["0.786"]
    in_band = entry_lower <= latest_close <= entry_upper

    return {
        "name": "FibonacciEntryBands",
        "direction": direction,
        "swing_high": round(last_high_price, 4),
        "swing_low": round(last_low_price, 4),
        "swing_range": round(swing_range, 4),
        "retracement": retracement,
        "extension": extension,
        "entry_band_lower": round(entry_lower, 4),
        "entry_band_upper": round(entry_upper, 4),
        "in_entry_band": in_band,
        "position": "BUY" if (in_band and direction == "UP") else (
                    "SELL" if (in_band and direction == "DOWN") else "HOLD"),
        "lag_bars": swing_right,  # Strict_Lag_Offset
        "note": f"Strict_Lag_Offset={swing_right}: swing pivot 延迟 {swing_right} bars"
    }