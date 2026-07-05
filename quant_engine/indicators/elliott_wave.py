"""quant_engine/indicators/elliott_wave.py
Elliott Wave [LuxAlgo] — pivot 检测 + Strict_Lag_Offset

批次: P2 | 难度: 🟡 | 数据依赖: OHLCV
关键约束: 必须 Strict_Lag_Offset — pivot 检测延迟 right bars
"""
from typing import Dict, Any
import numpy as np
import pandas as pd


def _find_pivots(series: pd.Series, left: int, right: int) -> tuple:
    """检测 pivot 高/低点 — 严格滞后 right bars 才能确认"""
    pivots_high = []
    pivots_low = []
    n = len(series)
    for i in range(left, n - right):
        window_left = series.iloc[i - left:i]
        window_right = series.iloc[i + 1:i + right + 1]
        center = series.iloc[i]
        if center > window_left.max() and center > window_right.max():
            pivots_high.append((i, center))
        if center < window_left.min() and center < window_right.min():
            pivots_low.append((i, center))
    return pivots_high, pivots_low


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Elliott Wave [LuxAlgo] 简化版
    
    参数:
        pivot_left: int — 左侧 bars 用于确认 pivot
        pivot_right: int — 右侧 bars 用于确认 pivot (Strict_Lag_Offset)
        wave_length: int — 波浪长度过滤
    """
    pivot_left = int(params.get("pivot_left", 5))
    pivot_right = int(params.get("pivot_right", 5))
    wave_length = int(params.get("wave_length", 8))
    
    if len(df) < pivot_left + pivot_right + 2:
        return {"error": f"数据不足，需要至少 {pivot_left + pivot_right + 2} 根 K 线"}
    
    high = df["high"]
    low = df["low"]
    close = df["close"]
    
    pivots_high, pivots_low = _find_pivots(high, pivot_left, pivot_right)
    pivots_low_h, pivots_low_l = _find_pivots(low, pivot_left, pivot_right)
    
    # 简化波浪标记: 5-wave 顺势 + 3-wave 修正
    # 这里实现 pivot 序列识别 + 波浪计数
    all_pivots = sorted([(i, p, "H") for i, p in pivots_high] + 
                        [(i, p, "L") for i, p in pivots_low_l], key=lambda x: x[0])
    
    # 识别最近波浪
    if len(all_pivots) < 4:
        return {
            "name": "ElliottWave",
            "pivot_count": len(all_pivots),
            "wave_pattern": "INSUFFICIENT_PIVOTS",
            "trend": "NEUTRAL",
            "position": "HOLD",
            "lag_bars": pivot_right  # Strict_Lag_Offset
        }
    
    # 最近 4 个 pivot 判断波浪形态
    recent = all_pivots[-4:]
    pivots_seq = [p[2] for p in recent]
    
    # 5-wave 顺势: H>L>H>L>H (上升趋势) 或 L>H>L>H>L (下降趋势)
    # 3-wave 修正: H>L>H (下跌) 或 L>H>L (上涨)
    wave_pattern = "UNCLEAR"
    trend = "NEUTRAL"
    position = "HOLD"
    
    if len(recent) >= 4:
        # 检查是否顺势 5-wave
        if pivots_seq == ["L", "H", "L", "H"]:
            # 上升 5-wave 进行中
            if recent[-1][1] > recent[-2][1]:
                wave_pattern = "IMPULSE_UP"
                trend = "BULL"
                position = "LONG"
        elif pivots_seq == ["H", "L", "H", "L"]:
            if recent[-1][1] < recent[-2][1]:
                wave_pattern = "IMPULSE_DOWN"
                trend = "BEAR"
                position = "SHORT"
        elif pivots_seq == ["L", "H", "L"]:
            wave_pattern = "CORRECTION_DOWN"
            trend = "BEAR"
            position = "SHORT"
        elif pivots_seq == ["H", "L", "H"]:
            wave_pattern = "CORRECTION_UP"
            trend = "BULL"
            position = "LONG"
    
    # 波长过滤
    if wave_pattern != "UNCLEAR" and len(recent) >= 2:
        avg_wave = abs(recent[-1][0] - recent[-2][0])
        if avg_wave < wave_length:
            wave_pattern = wave_pattern + "_SHORT"
    
    return {
        "name": "ElliottWave",
        "pivot_count": len(all_pivots),
        "recent_pattern": "-".join(pivots_seq[-4:]),
        "wave_pattern": wave_pattern,
        "trend": trend,
        "position": position,
        "pivot_right": pivot_right,
        "lag_bars": pivot_right,  # Strict_Lag_Offset — pivot 必须 right bars 后才能确认
        "note": "Strict_Lag_Offset: 每个.pivot 确认延迟 pivot_right bars"
    }
