#!/usr/bin/env python3
"""
Phase 0.4 — Latency Benchmark: Multi-Agent Analysis Pipeline
Measures end-to-end latency of 4 Analyst → Debate → Research Manager flow
"""

import json, time, csv, os, sys
from datetime import datetime
from openai import OpenAI

# === Config ===
API_KEY = os.environ.get("INFERAICHAT_API_KEY", "sk-placeholder-replace-me")
BASE_URL = "https://<your-new-provider-url>/v1"
MODEL = "<your-new-model>"

client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

# === Test Prompts (simulating real analyst tasks) ===
ANALYST_PROMPTS = {
    "market": """You are a Market Analyst. Analyze the current state of BTC/USDT in 2-3 sentences.
Focus on: price action, volume, key levels. Be concise.""",
    
    "fundamental": """You are a Fundamental Analyst. Analyze BTC based on on-chain metrics and macro context.
Mention: exchange flows, whale activity, Fed policy. 2-3 sentences.""",
    
    "sentiment": """You are a Sentiment Analyst. What is the current market sentiment for crypto?
Focus on: fear/greed, social volume, funding rates. 2-3 sentences.""",
    
    "technical": """You are a Technical Analyst. Give your view on BTC/USDT 4H chart.
Mention: RSI, MACD, moving averages, key support/resistance. 2-3 sentences.""",
}

DEBATE_PROMPT = """You are a Bull researcher. Argue why BTC will go UP in the next 24h.
Use data from the Market, Fundamental, Sentiment, and Technical analysts above.
Be specific, quantitative, and reference their findings. 4-5 sentences."""

BEAR_PROMPT = """You are a Bear researcher. Argue why BTC will go DOWN in the next 24h.
Rebuke the Bull's points with data. 4-5 sentences."""

MANAGER_PROMPT = """You are the Research Manager. After hearing Bull and Bear arguments, synthesize a final view.
Output ONLY in this format:
DIRECTION: [BULLISH/BEARISH/NEUTRAL]
CONFIDENCE: [1-10]
SUMMARY: [2-3 sentence synthesis]
KEY_RISK: [top 1 risk]"""

# === Timing utilities ===
results = []

def timed_call(name, messages, model=MODEL):
    start = time.perf_counter()
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=300,
            temperature=0.3,
            timeout=60
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        content = resp.choices[0].message.content
        tokens = resp.usage.total_tokens if resp.usage else 0
        result = {"step": name, "latency_ms": round(elapsed_ms, 0), "tokens": tokens, "status": "ok"}
        print(f"  ✅ {name}: {elapsed_ms:.0f}ms ({tokens} tokens)")
        return result, content
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        result = {"step": name, "latency_ms": round(elapsed_ms, 0), "tokens": 0, "status": f"error: {e}"}
        print(f"  ❌ {name}: {elapsed_ms:.0f}ms — {e}")
        return result, str(e)

# === Main benchmark ===
print(f"\n{'='*60}")
print(f"Phase 0.4 — Latency Benchmark")
print(f"Model: {MODEL} | API: {BASE_URL}")
print(f"Time: {datetime.now().isoformat()}")
print(f"{'='*60}\n")

pipeline_start = time.perf_counter()

# Step 1-4: 4 Analysts (sequential, like TradingAgents)
print("--- 4 Analysts (Sequential) ---")
analyst_outputs = {}
for role, prompt in ANALYST_PROMPTS.items():
    r, content = timed_call(f"analyst_{role}", [{"role": "user", "content": prompt}])
    results.append(r)
    analyst_outputs[role] = content
    time.sleep(0.5)  # brief pause between calls

# Step 5: Bull Debate
print("\n--- Bull Argument ---")
bull_context = "\n\n".join(
    f"[{k.upper()}]\n{v}" for k, v in analyst_outputs.items()
)
bull_messages = [
    {"role": "user", "content": f"{DEBATE_PROMPT}\n\nContext:\n{bull_context}"}
]
r, bull_arg = timed_call("bull_debate", bull_messages)
results.append(r)

# Step 6: Bear Debate
print("\n--- Bear Argument ---")
bear_messages = [
    {"role": "user", "content": f"{BEAR_PROMPT}\n\nBull argued:\n{bull_arg}"}
]
r, bear_arg = timed_call("bear_debate", bear_messages)
results.append(r)

# Step 7: Research Manager
print("\n--- Research Manager ---")
manager_messages = [
    {"role": "user", "content": f"{MANAGER_PROMPT}\n\nBull:\n{bull_arg}\n\nBear:\n{bear_arg}"}
]
r, manager_out = timed_call("research_manager", manager_messages)
results.append(r)

pipeline_end = time.perf_counter()
total_ms = (pipeline_end - pipeline_start) * 1000

# === Summary ===
print(f"\n{'='*60}")
print(f"RESULTS SUMMARY")
print(f"{'='*60}")
print(f"Total pipeline: {total_ms:.0f}ms ({total_ms/1000:.1f}s)")
print(f"Analysts only:  {sum(r['latency_ms'] for r in results[:4]):.0f}ms")
print(f"Debate (Bull+Bear): {sum(r['latency_ms'] for r in results[4:6]):.0f}ms")
print(f"Manager:        {results[-1]['latency_ms']:.0f}ms")

# Decision
if total_ms > 5000:
    print(f"\n⚠️  DECISION: Pipeline > 5s → MUST implement fast/slow split (Phase 3 required)")
elif total_ms > 3000:
    print(f"\n⚡ DECISION: Pipeline 3-5s → Marginal, consider fast/slow split for critical signals")
else:
    print(f"\n✅ DECISION: Pipeline < 3s → Fast path acceptable, no split needed")

# === Write CSV ===
csv_path = "E:/Workplace/CloddsBot/phase0_latency_report.csv"
with open(csv_path, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["step", "latency_ms", "tokens", "status"])
    w.writeheader()
    w.writerows(results)
    w.writerow({"step": "TOTAL", "latency_ms": round(total_ms, 0), "tokens": sum(r.get("tokens",0) for r in results), "status": "ok"})

print(f"\nCSV written: {csv_path}")
