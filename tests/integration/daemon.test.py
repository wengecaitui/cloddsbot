"""
tests/test_daemon.py — B方案: 独立测试脚本
通过 subprocess + stdin/stdout 验证 daemon 完整协议

运行:
    python tests/test_daemon.py            # 全套测试
    python tests/test_daemon.py -v        # 详细模式
"""
import sys
import os
import json
import time
import subprocess
import threading
import queue
import numpy as np
import pandas as pd
from typing import Dict, Any, List, Optional


# ─── 路径设置 ───────────────────────────────────────────────────────────────────

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAEMON_PATH = os.path.join(PROJECT_ROOT, "quant_engine", "daemon.py")
PYTHON = sys.executable


# ─── Daemon 进程封装（异步读 stdout 防死锁）────────────────────────────────────

class DaemonProc:
    """
    封装 daemon 子进程交互：
    - 启动后异步读取 stdout 到 queue，避免 buffer 满死锁
    - 提供 send(payload) 和 recv(timeout) 接口
    - 支持 PING 握手和 CALC 调用
    """
    
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.reader_thread: Optional[threading.Thread] = None
        self.stdout_q: queue.Queue = queue.Queue()
    
    def start(self, timeout: float = 5.0) -> str:
        """启动 daemon 并读取首行 PONG boot 握手"""
        self.proc = subprocess.Popen(
            [PYTHON, DAEMON_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        
        # 启动后台线程读 stdout
        self.reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader_thread.start()
        
        # 期望启动后立即收到 PONG boot
        first = self.recv(timeout=timeout)
        if not first or first.get("type") != "PONG" or first.get("status") != "READY":
            self.kill()
            raise RuntimeError(f"daemon 启动握手失败: {first}")
        return first
    
    def _read_stdout(self):
        """后台线程不断读 stdout 行 → 投递到 queue"""
        try:
            while self.proc and self.proc.poll() is None:
                line = self.proc.stdout.readline()
                if not line:
                    break
                self.stdout_q.put(line)
        except Exception as e:
            self.stdout_q.put(f"__READER_ERR__: {e}\n")
    
    def send(self, payload: dict):
        """发送一个 JSON 报文给 daemon stdin"""
        if not self.proc or self.proc.poll() is not None:
            raise RuntimeError("daemon 未运行")
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
    
    def recv(self, timeout: float = 10.0) -> Optional[dict]:
        """读取下一个 JSON 报文（超时返回 None）"""
        try:
            line = self.stdout_q.get(timeout=timeout)
            if isinstance(line, str) and line.startswith("__READER_ERR__"):
                return None
            return json.loads(line.strip())
        except queue.Empty:
            return None
        except json.JSONDecodeError as e:
            return {"__decode_error__": str(e), "__raw__": line}
    
    def calc(self, payload: dict, timeout: float = 15.0) -> Optional[dict]:
        """发送 CALC 请求并等待 CALC_RES / ERROR 响应"""
        cid = payload.get("correlationId", "test")
        self.send(payload)
        
        # 等响应（按 correlationId 匹配）
        t_deadline = time.time() + timeout
        while time.time() < t_deadline:
            resp = self.recv(timeout=max(0.5, t_deadline - time.time()))
            if resp is None:
                continue
            if resp.get("correlationId") == cid:
                return resp
            # 其他报文（如 boot PONG）跳过
        
        return None
    
    def kill(self):
        if self.proc:
            try:
                self.proc.kill()
                self.proc.wait(timeout=2)
            except Exception:
                pass
            self.proc = None


# ─── Mock 数据生成 ─────────────────────────────────────────────────────────────

def _mock_series(n: int = 300, seed: int = 42) -> list:
    """生成 OHLCV dict 列表（符合协议格式）"""
    rng = np.random.default_rng(seed)
    prices = 50000 + np.cumsum(rng.normal(0, 50, n))
    
    return [
        {
            "timestamp": int(i * 60_000),
            "open": float(prices[i] + rng.normal(0, 5)),
            "high": float(prices[i] + rng.normal(5, 5)),
            "low": float(prices[i] - rng.normal(5, 5)),
            "close": float(prices[i]),
            "volume": float(abs(rng.normal(1000, 200))),
        }
        for i in range(n)
    ]


# ─── 测试用例 ───────────────────────────────────────────────────────────────────

def test_ping_handshake(d: DaemonProc) -> Dict[str, Any]:
    """1. PING 握手"""
    cid = "ping-test-001"
    resp = d.calc({"type": "PING", "correlationId": cid})
    
    if not resp:
        return {"passed": False, "detail": "无响应"}
    if resp.get("type") != "PONG":
        return {"passed": False, "detail": f"type={resp.get('type')}"}
    if resp.get("correlationId") != cid:
        return {"passed": False, "detail": f"cid mismatch"}
    if resp.get("status") != "READY":
        return {"passed": False, "detail": f"status={resp.get('status')}"}
    return {"passed": True, "detail": "PONG READY"}


def test_unknown_type(d: DaemonProc) -> Dict[str, Any]:
    """2. 未知 type 应返回 ERROR/UNKNOWN"""
    cid = "unknown-001"
    resp = d.calc({"type": "UNKNOWN_TYPE", "correlationId": cid})
    
    if not resp:
        return {"passed": False, "detail": "无响应"}
    if resp.get("type") != "ERROR" and resp.get("status") != "UNKNOWN":
        return {"passed": False, "detail": f"expected ERROR/UNKNOWN, got {resp.get('type')}/{resp.get('status')}"}
    return {"passed": True, "detail": "ERROR/UNKNOWN ✓"}


def test_invalid_json_handling(d: DaemonProc) -> Dict[str, Any]:
    """3. 非法 JSON 应返回 ERROR/PARSE_ERR"""
    # 直接写非法 JSON 到 stdin
    d.proc.stdin.write("this is not json\n")
    d.proc.stdin.flush()
    
    resp = d.recv(timeout=5.0)
    if not resp:
        return {"passed": False, "detail": "无响应"}
    if resp.get("status") not in ("PARSE_ERR", "FATAL"):
        return {"passed": False, "detail": f"status={resp.get('status')}"}
    return {"passed": True, "detail": f"status={resp.get('status')}"}


def test_calc_hullsuite(d: DaemonProc) -> Dict[str, Any]:
    """4. CALC HullSuite 返回结构正确"""
    series = _mock_series(n=300)
    cid = "calc-hull-001"
    
    payload = {
        "type": "CALC",
        "correlationId": cid,
        "asset": "BTC/USDT",
        "series": series,
        "indicators": [{"name": "HullSuite", "params": {"period": 200}}],
    }
    resp = d.calc(payload, timeout=15.0)
    
    if not resp:
        return {"passed": False, "detail": "无响应"}
    if resp.get("type") != "CALC_RES":
        return {"passed": False, "detail": f"type={resp.get('type')}, status={resp.get('status')}"}
    if resp.get("status") != "SUCCESS":
        return {"passed": False, "detail": f"status={resp.get('status')}, err={resp.get('error')}"}
    if resp.get("correlationId") != cid:
        return {"passed": False, "detail": "cid mismatch"}
    
    data = resp.get("data", {})
    hull = data.get("HullSuite", {})
    if "hma" not in hull or "trend" not in hull:
        return {"passed": False, "detail": f"missing fields: {list(hull.keys())}"}
    return {"passed": True, "detail": f"hma={hull.get('hma')}, trend={hull.get('trend')}"}


def test_calc_chandelier(d: DaemonProc) -> Dict[str, Any]:
    """5. CALC ChandelierExit 返回结构正确"""
    series = _mock_series(n=300)
    cid = "calc-chandelier-001"
    
    payload = {
        "type": "CALC",
        "correlationId": cid,
        "asset": "ETH/USDT",
        "series": series,
        "indicators": [{"name": "ChandelierExit", "params": {"length": 22, "mult": 3.0}}],
    }
    resp = d.calc(payload, timeout=15.0)
    
    if not resp:
        return {"passed": False, "detail": "无响应"}
    if resp.get("type") != "CALC_RES" or resp.get("status") != "SUCCESS":
        return {"passed": False, "detail": f"non-success: {resp.get('status')}"}
    
    ch = resp.get("data", {}).get("ChandelierExit", {})
    if ch.get("signal") not in ("LONG", "SHORT", "HOLD"):
        return {"passed": False, "detail": f"bad signal: {ch.get('signal')}"}
    return {"passed": True, "detail": f"signal={ch.get('signal')}, dir={ch.get('direction')}"}


def test_calc_utbot(d: DaemonProc) -> Dict[str, Any]:
    """6. CALC UTBotAlerts 返回 buy/sell bool"""
    series = _mock_series(n=300)
    cid = "calc-utbot-001"
    
    payload = {
        "type": "CALC",
        "correlationId": cid,
        "asset": "BTC/USDT",
        "series": series,
        "indicators": [{"name": "UTBotAlerts", "params": {"keyPass": 1.0, "atrPeriod": 10}}],
    }
    resp = d.calc(payload, timeout=15.0)
    
    if not resp or resp.get("status") != "SUCCESS":
        return {"passed": False, "detail": f"non-success"}
    
    ut = resp.get("data", {}).get("UTBotAlerts", {})
    if "buy" not in ut or "sell" not in ut:
        return {"passed": False, "detail": f"missing buy/sell: {list(ut.keys())}"}
    if not isinstance(ut.get("buy"), bool) or not isinstance(ut.get("sell"), bool):
        return {"passed": False, "detail": f"buy/sell not bool"}
    return {"passed": True, "detail": f"signal={ut.get('signal')}"}


def test_calc_multi_indicators(d: DaemonProc) -> Dict[str, Any]:
    """7. CALC 一次请求多指标（验证批量分发）"""
    series = _mock_series(n=300)
    cid = "calc-multi-001"
    
    payload = {
        "type": "CALC",
        "correlationId": cid,
        "asset": "BTC/USDT",
        "series": series,
        "indicators": [
            {"name": "HullSuite", "params": {"period": 100}},
            {"name": "ChandelierExit", "params": {"length": 22, "mult": 3.0}},
            {"name": "UTBotAlerts", "params": {"keyPass": 1.0, "atrPeriod": 10}},
        ],
    }
    resp = d.calc(payload, timeout=15.0)
    
    if not resp or resp.get("status") != "SUCCESS":
        return {"passed": False, "detail": "non-success"}
    
    data = resp.get("data", {})
    if len(data) != 3:
        return {"passed": False, "detail": f"expected 3 results, got {len(data)}"}
    if "HullSuite" not in data or "ChandelierExit" not in data or "UTBotAlerts" not in data:
        return {"passed": False, "detail": f"missing key: {list(data.keys())}"}
    return {"passed": True, "detail": f"批量分发 ✓ ({len(data)}个)"}


def test_calc_unknown_indicator(d: DaemonProc) -> Dict[str, Any]:
    """8. 未知 indicator 应返回 error 而非崩溃"""
    series = _mock_series(n=300)
    cid = "calc-unknown-001"
    
    payload = {
        "type": "CALC",
        "correlationId": cid,
        "asset": "BTC/USDT",
        "series": series,
        "indicators": [{"name": "NonExistentIndicator", "params": {}}],
    }
    resp = d.calc(payload, timeout=15.0)
    
    if not resp:
        return {"passed": False, "detail": "无响应"}
    
    # daemon 整体不挂，但该指标应有 error 字段
    if resp.get("type") == "ERROR":
        return {"passed": False, "detail": f"daemon ERROR: {resp.get('error', '')[:80]}"}
    
    if resp.get("status") != "SUCCESS":
        return {"passed": False, "detail": f"status={resp.get('status')}"}
    
    data = resp.get("data", {})
    if "error" not in data.get("NonExistentIndicator", {}):
        return {"passed": False, "detail": f"未返回 error 字段: {data}"}
    return {"passed": True, "detail": "unknown ind error ✓"}


def test_calc_insufficient_data(d: DaemonProc) -> Dict[str, Any]:
    """9. 数据不足应优雅返回 error 而非崩溃"""
    # 只给 5 根 K 线，HullSuite 需要 200+5 根
    series = _mock_series(n=5)
    cid = "calc-insufficient-001"
    
    payload = {
        "type": "CALC",
        "correlationId": cid,
        "asset": "BTC/USDT",
        "series": series,
        "indicators": [{"name": "HullSuite", "params": {"period": 200}}],
    }
    resp = d.calc(payload, timeout=15.0)
    
    if not resp:
        return {"passed": False, "detail": "无响应"}
    
    # 应该 SUCCESS 但 data.HullSuite.error 有错误说明
    if resp.get("type") == "ERROR" and resp.get("status") == "FAILED":
        # daemon 整体 FAILED 也接受（因为 handle_calc 抛了 ValueError）
        return {"passed": True, "detail": "daemon FAILED on insufficient data"}
    
    if resp.get("status") == "SUCCESS":
        hull = resp.get("data", {}).get("HullSuite", {})
        if "error" in hull:
            return {"passed": True, "detail": f"insufficient handled: {hull['error'][:50]}"}
    
    return {"passed": False, "detail": f"unexpected resp: {str(resp)[:120]}"}


def test_calc_sequential_calls(d: DaemonProc) -> Dict[str, Any]:
    """10. 连续多次 CALC 不卡死（验证 daemon 是常驻服务）"""
    series = _mock_series(n=300)
    
    success = 0
    for i in range(5):
        cid = f"seq-{i:03d}"
        payload = {
            "type": "CALC",
            "correlationId": cid,
            "asset": "BTC/USDT",
            "series": series,
            "indicators": [{"name": "HullSuite", "params": {"period": 100}}],
        }
        resp = d.calc(payload, timeout=15.0)
        if resp and resp.get("status") == "SUCCESS" and resp.get("correlationId") == cid:
            success += 1
    
    if success == 5:
        return {"passed": True, "detail": "5次连续请求 ✓"}
    return {"passed": False, "detail": f"只成功 {success}/5 次"}


# ─── 主程序 ───────────────────────────────────────────────────────────────────

ALL_TESTS = [
    ("PING 握手", test_ping_handshake),
    ("未知 type 错误处理", test_unknown_type),
    ("非法 JSON 错误处理", test_invalid_json_handling),
    ("CALC HullSuite", test_calc_hullsuite),
    ("CALC ChandelierExit", test_calc_chandelier),
    ("CALC UTBotAlerts", test_calc_utbot),
    ("CALC 批量多指标", test_calc_multi_indicators),
    ("CALC 未知 indicator 不崩", test_calc_unknown_indicator),
    ("CALC 数据不足优雅失败", test_calc_insufficient_data),
    ("CALC 连续5次请求", test_calc_sequential_calls),
]


def run_all(verbose: bool = False):
    print("=" * 60)
    print("  CloddsBot Daemon — Protocol E2E Test (B方案)")
    print("=" * 60)
    print()
    
    # 启动 daemon
    print("[boot] 启动 daemon 子进程...", end=" ")
    daemon = DaemonProc()
    try:
        boot = daemon.start(timeout=5.0)
        print(f"✓ {boot.get('correlationId', 'unknown')}")
    except Exception as e:
        print(f"✗ {e}")
        return 1
    print()
    
    results = []
    total = len(ALL_TESTS)
    
    for idx, (name, fn) in enumerate(ALL_TESTS):
        print(f"[{idx+1:2d}/{total}] {name} ...", end=" ")
        sys.stdout.flush()
        
        t0 = time.time()
        try:
            result = fn(daemon)
            elapsed = (time.time() - t0) * 1000
        except Exception as e:
            result = {"passed": False, "detail": f"EXCEPTION: {str(e)[:80]}"}
            elapsed = (time.time() - t0) * 1000
        
        icon = "✓" if result["passed"] else "✗"
        print(f"{icon} {elapsed:.0f}ms | {result['detail']}")
        
        results.append({"name": name, "passed": result["passed"], "detail": result["detail"]})
    
    # 汇总
    print()
    print("=" * 60)
    passed_count = sum(1 for r in results if r["passed"])
    fail_count = total - passed_count
    print(f"  总计: {total}  通过: {passed_count}  失败: {fail_count}")
    
    if fail_count == 0:
        print("  ✅ 全部通过")
    else:
        print("  ❌ 有失败项:")
        for r in results:
            if not r["passed"]:
                print(f"    ✗ {r['name']}: {r['detail']}")
    print("=" * 60)
    
    daemon.kill()
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    sys.exit(run_all(verbose=verbose))
