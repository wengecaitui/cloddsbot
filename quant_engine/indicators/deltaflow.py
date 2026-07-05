"""
DeltaFlow [LuxAlgo] — 成交量动量累积指标
Pine 源: DeltaFlow Volume 渲染为正/负成交量差值的 SMA-累加
P2 批次 | Strict_Lag_Offset: pivot 高低点滞后 right=period
"""
from typing import Dict, Any
import pandas as pd
import numpy as np


def _pivot_highs(series: pd.Series, left: int, right: int) -> pd.Series:
    """严格滞后 pivot 检测：右窗口保证未来不串入。"""
    out = pd.Series(False, index=series.index)
    vals = series.values
    for i in range(left, len(vals) - right):
        if np.isnan(vals[i]):
            continue
        if vals[i] == np.nanmax(vals[i-left:i+right+1]) and vals[i] > vals[i-1]:
            out.iloc[i] = True
    return out


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    DeltaFlow: 成交量差分动量，跨 pivot 高点做信号。
    params:
      - period: 均线窗口 (default 14)
      - pivot_left: pivot 左窗口 (default 5)
      - pivot_right: pivot 右窗口 (default 5)  ← Strict_Lag_Offset
    """
    period = int(params.get("period", 14))
    pivot_left = int(params.get("pivot_left", 5))
    pivot_right = int(params.get("pivot_right", 5))
    strict_lag_offset = int(params.get("strict_lag_offset", pivot_right))

    if len(df) < max(period, pivot_left + pivot_right + 1) + 2:
        return {"error": f"数据不足，需要至少 {pivot_left+pivot_right+3} 根 K 线"}

    if "volume" not in df.columns or df["volume"].sum() == 0:
        return {"error": "DeltaFlow 需要非零 volume 列"}

    # 1) 成交量差分动量: bar-up 时 +vol, bar-down 时 -vol
    direction = np.sign(df["close"].diff().fillna(0))
    delta_vol = direction * df["volume"]
    delta_smooth = delta_vol.rolling(period, min_periods=1).mean()

    # 2) pivot 高点检测（带 strict_lag_offset 防未来函数）
    pivots = _pivot_highs(delta_smooth, pivot_left, pivot_right + strict_lag_offset)
    # 可用 pivot 必须发生在 (len - strict_lag_offset) 之前
    usable_idx = pivots.index[:len(pivots) - strict_lag_offset]
    usable_pivots = pivots.loc[usable_idx]

    # 3) 信号生成：最新可用 pivot 之后 delta 由正转负 → SELL；由负转正 → BUY
    signal = "HOLD"
    if usable_pivots.any():
        last_pivot_pos = int(np.where(usable_pivots.values)[0][-1])
        recent_delta = delta_smooth.iloc[last_pivot_pos:]
        if len(recent_delta) >= 2:
            latest_delta = float(recent_delta.iloc[-1])
            prev_delta = float(recent_delta.iloc[-2])
            if latest_delta > 0 and prev_delta <= 0:
                signal = "BUY"
            elif latest_delta < 0 and prev_delta >= 0:
                signal = "SELL"

    latest_delta_val = float(delta_smooth.iloc[-1])

    return {
        "name": "DeltaFlow",
        "period": period,
        "delta_smooth": round(latest_delta_val, 4),
        "direction": "UP" if latest_delta_val > 0 else ("DOWN" if latest_delta_val < 0 else "FLAT"),
        "signal": signal,
        "pivot_count": int(usable_pivots.sum()),
        "strict_lag_offset": strict_lag_offset,
        "lag_bars": strict_lag_offset,
    }
