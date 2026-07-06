"""
quant_engine/indicators/volume_profile.py
Volume Profile (kv4coins) — Phase 5 Tick 数据层就位后正式回归

批次: P1 (原 P1，因 Tick 数据依赖搁置，现 Phase 5 就位后激活)
数据依赖: OHLCV K 线（当前近似版）→ Tick 数据（未来精确版）

参数:
  lookback: int — 回看 K 线数量 (default=200)
  bins: int — 价格分桶数 (default=30)
  value_area_pct: float — Value Area 覆盖成交量比例 (default=0.7)
"""
from typing import Dict, Any
import numpy as np
import pandas as pd


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Volume Profile 核心算法:
    1. 将价格区间分成 N 个 bins
    2. 将每根 K 线的成交量分配到对应价格 bin
    3. 计算 POC (Point of Control) — 成交量最高的 bin
    4. 计算 VAH/VAL (Value Area High/Low) — 覆盖 70% 成交量的价格区间

    注意: 当前版本基于 K 线 OHLC 近似，不等价于逐笔 Tick 级 VP。
    Phase 5 接入 Tick 数据后，可替换为精确版本。
    """
    lookback = int(params.get("lookback", 200))
    bins = int(params.get("bins", 30))
    value_area_pct = float(params.get("value_area_pct", 0.7))

    if len(df) < lookback:
        return {"error": f"数据不足，需要 {lookback} 根 K 线", "name": "VolumeProfile"}

    sub = df.tail(lookback)
    highs = sub["high"].values
    lows = sub["low"].values
    closes = sub["close"].values
    volumes = sub["volume"].values

    # 构建价格区间
    min_price = np.min(lows)
    max_price = np.max(highs)
    step = (max_price - min_price) / bins if max_price > min_price else 0.01

    # 分桶：计算每个 bin 的累计成交量
    bin_volumes = np.zeros(bins)
    for i in range(len(sub)):
        # 用 close 作为该 bar 的参考价（可优化为 TP/SMA）
        price = closes[i]
        vol = volumes[i]
        bin_idx = int((price - min_price) / step)
        bin_idx = max(0, min(bins - 1, bin_idx))
        bin_volumes[bin_idx] += vol

    total_volume = bin_volumes.sum()
    if total_volume == 0:
        return {"error": "成交量为零", "name": "VolumeProfile"}

    # POC — 成交量最高的 bin
    poc_idx = int(np.argmax(bin_volumes))
    poc_price = min_price + (poc_idx + 0.5) * step
    poc_volume = float(bin_volumes[poc_idx])

    # VAH/VAL — 从 POC 向两侧扩展，直到覆盖 value_area_pct 成交量
    cum_volume = 0
    vah_idx = poc_idx
    val_idx = poc_idx
    target = total_volume * value_area_pct

    # 向两侧扩展（贪婪法：每次加体积最大的相邻 bin）
    left = poc_idx - 1
    right = poc_idx + 1
    while cum_volume < target and (left >= 0 or right < bins):
        left_vol = bin_volumes[left] if left >= 0 else -1
        right_vol = bin_volumes[right] if right < bins else -1
        if left_vol >= right_vol and left >= 0:
            vah_idx = left
            cum_volume += bin_volumes[left]
            left -= 1
        elif right < bins:
            val_idx = right
            cum_volume += bin_volumes[right]
            right += 1
        else:
            break

    vah = min_price + (vah_idx + 1) * step
    val = min_price + val_idx * step
    vwap = np.sum(closes * volumes) / total_volume

    return {
        "name": "VolumeProfile",
        "lookback": lookback,
        "bins": int(bins),
        "poc": round(float(poc_price), 4),
        "poc_volume": round(float(poc_volume), 2),
        "vah": round(float(vah), 4),
        "val": round(float(val), 4),
        "vwap": round(float(vwap), 4),
        "total_volume": round(float(total_volume), 2),
        "value_area_pct": value_area_pct,
        "profile": [
            {
                "price_low": round(min_price + i * step, 4),
                "price_high": round(min_price + (i + 1) * step, 4),
                "volume": round(float(bin_volumes[i]), 2),
                "pct": round(float(bin_volumes[i] / total_volume * 100), 2),
            }
            for i in range(bins)
            if bin_volumes[i] > 0
        ],
        "lag_bars": 0,
        "note": "Phase 5: OHLCV 近似版，精确版需 Tick 数据",
    }
