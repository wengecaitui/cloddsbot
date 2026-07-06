"""quant_engine/indicators/volume_profile.py
Volume Profile (kv4coins) — Phase 5 Tick 数据层就位后正式回归

批次: P1
数据依赖: OHLCV K 线（近似版）→ Tick{price, qty, side}（精确版 via Phase 5 Bitget WS）

参数:
  lookback: int — 回看 K 线数量 (default=200)
  bins: int — 价格分桶数 (default=30)
  value_area_pct: float — Value Area 覆盖成交量比例 (default=0.7)
  ticks: list[dict] — 逐笔数据 [{price, qty, side}] (Phase 5, optional)
    ticks 不为空时自动走精确版；否则走 K 线近似版。
"""
from typing import Dict, Any, List
import numpy as np
import pandas as pd


def _profile_from_ticks(ticks: List[Dict], bins: int = 30, value_area_pct: float = 0.7) -> dict:
    """VP 精确版：逐笔 Tick 数据直接分配到价格 bins"""
    if not ticks:
        return {"error": "ticks 为空"}

    prices = [t["price"] for t in ticks]
    qties = [t["qty"] for t in ticks]
    sides = [t.get("side", "buy") for t in ticks]

    min_p = min(prices)
    max_p = max(prices)
    step = (max_p - min_p) / bins if max_p > min_p else 0.01
    if step == 0:
        step = 0.01

    bin_vol = np.zeros(bins)
    bin_delta = np.zeros(bins)  # buy - sell

    for price, qty, side in zip(prices, qties, sides):
        idx = int((price - min_p) / step)
        idx = max(0, min(bins - 1, idx))
        bin_vol[idx] += qty
        bin_delta[idx] += qty if side == "buy" else -qty

    total = bin_vol.sum()
    if total == 0:
        return {"error": "总成交量为零"}

    poc_idx = int(np.argmax(bin_vol))
    poc_price = min_p + (poc_idx + 0.5) * step
    poc_vol = float(bin_vol[poc_idx])

    cum = 0
    left = poc_idx - 1
    right = poc_idx + 1
    target = total * value_area_pct
    vah_idx, val_idx = poc_idx, poc_idx
    while cum < target and (left >= 0 or right < bins):
        lv = bin_vol[left] if left >= 0 else -1
        rv = bin_vol[right] if right < bins else -1
        if lv >= rv and left >= 0:
            vah_idx = left
            cum += bin_vol[left]
            left -= 1
        elif right < bins:
            val_idx = right
            cum += bin_vol[right]
            right += 1
        else:
            break

    vah = min_p + (vah_idx + 1) * step
    val = min_p + val_idx * step
    vwap = float(np.average(prices, weights=qties))

    return {
        "profile": [
            {"price_low": round(min_p + i * step, 4),
             "price_high": round(min_p + (i + 1) * step, 4),
             "volume": round(float(bin_vol[i]), 2),
             "delta": round(float(bin_delta[i]), 2),
             "is_poc": i == poc_idx}
            for i in range(bins) if bin_vol[i] > 0
        ],
        "poc": round(float(poc_price), 4),
        "poc_volume": round(float(poc_vol), 2),
        "vah": round(float(vah), 4),
        "val": round(float(val), 4),
        "vwap": round(float(vwap), 4),
        "total_volume": round(float(total), 2),
        "ticks_used": len(ticks),
        "method": "tick_exact",
    }


def _profile_from_ohlcv(df: pd.DataFrame, lookback: int, bins: int, value_area_pct: float) -> dict:
    """VP 近似版：K 线 OHLC 重建价位分布"""
    if len(df) < lookback:
        return {"error": f"数据不足，需要 {lookback} 根 K 线"}

    sub = df.tail(lookback)
    highs = sub["high"].values
    lows = sub["low"].values
    closes = sub["close"].values
    volumes = sub["volume"].values

    min_p = np.min(lows)
    max_p = np.max(highs)
    step = (max_p - min_p) / bins if max_p > min_p else 0.01
    if step == 0:
        step = 0.01

    bin_vol = np.zeros(bins)
    for i in range(len(sub)):
        idx = int((closes[i] - min_p) / step)
        idx = max(0, min(bins - 1, idx))
        bin_vol[idx] += volumes[i]

    total = bin_vol.sum()
    if total == 0:
        return {"error": "成交量为零"}

    poc_idx = int(np.argmax(bin_vol))
    poc_price = min_p + (poc_idx + 0.5) * step
    poc_vol = float(bin_vol[poc_idx])

    cum = 0
    left = poc_idx - 1
    right = poc_idx + 1
    target = total * value_area_pct
    vah_idx, val_idx = poc_idx, poc_idx
    while cum < target and (left >= 0 or right < bins):
        lv = bin_vol[left] if left >= 0 else -1
        rv = bin_vol[right] if right < bins else -1
        if lv >= rv and left >= 0:
            vah_idx = left
            cum += bin_vol[left]
            left -= 1
        elif right < bins:
            val_idx = right
            cum += bin_vol[right]
            right += 1
        else:
            break

    vah = min_p + (vah_idx + 1) * step
    val = min_p + val_idx * step
    vwap = float(np.sum(closes * volumes) / total)

    return {
        "profile": [
            {"price_low": round(min_p + i * step, 4),
             "price_high": round(min_p + (i + 1) * step, 4),
             "volume": round(float(bin_vol[i]), 2),
             "delta": 0,
             "is_poc": i == poc_idx}
            for i in range(bins) if bin_vol[i] > 0
        ],
        "poc": round(float(poc_price), 4),
        "poc_volume": round(float(poc_vol), 2),
        "vah": round(float(vah), 4),
        "val": round(float(val), 4),
        "vwap": round(float(vwap), 4),
        "total_volume": round(float(total), 2),
        "method": "ohlcv_approximate",
        "note": "K 线近似版 — 精确版需 Phase 5 Tick 数据",
    }


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Volume Profile 入口 — 自动派发：
    1. 如果 params 包含 ticks（非空） → 精确逐笔版
    2. 否则 → K 线 OHLCV 近似版
    """
    lookback = int(params.get("lookback", 200))
    bins = int(params.get("bins", 30))
    value_area_pct = float(params.get("value_area_pct", 0.7))
    ticks: List[Dict] = params.get("ticks", [])

    if ticks:
        result = _profile_from_ticks(ticks, bins, value_area_pct)
    else:
        result = _profile_from_ohlcv(df, lookback, bins, value_area_pct)

    if "error" in result:
        return {"name": "VolumeProfile", **result}

    return {
        "name": "VolumeProfile",
        **result,
        "bins": int(bins),
        "value_area_pct": value_area_pct,
        "lag_bars": 0,
    }


def calculate_from_ticks(ticks: List[Dict], bins: int = 30, value_area_pct: float = 0.7) -> Dict[str, Any]:
    """直接调用精确版（从 TS 侧传入 ticks 时用）"""
    result = _profile_from_ticks(ticks, bins, value_area_pct)
    if "error" in result:
        return {"name": "VolumeProfile", **result}
    return {"name": "VolumeProfile", **result, "bins": bins, "value_area_pct": value_area_pct, "lag_bars": 0}
