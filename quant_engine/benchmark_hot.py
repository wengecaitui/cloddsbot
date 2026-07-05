#!/usr/bin/env python3
"""
quant_engine/benchmark_hot.py
Phase 4.4 Bridge Benchmark — 热路径压测（ daemon 常驻，只测纯管道+计算延迟）

❌ 错误方法: 每次循环 spawn 新 daemon → 700ms 冷启动 × N
🟢 正确方法: 一次 spawn + 预热 + 高频复用 stdin/stdout → < 5ms

Usage:
  python quant_engine/benchmark_hot.py
"""

import subprocess, json, time, sys, os
from pathlib import Path

DAEMON = Path(__file__).parent / "daemon.py"
PY = r"C:\Users\Dujunyi\AppData\Local\Python\pythoncore-3.14-64\python.exe"  # 固定路径（Hermes venv 没有 pandas）
CWD = DAEMON.parent.parent

def make_series(n=100):
    return [{"open":67000+i*10,"high":67050+i*10,"low":66950+i*10,
             "close":67020+i*8,"volume":1.5+i*0.1} for i in range(n)]

INDICATORS = [
    {"name":"HullSuite","params":{"period":9}},
    {"name":"ChandelierExit","params":{"length":22,"mult":3.0}},
    {"name":"UTBotAlerts","params":{"keyPass":2.0,"atrPeriod":10}},
    {"name":"STC","params":{"fast":23,"slow":50,"cycle":10}},
    {"name":"StochasticOverlay","params":{"k":14,"d":3}},
    {"name":"MeanReversion","params":{"period":20,"stdMult":2.0}},
    {"name":"TrendImpulse","params":{"period":34,"mult":2.0}},
]

def percentile(sorted_data, p):
    if not sorted_data: return 0.0
    k = (len(sorted_data) - 1) * (p / 100.0)
    f = int(k); c = min(f + 1, len(sorted_data) - 1)
    return sorted_data[f] + (k - f) * (sorted_data[c] - sorted_data[f])

def main():
    print("=" * 60)
    print("Phase 4.4 Bridge Benchmark — 热路径压测")
    print("=" * 60)
    print(f"Daemon: {DAEMON}")
    print(f"Python: {PY}")
    print()

    # ── 1. 一次 spawn，daemon 常驻 ──────────────────────────────
    print("[1/4] 启动 daemon 常驻进程...")
    t_cold = time.time()
    proc = subprocess.Popen(
        [PY, str(DAEMON)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(CWD), bufsize=0,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    # 等 PONG
    while True:
        line = proc.stdout.readline().decode().strip()
        if not line:
            print("❌ daemon 启动失败"); proc.terminate(); sys.exit(1)
        try:
            if json.loads(line).get("type") == "PONG":
                break
        except: pass
    cold_ms = (time.time() - t_cold) * 1000
    print(f"  ✅ 冷启动 + PONG 握手: {cold_ms:.1f}ms（一次性开销，不计入热路径）")

    # ── 2. 预热：5 次 CALC 让 pandas/numpy JIT 缓存就位 ─────────
    print("\n[2/4] 预热 5 次（让 pandas/numpy 内部缓存就位）...")
    for i in range(5):
        p = json.dumps({"type":"CALC","correlationId":f"warm_{i}","asset":"BTC/USDT",
                        "series":make_series(),"indicators":INDICATORS[:3]}) + "\n"
        proc.stdin.write(p.encode()); proc.stdin.flush()
        proc.stdout.readline()
    print("  ✅ 预热完成")

    # ── 3. 热路径压测：100 次 CALC，只测管道+计算延迟 ──────────
    print("\n[3/4] 热路径压测: 100 次 CALC (7 指标)...")
    LOADS = 100
    times = []
    failures = 0
    t_start = time.time()

    for i in range(LOADS):
        cid = f"hot_{i:04d}"
        p = json.dumps({"type":"CALC","correlationId":cid,"asset":f"BTC_{i}",
                        "series":make_series(),"indicators":INDICATORS}) + "\n"
        t0 = time.time()
        proc.stdin.write(p.encode()); proc.stdin.flush()
        # 等对应 cid 的响应（可能前面有未读行，跳过）
        deadline = time.time() + 5
        while time.time() < deadline:
            line = proc.stdout.readline().decode().strip()
            if not line: break
            try:
                r = json.loads(line)
                if r.get("correlationId") == cid and r.get("type") == "CALC_RES":
                    times.append((time.time() - t0) * 1000)
                    break
            except: pass
        else:
            failures += 1

        if (i+1) % 20 == 0:
            avg = sum(times)/len(times) if times else 0
            print(f"  {i+1}/{LOADS}  avg={avg:.2f}ms  fail={failures}")

    t_total = (time.time() - t_start) * 1000

    # ── 4. 关闭 + 统计 ───────────────────────────────────────────
    proc.stdin.close(); proc.terminate(); proc.wait()

    if not times:
        print("\n❌ 无有效响应")
        sys.exit(1)

    times.sort()
    p50 = percentile(times, 50)
    p90 = percentile(times, 90)
    p95 = percentile(times, 95)
    p99 = percentile(times, 99)
    avg = sum(times) / len(times)
    throughput = LOADS / (t_total / 1000)

    print(f"\n{'=' * 60}")
    print(f"Phase 4.4 热路径压测结果")
    print(f"{'=' * 60}")
    print(f"  冷启动（一次性）:   {cold_ms:.1f}ms")
    print(f"  热路径 {LOADS} 次总耗时: {t_total:.1f}ms")
    print(f"  平均单次延迟:      {avg:.2f}ms")
    print(f"  P50={p50:.2f}ms  P90={p90:.2f}ms  P95={p95:.2f}ms  P99={p99:.2f}ms  Max={times[-1]:.2f}ms")
    print(f"  吞吐: {throughput:.0f} req/s")
    print(f"  成功率: {(len(times)/LOADS)*100:.1f}% ({len(times)}/{LOADS})")
    print(f"{'=' * 60}")
    verdict = "🟢 P99 < 50ms ✅ Phase 4.4 通过" if p99 < 50 else "🔴 P99 ≥ 50ms ⚠️ 触发 Phase 4.4b"
    print(f"判定: {verdict}")

    # 保存 JSON 报告
    report = {
        "test": "phase_4.4_hot_path",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "cold_start_ms": round(cold_ms, 2),
        "loads": LOADS,
        "p50_ms": round(p50, 2),
        "p90_ms": round(p90, 2),
        "p95_ms": round(p95, 2),
        "p99_ms": round(p99, 2),
        "max_ms": round(times[-1], 2),
        "avg_ms": round(avg, 2),
        "throughput_req_s": round(throughput, 0),
        "success_rate": f"{(len(times)/LOADS)*100:.1f}%",
        "verdict": "PASS" if p99 < 50 else "NEEDS_4_4b",
    }
    out = Path(CWD) / "docs" / "benchmarks" / "phase_4.4_hot_path.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n📄 报告已存: {out}")

if __name__ == "__main__":
    main()
