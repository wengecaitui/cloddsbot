#!/usr/bin/env python3
"""
quant_engine/benchmark.py
Phase 4.4: Bridge 基准测试 (Python 原生版本)
通过子进程 spawn daemon.py，测试管道延迟与稳定性

Usage:
  python quant_engine/benchmark.py
"""

import subprocess
import json
import time
import sys
import os
import numpy as np
from typing import List, Dict, Any

# ─── 配置 ───────────────────────────────────────────────────────────────────
DAEMON_PATH = os.path.join(os.path.dirname(__file__), "daemon.py")
CONCURRENCY_LEVELS = [10, 50, 100]
REQUESTS_PER_LEVEL = 50
SERIES_LENGTH = 100
TIMEOUT_S = 2.0

# ─── 工具函数 ───────────────────────────────────────────────────────────────

def make_mock_series(count: int) -> List[Dict]:
    base = 67000.0
    return [
        {
            "open": base + i * 10.0,
            "high": base + i * 10.0 + 50.0,
            "low": base + i * 10.0 - 50.0,
            "close": base + i * 10.0 + 20.0,
            "volume": 1.5 + i * 0.1
        }
        for i in range(count)
    ]


def percentile(data: List[float], p: float) -> float:
    if not data:
        return 0.0
    arr = sorted(data)
    k = (len(arr) - 1) * (p / 100.0)
    f = int(k)
    c = f + 1 if f + 1 < len(arr) else f
    d = k - f
    return arr[f] + d * (arr[c] - arr[f])


# ─── Daemon 进程管理器 ───────────────────────────────────────────────────────

class DaemonManager:
    def __init__(self):
        self.process: subprocess.Popen | None = None

    def start(self) -> bool:
        self.process = subprocess.Popen(
            [sys.executable, DAEMON_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}
        )
        # 等待 PONG
        start = time.time()
        while time.time() - start < 2.0:
            line = self.process.stdout.readline()
            if not line:
                return False
            try:
                resp = json.loads(line.strip())
                if resp.get("type") == "PONG":
                    return True
            except json.JSONDecodeError:
                continue
        return False

    def send(self, payload: Dict) -> Dict:
        assert self.process and self.process.stdin
        cid = payload.get("correlationId", "unknown")
        self.process.stdin.write((json.dumps(payload) + "\n").encode())
        self.process.stdin.flush()

        start = time.time()
        while time.time() - start < TIMEOUT_S:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("Daemon died")
            try:
                resp = json.loads(line.strip())
                if resp.get("correlationId") == cid:
                    return resp
            except json.JSONDecodeError:
                continue
        raise TimeoutError(f"Timeout waiting for {cid}")

    def stop(self):
        if self.process:
            try:
                self.process.stdin.close()
                self.process.terminate()
                self.process.wait(timeout=2)
            except:
                self.process.kill()


# ─── 压测逻辑 ───────────────────────────────────────────────────────────────

def run_benchmark():
    print("🚀 Phase 4.4 Bridge Benchmark (Python Native)")
    print(f"   Daemon: {DAEMON_PATH}")
    print(f"   并发: {CONCURRENCY_LEVELS}")
    print(f"   每级请求: {REQUESTS_PER_LEVEL} × 并发数")
    print()

    daemon = DaemonManager()
    if not daemon.start():
        print("❌ Daemon 启动失败")
        sys.exit(1)
    print("✅ Daemon 启动成功\n")

    results = []

    for level in CONCURRENCY_LEVELS:
        print(f"{'═' * 60}")
        print(f"🔬 并发级别: {level}")
        latencies = []
        successes = 0
        failures = 0

        # 分批发请求
        batch_size = level
        batches = (REQUESTS_PER_LEVEL + batch_size - 1) // batch_size

        for b in range(batches):
            tasks = []
            for i in range(batch_size):
                idx = b * batch_size + i
                if idx >= REQUESTS_PER_LEVEL:
                    break

                req = {
                    "type": "CALC",
                    "correlationId": f"bench_{level}_{idx}",
                    "asset": f"BTC/USDT_{idx}",
                    "series": make_mock_series(SERIES_LENGTH),
                    "indicators": [
                        {"name": "HullSuite", "params": {"period": 9}},
                        {"name": "ChandelierExit", "params": {"length": 22, "mult": 3.0}},
                        {"name": "UTBotAlerts", "params": {"keyPass": 2.0, "atrPeriod": 10}}
                    ]
                }

                start = time.time()
                try:
                    resp = daemon.send(req)
                    elapsed = (time.time() - start) * 1000
                    latencies.append(elapsed)
                    successes += 1
                except Exception as e:
                    failures += 1
                    print(f"  ⚠️  请求失败 [{idx}]: {str(e)[:80]}")

            # 批次间小憩
            if b < batches - 1:
                time.sleep(0.01)

        # 统计
        p50 = percentile(latencies, 50) if latencies else 0
        p95 = percentile(latencies, 95) if latencies else 0
        p99 = percentile(latencies, 99) if latencies else 0
        p_max = max(latencies) if latencies else 0
        avg = sum(latencies) / len(latencies) if latencies else 0

        results.append({
            "level": level,
            "total": REQUESTS_PER_LEVEL,
            "success": successes,
            "failed": failures,
            "p50": round(p50, 2),
            "p95": round(p95, 2),
            "p99": round(p99, 2),
            "max": round(p_max, 2),
            "avg": round(avg, 2)
        })

        # 阈值判断
        if p99 > 50:
            status = "🔴 超阈值"
        elif p99 > 30:
            status = "🟡 警告"
        else:
            status = "🟢 正常"
        print(f"  P50={p50:.1f}ms  P95={p95:.1f}ms  P99={p99:.1f}ms  Max={p_max:.1f}ms  {status}")

    # ── 报告 ───────────────────────────────────────────────────────────────
    print(f"\n{'═' * 80}")
    print("📊 Bridge Benchmark 报告")
    print(f"{'═' * 80}")
    print(f"{'并发':>6} | {'总请求':>6} | {'成功':>6} | {'失败':>6} | {'P50(ms)':>8} | {'P95(ms)':>8} | {'P99(ms)':>8} | {'Max(ms)':>8} | {'Avg(ms)':>8} | 状态")
    print("-" * 90)

    for r in results:
        status = "🔴 超阈值" if r["p99"] > 50 else "🟡 警告" if r["p99"] > 30 else "🟢 正常"
        print(f"{r['level']:>6} | {r['total']:>6} | {r['success']:>6} | {r['failed']:>6} | {r['p50']:>8.2f} | {r['p95']:>8.2f} | {r['p99']:>8.2f} | {r['max']:>8.2f} | {r['avg']:>8.2f} | {status}")

    # 结论
    worst_p99 = max(r["p99"] for r in results) if results else 0
    print(f"\n📋 结论:")
    if worst_p99 > 50:
        print(f"🔴 P99 峰值 {worst_p99:.1f}ms > 50ms 阈值 → 立即启动 Phase 4.4b 进程池改造")
    elif worst_p99 > 30:
        print(f"🟡 P99 峰值 {worst_p99:.1f}ms > 30ms 警告线 → 监控并发 100 表现")
    else:
        print(f"🟢 P99 峰值 {worst_p99:.1f}ms 在正常范围内 (< 30ms)")

    daemon.stop()
    print("\n✅ Phase 4.4 Bridge Benchmark 完成")
    return results


if __name__ == "__main__":
    run_benchmark()
