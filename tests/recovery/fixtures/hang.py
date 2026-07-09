"""
hang.py — Sprint 2C Phase 1 Timeout Recovery 验证用模拟器
模拟 TradingAgentsGraph.propagate() 永久阻塞。
不响应 ANALYZE/CALC，只响应 PING/HEALTH/VERSION 用于握手。
"""
import sys
import json
import time
import os

def main():
    sys.stderr.write(f"[hang.py] pid={os.getpid()} started\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}), flush=True)
            continue

        rtype = req.get("type", "")
        cid = req.get("correlationId", "")

        if rtype == "PING":
            print(json.dumps({"success": True, "pong": True, "correlationId": cid, "pid": os.getpid()}), flush=True)
        elif rtype == "HEALTH":
            print(json.dumps({
                "success": True,
                "metadata": {"adapter_version": "hang-1.0.0", "pid": os.getpid()},
                "correlationId": cid
            }), flush=True)
        elif rtype == "VERSION":
            print(json.dumps({"success": True, "adapter_version": "hang-1.0.0", "correlationId": cid, "pid": os.getpid()}), flush=True)
        elif rtype in ("ANALYZE", "CALC"):
            sys.stderr.write(f"[hang.py] pid={os.getpid()} received {rtype}, simulating permanent hang\n")
            sys.stderr.flush()
            # 永久阻塞 — 等外部 SIGTERM/SIGKILL
            time.sleep(600)
        else:
            print(json.dumps({"success": False, "error": "NOT_IMPLEMENTED", "request_type": rtype, "correlationId": cid}), flush=True)

if __name__ == "__main__":
    main()
