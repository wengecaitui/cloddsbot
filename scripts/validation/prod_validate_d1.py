"""
健康检查脚本：验证 TradingAgents adapter + Graph 初始化 + SlowPipeline
"""
import sys, os, time, json

sys.path.insert(0, "E:/Workplace/CloddsBot")
from quant_engine.tradingagents_adapter import get_graph, handle_analyze, handle_health, handle_version

print("=" * 60)
print("Phase D — Infrastructure Fix Validation")
print("=" * 60)

# 1. adapter import check
print("\n[1] Adapter import: OK")

# 2. HEALTH
h = handle_health()
print(f"[2] HEALTH: {h}")
assert h["success"] is True

# 3. VERSION
v = handle_version()
print(f"[3] VERSION: {v}")
assert v["success"] is True
assert v["adapter_version"] == "1.0.0"

# 4. Graph instantiation (slow — loads TA once)
print("\n[4] Graph instantiation (may take 10-30s on first load)...")
t0 = time.time()
g = get_graph()
g_init_ms = (time.time() - t0) * 1000
print(f"    Graph init time: {g_init_ms:.0f}ms")
print(f"    Config provider: {g.config.get('llm_provider', '?')}")
print(f"    Config deep_model: {g.config.get('deep_think_llm', '?')}")

# 5. PING via main loop
print("\n[5] PING via piped stdin...")
import subprocess
proc = subprocess.run(
    [sys.executable, "quant_engine/tradingagents_adapter.py"],
    input='{"type":"PING","correlationId":"probe","payload":{}}\\n',
    capture_output=True, text=True, timeout=10, cwd="E:/Workplace/CloddsBot"
)
ping_resp = json.loads(proc.stdout.strip())
print(f"    PING response: {ping_resp}")
assert ping_resp["success"] is True
assert ping_resp.get("pong") is True
assert ping_resp["correlationId"] == "probe"

# 6. Real ANALYZE — NVDA (short test, timeout 120s)
print("\n[6] Real ANALYZE — NVDA (timeout=120s)...")
symbol = "NVDA"
start = time.time()
try:
    result = handle_analyze({"symbol": symbol})
    elapsed = (time.time() - start) * 1000
    print(f"    Elapsed: {elapsed:.0f}ms")
    if result["success"]:
        r = result["report"]
        print(f"    symbol: {r['assets'][0]['symbol']}")
        print(f"    direction: {r['assets'][0]['direction']}")
        print(f"    confidence: {r['assets'][0]['confidence']}")
        print(f"    globalBias: {r['globalBias']}")
        print(f"    meta.source: {r['meta']['source']}")
        print(f"    meta.generationTimeMs: {r['meta']['generationTimeMs']}")
        print(f"    degraded: {r.get('_degraded', False)}")
        print("    ✅ ANALYZE succeeded")
    else:
        print(f"    ❌ ANALYZE failed: {result.get('error')}")
except Exception as e:
    print(f"    ❌ Exception: {e}")

print("\n" + "=" * 60)
print("Phase D Validation Complete")
print("=" * 60)
