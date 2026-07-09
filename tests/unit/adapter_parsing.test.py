"""验证 tradingagents_adapter 的三层解析逻辑（不调用 graph）"""
import sys, re, json

sys.path.insert(0, "E:/Workplace/CloddsBot")
from quant_engine.tradingagents_adapter import _normalize_rating, _parse_free_text, _extract_field

PASS = 0
FAIL = 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS: {name}")
    else:
        FAIL += 1
        print(f"  FAIL: {name} {detail}")

# ─── Test 1: normalize ───
check("normalize Buy", _normalize_rating("Buy") == "Buy")
check("normalize Sell", _normalize_rating("Sell") == "Sell")
check("normalize Hold lowercase", _normalize_rating("HOLD") == "Hold")
check("normalize Underweight", _normalize_rating("Underweight") == "Underweight")
check("normalize Chinese buy", _normalize_rating("\u4e70\u5165") == "Buy")
check("normalize unknown returns as-is", _normalize_rating("\u4e2d\u6027") == "\u4e2d\u6027")
check("normalize striping bold", _normalize_rating("**Buy**") == "Buy")

# ─── Test 2: parse_free_text TradingAgents markdown ───
ta_md = (
    "## Portfolio Manager Decision\n"
    "**Rating**: Overweight\n"
    "**Confidence**: 75\n"
    "**Direction**: long\n"
    "**Executive Summary**: BTC shows strong momentum\n"
)
r, c, d, reason = _parse_free_text(ta_md)
check("TA markdown rating", r == "Overweight", f"got {r!r}")
check("TA markdown confidence", c == "75", f"got {c!r}")
check("TA markdown direction", d == "long", f"got {d}")

# ─── Test 3: parse_free_text Chinese format ───
cn_text = (
    "## \u6295\u8d44\u7ec4\u5408\u7ecf\u7406\u51b3\u7b56\n"
    "**\u8bc4\u7ea7**\uff1a\u4e70\u5165\n"
    "**\u7f6e\u4fe1\u5ea6**\uff1a85\n"
    "**\u65b9\u5411**\uff1a\u505a\u591a\n"
    "**\u7406\u7531**\uff1a\u6280\u672f\u9762\u5f3a\u52bf\u7a81\u7834\n"
)
r, c, d, reason = _parse_free_text(cn_text)
check("CN md rating", r == "\u4e70\u5165", f"got {r!r}")
check("CN md confidence", c == "85", f"got {c!r}")
check("CN md direction", d == "long", f"got {d}")

# ─── Test 4: parse_free_text plain format (no markdown bold) ───
plain = "Rating: Sell\nConfidence: 15\nDirection: short\n"
r, c, d, _ = _parse_free_text(plain)
check("Plain rating", r == "Sell", f"got {r!r}")
check("Plain confidence", c == "15", f"got {c!r}")
check("Plain direction", d == "short", f"got {d}")

# ─── Test 5: parse_free_text empty ───
r, c, d, reason = _parse_free_text("")
check("Empty text all None", r is None and c is None and d is None)

# ─── Test 6: extract_field ───
check("Extract field found", _extract_field("**Executive Summary**: BTC\n", "Executive Summary") == "BTC")
check("Extract field not found", _extract_field("**Executive Summary**: BTC\n", "NoField") == "No data")

# ─── Test 7: normalize special cases ───
check("normalize strong buy", _normalize_rating("strong buy") == "Buy")
check("normalize strong sell", _normalize_rating("strong sell") == "Sell")
check("normalize neutral", _normalize_rating("neutral") == "Hold")

print(f"\n=== RESULTS: {PASS} passed, {FAIL} failed ===")
sys.exit(0 if FAIL == 0 else 1)
