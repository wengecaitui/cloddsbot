"""Phase A + B validation — 直接调用 adapter 函数，不通过 stdin"""
import sys, os, time, json
sys.path.insert(0, "E:/Workplace/CloddsBot")

# 从 adapter 顶层导入（会触发 .env 加载）
print("=" * 60)
print("Phase A — Provider Verification (import-time)")
print("=" * 60)

from quant_engine.tradingagents_adapter import (
    get_graph, handle_analyze, handle_health, handle_version,
    ADAPTER_VERSION, _ta_root, _ta_env_file
)

# 检查 .env 是否加载成功
print(f"\n[env] _ta_root = {_ta_root}")
print(f"[env] _ta_env_file exists: {os.path.isfile(_ta_env_file) if _ta_env_file else False}")

# Phase B — HEALTH / VERSION / PING (直接调用函数)
print(f"\n{'=' * 60}")
print("Phase B — Adapter Sanity (direct function calls)")
print(f"{'=' * 60}")

# HEALTH
h = handle_health()
print(f"\n[HEALTH] {json.dumps(h, indent=2)}")
assert h["success"] is True
assert h["metadata"]["adapter_version"] == "1.0.0"
print("  ✅ HEALTH passed")

# VERSION
v = handle_version()
print(f"\n[VERSION] {json.dumps(v, indent=2)}")
assert v["success"] is True and v["adapter_version"] == "1.0.0"
print("  ✅ VERSION passed")

# PING
p = handle_ping()
print(f"\n[PING] {json.dumps(p, indent=2)}")
assert p["success"] is True and p["pong"] is True
print("  ✅ PING passed")

# Phase C — Graph init (会触发 TA .env 读入验证)
print(f"\n{'=' * 60}")
print("Phase C — Graph Initialization")
print(f"{'=' * 60}")
t0 = time.time()
try:
    g = get_graph()
    elapsed = (time.time() - t0) * 1000
    print(f"\n[Graph] init time: {elapsed:.0f}ms")
    print(f"[Graph] provider: {g.config.get('llm_provider')}")
    print(f"[Graph] deep_model: {g.config.get('deep_think_llm')}")
    print(f"[Graph] backend_url: {g.config.get('backend_url')}")
    print("  ✅ Graph initialized successfully")
except Exception as e:
    print(f"\n❌ Graph init FAILED: {e}")
    import traceback
    traceback.print_exc()

print(f"\n{'=' * 60}")
print("Phases A-C Complete")
print(f"{'=' * 60}")
