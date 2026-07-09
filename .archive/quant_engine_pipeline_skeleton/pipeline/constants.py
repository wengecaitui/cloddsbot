"""
quant_engine/pipeline/constants.py
快慢分道架构的阈值常量
"""

# ─── Fast Pipeline ────────────────────────────────────────────
FAST_CYCLE_TARGET_MS = 13        # 快道周期目标 (毫秒)
FAST_CYCLE_ALARM_MS = 50         # 快道 P99 告警阈值 (毫秒)
FAST_BIAS_CACHE_TTL_S = 60       # 快道 cache 过期阈值 (秒)
FAST_BIAS_CACHE_STALE_S = 120    # 快道 cache 严重过期阈值 (秒)

# ─── Slow Pipeline ───────────────────────────────────────────
SLOW_CYCLE_S = 60                # 慢道周期 (秒)
SLOW_TIMEOUT_S = 90              # 慢道单次执行超时 (秒), >40s 真实 + 余量
SLOW_ERROR_BACKOFF_S = 30        # 慢道失败后回退间隔 (秒)
SLOW_MAX_CONSECUTIVE_ERRORS = 3  # 连续失败上限, 超过则告警

# ─── Dehydrator 模式标记 ─────────────────────────────────────
DEHYD_MODE = "dehydrated"        # 脱水模式标记 (传入 indicator.calculate.params)
NO_LLM_MODE = "no_llm"           # 双重标记, 防御性编程

# ─── 状态机 ──────────────────────────────────────────────────
STATE_BIAS_STALE_SEC = 60        # bias 超过这个时间视为 STALE
STATE_BIAS_EXPIRED_SEC = 120     # bias 超过这个时间视为 EXPIRED
STATE_BIAS_DEAD_SEC = 300        # bias 超过这个时间视为 DEAD (快道停止交易)
