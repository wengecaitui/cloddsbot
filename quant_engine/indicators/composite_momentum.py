"""
quant_engine/indicators/composite_momentum.py
Indicator 13 — CompositeMomentumIndicator (动量复合矩阵指标)
Phase 4 收尾 | 正交权重矩阵 + 5态状态机 + 迟滞容错 + Cooldown

设计借鉴: TradingView TradeIQ / Comprehensive Toolkit 的高维聚合思路
硬核重构: Python 原生性能 + 防未来函数强制性 shift(1) + 正交感之三轴:

  维度A (35%): HullSuite 大周期趋势背景      — t-1 已收盘
  维度B (35%): STC 中短期动量摆动 + StochRSI   — t-1 已收盘
  维度C (30%): 成交量 > MA(20)*1.5 微观动能    — 允许当前 bar

输出:
  indicator_13_momentum >> {
    composite_score, regime_state, in_cooldown
  }
"""
from typing import Dict, Any, Optional, Tuple
import pandas as pd
import numpy as np


class CompositeMomentumIndicator:
    """动量复合矩阵指标 — 类封装，含迟滞状态机 + 冷却计数器"""

    def __init__(self):
        # 迟滞: 低分辨率入场，高分辨率出场（防震荡）
        self._last_regime: str = "NEUTRAL"
        self._cooldown_counter: int = 0
        # 冷却期 (bars)
        self.COOLDOWN_BARS = 5
        # 迟滞阈值
        self.HYSTERESIS = {
            "STRONG_BULLISH": {"enter": 80, "exit": 65},
            "WEAK_BULLISH":   {"enter": 55, "exit": 45},
            "NEUTRAL":        {"enter": 45, "exit": 45},
            "WEAK_BEARISH":   {"enter": 20, "exit": 30},
            "STRONG_BEARISH": {"enter":  0, "exit": 20},
        }

    # ─── 内部: 维度评分 (均用 t-1 数据) ─────────────────────────────────

    def _score_dimension_a(self, df: pd.DataFrame, hull_params: Dict) -> Tuple[float, str]:
        """维度A (35%): HullSuite 大周期趋势背景 ─ 强制 t-1"""
        if len(df) < 2:
            return 0.0, "NEUTRAL"
        # 用 daemon.py 中的 calc_hull_suite 逻辑一致，只取 t-1
        period = int(hull_params.get("period", 200))
        if len(df) < period + 5:
            return 0.0, "NEUTRAL"
        close = df["close"].values
        # 取 t-1 数据
        pre_close = close[:-1]
        if len(pre_close) < period + 5:
            return 0.0, "NEUTRAL"

        # WMA 辅助
        def _wma(series: np.ndarray, p: int) -> np.ndarray:
            weights = np.arange(1, p + 1, dtype=float)
            weights /= weights.sum()
            pad = np.full(p - 1, np.nan)
            return np.concatenate([pad, np.convolve(series, weights[::-1], mode="valid")])

        # Hull Suite @ t-1
        pre_series = pd.Series(pre_close)
        half_p = int(period / 2)
        sqrt_p = int(np.ceil(np.sqrt(period)))
        wma1 = _wma(pre_close, half_p)
        wma2 = _wma(pre_close, period)
        hull_pre = np.full(len(pre_close), np.nan)
        valid_len = min(len(wma1), len(wma2))
        if valid_len > sqrt_p:
            hull_raw = 2 * wma1[-valid_len:] - wma2[-valid_len:]
            hull_arr = _wma(hull_raw, sqrt_p) if len(hull_raw) > sqrt_p else hull_raw
            if len(hull_arr) >= 2:
                trend = "BULLISH" if hull_arr[-1] > hull_arr[-2] else "BEARISH"
            else:
                trend = "NEUTRAL"
        else:
            trend = "NEUTRAL"
        score = 35.0 if trend == "BULLISH" else 0.0
        return score, trend

    def _score_dimension_b(self, df: pd.DataFrame, stc_params: Dict) -> Tuple[float, str]:
        """维度B (35%): STC 中短期动量 + StochRSI 防顶背离 ─ 强制 t-1"""
        if len(df) < 2:
            return 0.0, "NEUTRAL"
        # STC @ t-1 (内联计算)
        fast = int(stc_params.get("fast", 23))
        slow = int(stc_params.get("slow", 50))
        cycle_val = int(stc_params.get("cycle", 10))
        d1 = int(stc_params.get("d1", 3))
        d2 = int(stc_params.get("d2", 3))
        close = df["close"].values
        pre = close[:-1]
        if len(pre) < slow + cycle_val + 5:
            return 0.0, "NEUTRAL"

        def _ema(arr: np.ndarray, span: int) -> np.ndarray:
            """纯 numpy EMA（逐元素）"""
            out = np.full_like(arr, np.nan, dtype=float)
            out[0] = arr[0]
            alpha = 2.0 / (span + 1)
            for i in range(1, len(arr)):
                out[i] = alpha * arr[i] + (1 - alpha) * out[i - 1]
            return out

        ema_f = _ema(pre, fast)
        ema_s = _ema(pre, slow)
        macd = ema_f - ema_s
        # 随机化 MACD
        stc_vals = np.full_like(macd, np.nan)
        for i in range(cycle_val - 1, len(macd)):
            window = macd[max(0, i - cycle_val + 1): i + 1]
            ll, hh = np.nanmin(window), np.nanmax(window)
            stc_vals[i] = 50.0 if hh == ll else (macd[i] - ll) / (hh - ll) * 100.0
        s_series = pd.Series(stc_vals)
        d_line = s_series.rolling(d1, min_periods=1).mean()
        stc_final = d_line.rolling(d2, min_periods=1).mean()

        stc_t_1 = float(stc_final.iloc[-2]) if len(stc_final.dropna()) >= 2 else 50.0
        stc_t_2 = float(stc_final.iloc[-3]) if len(stc_final.dropna()) >= 3 else stc_t_1
        stc_trend = "UPWARD" if stc_t_1 > stc_t_2 else "DOWNWARD"

        # StochRSI @ t-1 (简化版: 当前 close 的 RSI 再随机化)
        def _rsi(arr: np.ndarray, period: int = 14) -> float:
            if len(arr) < period + 1:
                return 50.0
            diffs = np.diff(arr[-period - 1:])
            gains = np.sum(diffs[diffs > 0])
            losses = -np.sum(diffs[diffs < 0])
            if losses == 0:
                return 100.0
            rs = gains / losses
            return 100.0 - 100.0 / (1 + rs)

        rsi_val = _rsi(pre)
        # StochRSI: (RSI - min_RSI_14) / (max_RSI_14 - min_RSI_14) * 100 → 简化: RSI 归一化
        stoch_rsi = max(0, min(100, (rsi_val - 20) / (80 - 20) * 100))

        # 打分: STC 向上趋势 && stc < 80 && StochRSI 未极值顶背离
        if stc_trend == "UPWARD" and stc_t_1 < 80 and stoch_rsi < 85:
            score = 35.0
            signal = "BULLISH"
        elif stc_trend == "DOWNWARD" and stc_t_1 > 20 and stoch_rsi > 15:
            score = 0.0
            signal = "BEARISH"
        else:
            score = 17.5
            signal = "NEUTRAL"
        return score, signal

    def _score_dimension_c(self, df: pd.DataFrame) -> Tuple[float, str]:
        """维度C (30%): Volume > MA(20)*1.5 微观动能 — 允许当前 bar"""
        if len(df) < 21:
            return 0.0, "WEAK"
        volume = df["volume"]
        vol_ma20 = volume.rolling(20, min_periods=1).mean().iloc[-1]
        latest_vol = volume.iloc[-1]
        if vol_ma20 <= 0:
            return 0.0, "WEAK"
        if latest_vol > vol_ma20 * 1.5:
            return 30.0, "STRONG"
        elif latest_vol > vol_ma20 * 1.2:
            return 15.0, "MODERATE"
        else:
            return 0.0, "WEAK"

    # ─── 状态机: 迟滞映射 + Cooldown ────────────────────────────────────

    def _map_regime(self, score: float) -> str:
        """基础 5 态映射（无迟滞）"""
        if score >= 80:   return "STRONG_BULLISH"
        if score >= 55:   return "WEAK_BULLISH"
        if score >= 45:   return "NEUTRAL"
        if score >= 20:   return "WEAK_BEARISH"
        return "STRONG_BEARISH"

    def _apply_hysteresis(self, score: float, prev_regime: str) -> str:
        """迟滞容错: 从 aggresive 状态退出时需更低阈值"""
        # 强→弱 降级
        if prev_regime == "STRONG_BULLISH" and score < 65:
            return "WEAK_BULLISH"
        if prev_regime == "STRONG_BEARISH" and score > 20:
            return "WEAK_BEARISH"
        # 其他: 正常映射
        candidate = self._map_regime(score)
        # 从弱→中性→弱 升级需达标
        if prev_regime == "WEAK_BULLISH" and candidate == "NEUTRAL" and score >= 45:
            return "WEAK_BULLISH"  # 保持
        if prev_regime == "WEAK_BEARISH" and candidate == "NEUTRAL" and score <= 55:
            return "WEAK_BEARISH"
        return candidate

    def calculate(self, df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
        """
        主入口: 计算 CompositeMomentum
        
        params:
          hull_period: Hull Suite 取样周期 (default 200)
          stc_fast / stc_slow / stc_cycle: STC 参数
          verbose: 是否输出各维度明细 (default False)
        """
        hull_period = int(params.get("hull_period", 200))
        stc_fast = int(params.get("stc_fast", 23))
        stc_slow = int(params.get("stc_slow", 50))
        stc_cycle = int(params.get("stc_cycle", 10))

        hull_params = {"period": hull_period}
        stc_params = {"fast": stc_fast, "slow": stc_slow, "cycle": stc_cycle}

        # 计算三维度得分
        score_a, trend_a = self._score_dimension_a(df, hull_params)
        score_b, sig_b = self._score_dimension_b(df, stc_params)
        score_c, vol_sig = self._score_dimension_c(df)
        composite = round(score_a + score_b + score_c, 1)

        # 冷却处理
        regime = "NEUTRAL"
        if self._cooldown_counter > 0:
            self._cooldown_counter -= 1
            # 冷却中保持原状态
            if self._last_regime != "NEUTRAL":
                regime = self._last_regime
            else:
                regime = self._map_regime(composite)
        else:
            candidate = self._apply_hysteresis(composite, self._last_regime)
            if candidate != self._last_regime:
                self._cooldown_counter = self.COOLDOWN_BARS
            regime = candidate

        self._last_regime = regime

        in_cooldown = self._cooldown_counter > 0

        result = {
            "composite_score": composite,
            "regime_state": regime,
            "in_cooldown": in_cooldown,
            "dimension_scores": {
                "hull_big_trend": {"score": score_a, "trend": trend_a},
                "stc_momentum":   {"score": score_b, "signal": sig_b},
                "volume_micro":   {"score": score_c, "strength": vol_sig},
            },
        }
        if params.get("verbose"):
            result["_debug"] = {
                "cooldown_remain": self._cooldown_counter,
                "prev_regime": self._last_regime,
            }
        return result


# ─── 模块级快捷计算函数（兼容 INDICATOR_DISPATCH） ────────────────────────

_global_inst = CompositeMomentumIndicator()


def calculate(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """模块级入口（自动复用全局实例的状态机）"""
    global _global_inst
    # 如果 params 含 reset=True 则新建实例（测试场景）
    if params.pop("reset_inst", False):
        _global_inst = CompositeMomentumIndicator()
    return _global_inst.calculate(df, params)
