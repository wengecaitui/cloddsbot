"""
Phase 3 — 快慢分道架构实现
========================================

核心设计:
  - SlowPipeline: 60s 周期，4 Analyst → Debate → Manager → MarketBiasReport
  - FastPipeline: 13ms 周期，14 指标纯脱水模式运行 (零 LLM 调用)
  - 单向注入: _FAST_BIAS_CACHE (lock-free atomic swap)
  - 慢道崩溃: 快道用过期 cache 继续服务，>60s 告警

文件结构:
  quant_engine/pipeline/
    __init__.py
    types.py             # 数据类型定义 (MarketBiasReport 等)
    fast_bias_cache.py   # 极速本地缓存 (lock-free atomic read)
    dehydrator.py        # 脱水器 (剥离 LLM 调用通道)
    fast_pipeline.py     # 快道 (13ms 周期, 14 指标脱水)
    slow_pipeline.py     # 慢道 (60s 周期, 4 Analyst → Debate → Manager)
    orchestrator.py      # 双轨编排器 (启动/停止/监控)
    constants.py         # 阈值常量
"""

# 本文件仅作为包入口，实际实现在同目录其他模块
from quant_engine.pipeline.types import MarketBiasReport, FastSignal, SlowReport
from quant_engine.pipeline.fast_bias_cache import FastBiasCache, get_cache
from quant_engine.pipeline.dehydrator import Dehydrator
from quant_engine.pipeline.fast_pipeline import FastPipeline
from quant_engine.pipeline.slow_pipeline import SlowPipeline
from quant_engine.pipeline.orchestrator import DualTrackOrchestrator

__all__ = [
    "MarketBiasReport",
    "FastSignal",
    "SlowReport",
    "FastBiasCache",
    "get_cache",
    "Dehydrator",
    "FastPipeline",
    "SlowPipeline",
    "DualTrackOrchestrator",
]
