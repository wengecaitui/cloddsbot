"""
quant_engine/indicators/smart_order_block.py
Indicator 14 — SmartOrderBlockIndicator (智能订单块追踪)
Phase 4 收尾 | 基于 Phase 4.5 VP Tick 设施的机构足迹捕获

核心算法:
  1. OB 识别: price > VAH + tick_imbalance > 1.5 + volume spike → BullishOB
  2. OB 管理: base_price_range / init_vol / ts / test_count / status / weight
  3. 衰减: test_count>=3 → DEPRECATED；半衰期 20 bars 权重衰减
  4. 匹配最近上下方 active OB

防未来函数:
  - VAH/VAL 来自已收盘的 VP 快照（t-1 的 profile）
  - Tick imbalance 和 volume 允许当前 bar 切片
  - OB 形成后 bar index 冻结

输出:
  indicator_14_order_block >> {
    has_active_ob, nearest_bullish_ob, nearest_bearish_ob, ob_strength_weight
  }
  phase3_bridge_signal >> {
    confluence_triggered, suggested_track
  }
"""
from typing import Dict, Any, List, Optional, Tuple
import pandas as pd
import numpy as np
from dataclasses import dataclass, field


# ─── OB 数据类 ──────────────────────────────────────────────────────────────

@dataclass
class OrderBlock:
    """单个订单块"""
    base_price_low: float
    base_price_high: float
    init_volume: float
    formation_bar: int          # bar index (冻结，防未来函数)
    timestamp: float
    side: str                   # "bullish" | "bearish"
    test_count: int = 0
    status: str = "ACTIVE"      # ACTIVE | DEPRECATED
    weight: float = 1.0

    def is_active(self) -> bool:
        return self.status == "ACTIVE" and self.weight > 0.05


# ─── 主类 ───────────────────────────────────────────────────────────────────

class SmartOrderBlockIndicator:
    """智能订单块追踪指标 — 状态机封装"""

    def __init__(self, half_life_bars: int = 20, min_imbalance: float = 1.5):
        self.blocks: List[OrderBlock] = []
        self.half_life = half_life_bars
        self.min_imbalance = min_imbalance
        self._bar_counter = 0
        # 缓存上一个 VP profile
        self._prev_vah: Optional[float] = None
        self._prev_val: Optional[float] = None

    # ─── OB 识别 ─────────────────────────────────────────────────────────

    def _detect_breakout(self, df: pd.DataFrame, ticks: List[Dict]) -> bool:
        """
        检测突破条件:
          1. close > VAH (来自 VP 的 t-1 数据)
          2. tick_imbalance > min_imbalance
          3. 当前 bar volume > MA(vol,20)*1.5
          返回 True 表示当前 bar 形成一个新 OB
        """
        if self._prev_vah is None or self._prev_val is None:
            return False
        if len(df) < 21:
            return False

        latest = df.iloc[-1]
        close = float(latest["close"])
        high = float(latest["high"])
        low = float(latest["low"])
        vol = float(latest["volume"])

        # Vol spike
        vol_ma20 = float(df["volume"].rolling(20, min_periods=1).mean().iloc[-1])
        if vol_ma20 <= 0 or vol < vol_ma20 * 1.5:
            return False

        # Tick imbalance
        if ticks:
            buy_qty = sum(t.get("qty", 0) for t in ticks if t.get("side") == "buy")
            sell_qty = sum(t.get("qty", 0) for t in ticks if t.get("side") == "sell")
            imbalance = buy_qty / max(sell_qty, 1e-8)
            has_imbalance = imbalance > self.min_imbalance
            direction = "bullish" if (buy_qty > sell_qty and close > high * 0.98) else "bearish"
        else:
            has_imbalance = False
            direction = "bullish"

        # 放量突破 VAH → Bullish OB
        if close > self._prev_vah and has_imbalance:
            return True
        # 放量跌破 VAL → Bearish OB
        if low < self._prev_val and has_imbalance:
            return True
        return False

    def _test_existing_obs(self, df: pd.DataFrame):
        """回踩检测: 检查当前 bar 是否测试已有 OB"""
        if len(df) < 1:
            return
        latest = df.iloc[-1]
        close = float(latest["close"])
        low = float(latest["low"])
        high = float(latest["high"])

        for ob in self.blocks:
            if not ob.is_active():
                continue
            # 价格回踩到 OB 区间内
            if ob.side == "bullish" and low <= ob.base_price_high and close > ob.base_price_low:
                ob.test_count += 1
                if ob.test_count >= 3:
                    ob.status = "DEPRECATED"
            elif ob.side == "bearish" and high >= ob.base_price_low and close < ob.base_price_high:
                ob.test_count += 1
                if ob.test_count >= 3:
                    ob.status = "DEPRECATED"
        # 清理过期
        self.blocks = [b for b in self.blocks if b.weight > 0.01]

    def _decay_weights(self, current_bar: int):
        """半衰期权重衰减"""
        for ob in self.blocks:
            bars_since = current_bar - ob.formation_bar
            if bars_since <= 0:
                continue
            ob.weight = 1.0 * (0.5 ** (bars_since / self.half_life))
            if ob.weight < 0.05 and ob.status == "ACTIVE":
                ob.status = "DEPRECATED"

    def _nearest_obs(self, close: float) -> Tuple[Optional[List[float]], Optional[List[float]], float]:
        """找最近上下方 active OB"""
        bullish: List[OrderBlock] = [b for b in self.blocks if b.side == "bullish" and b.is_active()]
        bearish: List[OrderBlock] = [b for b in self.blocks if b.side == "bearish" and b.is_active()]

        # 下方最近 Bullish OB (支撑)
        nearest_bull = None
        for b in sorted(bullish, key=lambda x: x.base_price_high, reverse=True):
            if b.base_price_high < close:
                nearest_bull = b
                break

        # 上方最近 Bearish OB (压力)
        nearest_bear = None
        for b in sorted(bearish, key=lambda x: x.base_price_low):
            if b.base_price_low > close:
                nearest_bear = b
                break

        bull_range = [nearest_bull.base_price_low, nearest_bull.base_price_high] if nearest_bull else None
        bear_range = [nearest_bear.base_price_low, nearest_bear.base_price_high] if nearest_bear else None

        # 综合权重: 最近 OB 的权重的最大值
        weights = [b.weight for b in [nearest_bull, nearest_bear] if b]
        ob_weight = max(weights) if weights else 0.0

        return bull_range, bear_range, round(ob_weight, 4)

    # ─── Phase 3 桥接信号 ────────────────────────────────────────────────

    def _phase3_signal(self, regime: str, close: float, bull_ob: Optional[List[float]]) -> Tuple[bool, str]:
        """
        confluence_triggered: 强动量 + 价格靠近 OB 支撑位
        FAST_TRACK: 突破追单 (close > bull_ob_high 且 regime 强)
        SLOW_TRACK: 左侧埋伏 (price pullback to bull_ob_low 且 regime 强)
        IDLE: 其余
        """
        is_strong = regime in ("STRONG_BULLISH", "STRONG_BEARISH")
        if not is_strong:
            return False, "IDLE"

        if regime == "STRONG_BULLISH" and bull_ob:
            if close > bull_ob[1]:
                return True, "FAST_TRACK"
            elif bull_ob[0] <= close <= bull_ob[1]:
                return True, "SLOW_TRACK"
        return False, "IDLE"

    # ─── 主入口 ──────────────────────────────────────────────────────────

    def calculate(self, df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
        """
        主入口: 计算 SmartOrderBlock

        params:
          vah / val: 来自 Phase 4.5 VP 的 VAH/VAL（t-1 已收盘数据）
          vp_profile: VolumeProfile 输出 (可选, 含 vah/val/poc)
          ticks: [{price, qty, side}, ...] — 当前 bar 的逐笔数据
          regime_state: CompositeMomentum 的 regime (Phase 3 桥接用)
          half_life: 半衰期 bar 数 (default 20)
          min_imbalance: 最小买卖失衡比 (default 1.5)
        """
        vah = params.get("vah")
        val = params.get("val")
        if vah is None and val is None:
            vp = params.get("vp_profile", {})
            vah = vp.get("vah")
            val = vp.get("val")
        ticks: List[Dict] = params.get("ticks", [])
        regime = params.get("regime_state", "NEUTRAL")
        half_life = int(params.get("half_life", self.half_life))
        min_imb = float(params.get("min_imbalance", self.min_imbalance))

        # 更新半衰期 + 最低失衡比（运行时可调）
        self.half_life = half_life
        self.min_imbalance = min_imb

        # 冻结 VP 快照
        if vah is not None and val is not None:
            self._prev_vah = float(vah)
            self._prev_val = float(val)

        self._bar_counter += 1
        current_bar = self._bar_counter

        # 1) 检测新 OB
        if self._detect_breakout(df, ticks):
            latest = df.iloc[-1]
            new_ob = OrderBlock(
                base_price_low=float(latest.get("ob_low", self._prev_val)) if self._prev_val else float(latest["low"]),
                base_price_high=float(latest.get("ob_high", self._prev_vah)) if self._prev_vah else float(latest["high"]),
                init_volume=float(latest["volume"]),
                formation_bar=current_bar,
                timestamp=float(latest.get("timestamp", 0)),
                side="bullish" if (self._prev_vah and float(latest["close"]) > self._prev_vah) else "bearish",
            )
            self.blocks.append(new_ob)

        # 2) 测试已有 OB
        self._test_existing_obs(df)

        # 3) 权重衰减
        self._decay_weights(current_bar)

        # 4) 匹配最近 OB
        close = float(df["close"].iloc[-1])
        bull_ob, bear_ob, ob_weight = self._nearest_obs(close)

        active_obs = [b for b in self.blocks if b.is_active()]
        has_active = len(active_obs) > 0

        # 5) Phase 3 桥接信号
        confluence, track = self._phase3_signal(regime, close, bull_ob)

        return {
            "has_active_ob": has_active,
            "nearest_bullish_ob": bull_ob,
            "nearest_bearish_ob": bear_ob,
            "ob_strength_weight": ob_weight,
            "total_obs": len(self.blocks),
            "active_obs": len(active_obs),
            "phase3_bridge_signal": {
                "confluence_triggered": confluence,
                "suggested_track": track,
            },
        }


# ─── 模块级快捷计算函数（兼容 INDICATOR_DISPATCH） ────────────────────────

_global_ob_inst = SmartOrderBlockIndicator()


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """模块级入口（自动复用全局实例的状态机）"""
    global _global_ob_inst
    if params.pop("reset_inst", False):
        _global_ob_inst = SmartOrderBlockIndicator()
    return _global_ob_inst.calculate(df, params)
