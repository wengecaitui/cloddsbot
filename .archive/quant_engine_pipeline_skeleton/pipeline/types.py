"""
quant_engine/pipeline/types.py
快慢分道架构的核心数据类型
"""
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional
import time


# ─── 慢道产物: MarketBiasReport ────────────────────────────────────────

@dataclass
class MarketBiasReport:
    """慢道 4 Analyst → Debate → Manager 产出的市场偏向报告
    
    通过 FastBiasCache 单向注入给 FastPipeline, 严禁反向流动
    """
    # 核心决策
    bias: str = "NEUTRAL"            # BULLISH | BEARISH | NEUTRAL
    confidence: float = 50.0         # 0~100
    regime_state: str = "NEUTRAL"    # STRONG_BULLISH | WEAK_BULLISH | NEUTRAL | WEAK_BEARISH | STRONG_BEARISH
    
    # 实体抽取
    support_levels: List[float] = field(default_factory=list)
    resistance_levels: List[float] = field(default_factory=list)
    suggested_track: str = "IDLE"    # FAST_TRACK | SLOW_TRACK | IDLE
    
    # 元信息
    version: int = 0                 # 版本号, 每次更新 +1 (lock-free 校验)
    timestamp: float = field(default_factory=time.time)
    rationale: str = ""               # Manager 的综合理由 (debug 用)
    raw_manager_output: Optional[Dict[str, Any]] = None  # 完整 Manager JSON


# ─── 快道产物: FastSignal ──────────────────────────────────────────────

@dataclass
class FastSignal:
    """快道单次 13ms 周期的输出信号"""
    # 触发判断
    should_execute: bool = False     # 是否触发交易
    side: Optional[str] = None      # BUY | SELL (None = 不交易)
    
    # 14 指标脱水输出 (composite score + regime)
    composite_score: float = 0.0    # Indicator 13 输出
    indicator_regime: str = "NEUTRAL"  # Indicator 13 输出 (5-态)
    has_active_ob: bool = False      # Indicator 14 输出
    ob_strength_weight: float = 0.0  # Indicator 14 输出
    
    # 来自 bias cache 的快照 (零拷贝读)
    bias_snapshot_version: int = 0
    bias_snapshot_age_s: float = 0.0
    
    # 性能元信息
    cycle_elapsed_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)
    
    # 14 指标的全部原始输出 (供 audit)
    indicator_outputs: Dict[str, Any] = field(default_factory=dict)


# ─── 慢道内部: SlowReport ─────────────────────────────────────────────

@dataclass
class SlowReport:
    """慢道单次 60s 周期的完整报告"""
    bias_report: MarketBiasReport
    cycle_elapsed_s: float = 0.0
    analysts_timings: Dict[str, float] = field(default_factory=dict)
    debate_elapsed_s: float = 0.0
    manager_elapsed_s: float = 0.0
    error: Optional[str] = None
    timestamp: float = field(default_factory=time.time)
