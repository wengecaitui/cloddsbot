"""
Support & Resistance Range [LuxAlgo]
基于 pivot swing points + ATR 构建动态支撑阻力区间
P2 批次 | Strict_Lag_Offset: swing pivot 延迟 right=period 才能确认
"""
from typing import Dict, Any
import pandas as pd
import numpy as np


def _atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """平均真实波幅"""
    high, low, close = df["high"], df["low"], df["close"]
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low - close.shift(1)).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period, min_periods=1).mean()


def _find_swing_highs(high: pd.Series, left: int, right: int) -> pd.Series:
    """严格滞后 swing high 检测"""
    out = pd.Series(False, index=high.index)
    vals = high.values
    for i in range(left, len(vals) - right):
        if np.isnan(vals[i]):
            continue
        if vals[i] == np.nanmax(vals[i-left:i+right+1]):
            out.iloc[i] = True
    return out


def _find_swing_lows(low: pd.Series, left: int, right: int) -> pd.Series:
    """严格滞后 swing low 检测"""
    out = pd.Series(False, index=low.index)
    vals = low.values
    for i in range(left, len(vals) - right):
        if np.isnan(vals[i]):
            continue
        if vals[i] == np.nanmin(vals[i-left:i+right+1]):
            out.iloc[i] = True
    return out


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Support & Resistance Range
    基于 swing points + ATR 的动态支撑阻力区间
    
    params:
      - swing_left: swing pivot 左窗口 (default 3)
      - swing_right: swing pivot 右窗口 (default 3) — Strict_Lag_Offset
      - atr_multiplier: ATR 乘数，决定区间宽度 (default 1.0)
    """
    swing_left = int(params.get("swing_left", 3))
    swing_right = int(params.get("swing_right", 3))
    atr_mult = float(params.get("atr_multiplier", 1.0))

    if len(df) < swing_left + swing_right + 5:
        return {"error": "数据不足", "name": "SRRange"}

    high = df["high"]
    low = df["low"]
    close = df["close"]

    # 检测 swing points（带 lag）
    swing_highs = _find_swing_highs(high, swing_left, swing_right)
    swing_lows = _find_swing_lows(low, swing_left, swing_right)

    # 可用 swing 点（lag_offset 后）
    lag = swing_right
    valid_highs = swing_highs.iloc[:len(swing_highs) - lag] if lag > 0 else swing_highs
    valid_lows = swing_lows.iloc[:len(swing_lows) - lag] if lag > 0 else swing_lows

    # 取最近 swing 构建 S/R
    sr_levels = {"resistances": [], "supports": []}

    if valid_highs.any():
        high_idx = int(np.where(valid_highs.values)[0][-1])
        sr_levels["resistances"].append({
            "price": round(float(high.iloc[high_idx]), 4),
            "bar": high_idx,
            "strength": "STRONG" if high_idx < len(high) - 10 else "FRESH"
        })

    if valid_lows.any():
        low_idx = int(np.where(valid_lows.values)[0][-1])
        sr_levels["supports"].append({
            "price": round(float(low.iloc[low_idx]), 4),
            "bar": low_idx,
            "strength": "STRONG" if low_idx < len(low) - 10 else "FRESH"
        })

    # ATR 动态区间
    atr = float(_atr(df, 14).iloc[-1]) if len(df) >= 14 else 0.0
    latest = float(close.iloc[-1])
    
    resistance = sr_levels["resistances"][0]["price"] if sr_levels["resistances"] else latest + atr * 2
    support = sr_levels["supports"][0]["price"] if sr_levels["supports"] else latest - atr * 2
    
    return {
        "name": "SRRange",
        "resistance": round(resistance, 4),
        "support": round(support, 4),
        "midpoint": round((resistance + support) / 2, 4),
        "atr": round(atr, 4),
        "atr_multiplier": atr_mult,
        "signal": "BULLISH" if latest > (resistance + support) / 2 else "BEARISH",
        "position": "LONG" if latest < support + atr * 0.5 else (
                   "SHORT" if latest > resistance - atr * 0.5 else "HOLD"),
        "lag_bars": lag,
        "strict_lag_offset": lag,
        "sr_levels": sr_levels,
    }