"""quant_engine/indicators/__init__.py
P0 + P1 指标注册入口"""

from quant_engine.indicators.stc import calculate as calc_stc
from quant_engine.indicators.stochastic import calculate as calc_stochastic
from quant_engine.indicators.mean_reversion import calculate as calc_mean_reversion
from quant_engine.indicators.trend_impulse import calculate as calc_trend_impulse

# 别名（用于 daemon.py 兼容）
calc_stochastic_overlay = calc_stochastic

from typing import Dict, Any

P1_INDICATORS: Dict[str, Any] = {
    "STC": calc_stc,
    "StochasticOverlay": calc_stochastic_overlay,
    "MeanReversion": calc_mean_reversion,
    "TrendImpulse": calc_trend_impulse,
}


from quant_engine.indicators.elliott_wave import calculate as calc_elliott_wave
from quant_engine.indicators.fibonacci import calculate as calc_fibonacci
from quant_engine.indicators.sr_range import calculate as calc_sr_range
from quant_engine.indicators.deltaflow import calculate as calc_deltaflow

P2_INDICATORS: Dict = {
    "ElliottWave": calc_elliott_wave,
    "FibonacciEntryBands": calc_fibonacci,
    "SRRange": calc_sr_range,
    "DeltaFlow": calc_deltaflow,
}
