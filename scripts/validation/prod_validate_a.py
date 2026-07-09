"""
Phase A — Infrastructure Fix 验证
测试 adapter import、HEALTH、VERSION、PING、实时 ANALYZE
"""
import subprocess, json, time, os, sys

sys.path.insert(0, "E:/Workplace/CloddsBot")

print("=" * 60)
print("Phase A — Infrastructure Fix Verification")
print("=" * 60)

def run_adapter(raw_input, timeout=10):
    proc = subprocess.run(
        [sys.executable, "quant_engine/tradingagents_adapter.py"],
        input=raw_input, capture_output=True, text=True,
        timeout=timeout, cwd="E:/Workplace/CloddsBot"
    )
    try:
        return json.loads(proc.stdout.strip())
    except:
        return {"raw": proc.stdout.strip(), "stderr": proc.stderr.strip()}

# 1. Import check
print("\n[1] TA import check")
r = subprocess.run([sys.executable, "-c", "import tradingagents; print(tradingagents.__file__)"], capture_output=True, text=True)
print(f"    exit={r.returncode} out={r.stdout.strip()}")
assert r.returncode == 0, "TA import failed"

# 2. PING
print("\n[2] PING via adapter")
p = run_adapter('{"type":"PING","correlationId":"gate1-ping","payload":{}}\n')
print(f"    {p}")
assert p.get("pong") is True and p.get("success") is True

# 3. VERSION
print("\n[3] VERSION via adapter")
v = run_adapter('{"type":"VERSION","correlationId":"gate1-ver","payload":{}}\n')
print(f"    {v}")
assert v.get("adapter_version") == "1.0.0" and v.get("success") is True

# 4. HEALTH
print("\n[4] HEALTH via adapter")
h = run_adapter('{"type":"HEALTH","correlationId":"gate1-health","payload":{}}\n')
print(f"    {h}")
assert h.get("success") is True
assert h["metadata"]["adapter_version"] == "1.0.0"

# 5. Graph init + ANALYZE NVDA
print("\n[5] ANALYZE NVDA (may take 5-15 min on first run)...")
t0 = time.time()
try:
    a = run_adapter(
        '{"type":"ANALYZE","correlationId":"gate1-nvda","payload":{"symbol":"NVDA"}}\n',
        timeout=900
    )
    elapsed_ms = int((time.time() - t0) * 1000)
    print(f"    Elapsed: {elapsed_ms/1000:.1f}s")
    if a.get("success"):
        rpt = a.get("report", {})
        asset = rpt.get("assets", [{}])[0]
        print(f"    symbol: {asset.get('symbol')}")
        print(f"    direction: {asset.get('direction')}")
        print(f"    confidence: {asset.get('confidence')}")
        print(f"    globalBias: {rpt.get('globalBias')}")
        print(f"    meta.source: {rpt.get('meta', {}).get('source')}")
        print(f"    meta.generationTimeMs: {rpt.get('meta', {}).get('generationTimeMs')}")
        print(f"    degraded: {rpt.get('_degraded', False)}")
        print(f"    ✅ ANALYZE succeeded")
    else:
        print(f"    ❌ ANALYZE failed: {a.get('error')}")
except subprocess.TimeoutExpired:
    print("    ❌ ANALYZE timed out (15 min)")
except Exception as e:
    print(f"    ❌ Exception: {e}")

print("\n" + "=" * 60)
print("Phase A Complete")
print("=" * 60)
