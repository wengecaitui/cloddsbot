"""
Phase 0 延迟基准压力测试 (sync/threading 版 — 兼容 Windows)
用法: python phase0_latency_stress_test.py --runs 50
"""

import os, sys, json, time, requests, argparse, random, numpy as np
from concurrent.futures import ThreadPoolExecutor, as_completed

PROVIDER_CONFIG = {
    "provider": "orangeai",
    "base_url": "https://api4.orangeai.cc/v1",
    "model": "glm-5.2",
    "api_key_env": "ORANGEAI_SLOW_KEY",
    "temperature": 0.3,
    "max_tokens": 1024,
}

ROLLES = [
    {"name": "Bull", "prompt": (
        "你是激进看涨的量化分析师。BTC 当前 67450，RSI=58.6（中性偏多），MACD 金叉，Volume Delta +1245（主动买占优），"
        "VP POC=67200。输出 JSON：3~5 个看涨理由，支撑/阻力位，最大回撤%，建议仓位%。完整 JSON 不少词。"
    )},
    {"name": "Bear", "prompt": (
        "你是谨慎看跌的量化分析师。BTC 当前 67450，RSI=42.3，MACD 死叉风险，Volume Delta -876，"
        "VP VAH=67800 价格下半区，最近大单卖。输出 JSON：3~5 个看跌理由，支撑/阻力位，反弹概率%，建议仓位%。"
    )},
    {"name": "Sentiment", "prompt": (
        "你是市场情绪分析师。多空比 1.35，资金费率 +0.0087%，恐贪指数 68，提及量 +22.5%，"
        "稳定币流出 -124.5M。输出 JSON：情绪评分 0-100，极端警告，逆向建议，趋势方向。"
    )},
    {"name": "Macro", "prompt": (
        "你是宏观经济分析师。美联储利率 4.50%，10Y 4.28%，DXY 104.8，黄金 2380，标普 5420。"
        "输出 JSON：宏观评分 -10~+10，风险事件，BTC 相关性，对冲策略建议。"
    )},
]

DEBATE_PROMPT = (
    "辩论主持人。Bull 说: {bull}\\nBear 说: {bear}\\n输出 JSON：共识点、分歧点、胜负倾向、置信度 0-100%。"
)
MANAGER_PROMPT = (
    "研究经理。Bull={bull}\\nBear={bear}\\nSentiment={sent}\\nMacro={macro}\\n辩论={debate}\\n"
    "输出 JSON：final_decision、confidence 0-100、position_pct、stop_loss、take_profit、rationale。"
)


def call_api(prompt, config, timeout=60):
    """同步调用 OpenAI 兼容端点"""
    start = time.perf_counter()
    try:
        resp = requests.post(
            "{}/chat/completions".format(config["base_url"]),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer {}".format(config["api_key"]),
            },
            json={
                "model": config["model"],
                "messages": [{"role": "user", "content": prompt}],
                "temperature": config["temperature"],
                "max_tokens": config["max_tokens"],
            },
            timeout=timeout,
        )
        elapsed = time.perf_counter() - start
        if resp.status_code != 200:
            return "", elapsed, 0, "HTTP {}".format(resp.status_code)
        data = resp.json()
        msg = data["choices"][0]["message"]
        text = msg.get("content") or msg.get("reasoning_content", "")
        tokens = data.get("usage", {}).get("completion_tokens", 0)
        return text, elapsed, tokens, None
    except Exception as e:
        elapsed = time.perf_counter() - start
        return "", elapsed, 0, str(e)[:80]


def run_one_cycle(config, jitter_mean=0.5):
    """跑一次 4 Analyst → Debate → Manager 链路"""
    reports = {}
    timings = {}

    # 阶段 1: 4 Analyst 并发
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(call_api, r["prompt"], config): r["name"] for r in ROLLES}
        for fut in as_completed(futures):
            name = futures[fut]
            text, elapsed, tokens, err = fut.result()
            reports[name] = text
            timings["analyst_{}".format(name)] = elapsed
            timings["analyst_{}_tokens".format(name)] = tokens
            timings["analyst_{}_err".format(name)] = 1 if err else 0
    t1 = time.perf_counter()
    timings["analysts_concurrent"] = t1 - t0

    # 阶段 2: Debate
    dp = DEBATE_PROMPT.format(bull=reports.get("Bull","")[:300], bear=reports.get("Bear","")[:300])
    t0 = time.perf_counter()
    text, el, tok, err = call_api(dp, config)
    timings["debate"] = time.perf_counter() - t0
    timings["debate_tokens"] = tok
    reports["Debate"] = text

    # 阶段 3: Manager
    mp = MANAGER_PROMPT.format(
        bull=reports.get("Bull","")[:200], bear=reports.get("Bear","")[:200],
        sent=reports.get("Sentiment","")[:200], macro=reports.get("Macro","")[:200],
        debate=text[:200],
    )
    t0 = time.perf_counter()
    text, el, tok, err = call_api(mp, config)
    timings["manager"] = time.perf_counter() - t0
    timings["manager_tokens"] = tok
    reports["Manager"] = text

    timings["total"] = sum([
        timings.get("analysts_concurrent", 0),
        timings.get("debate", 0),
        timings.get("manager", 0),
    ])
    return timings, reports


def run_stress_test(num_runs=50, jitter_mean=0.5):
    config = PROVIDER_CONFIG.copy()
    config["api_key"] = os.environ.get(config.pop("api_key_env"), "")

    all_timings = []
    errors = 0
    error_details = []

    print("📊 压力测试：{} 次 | {} 并发｜Provider: {}".format(
        num_runs, 4, config["model"]))
    print()

    for i in range(num_runs):
        try:
            timings, _ = run_one_cycle(config, jitter_mean)
            all_timings.append(timings)
            if (i+1) % 5 == 0 or i == 0:
                p50 = np.percentile([t["total"] for t in all_timings], 50)
                print("  {}/{} 完成 | P50={:.1f}s".format(i+1, num_runs, p50))
        except Exception as e:
            errors += 1
            error_details.append(str(e)[:80])
            print("  ❌ {}: {}".format(i+1, str(e)[:60]))

    total_times = [t["total"] for t in all_timings] if all_timings else [0]

    result = {"num_runs": num_runs, "num_success": len(all_timings), "num_errors": errors}
    if all_timings:
        result.update({
            "p50_s": round(float(np.percentile(total_times, 50)), 2),
            "p95_s": round(float(np.percentile(total_times, 95)), 2),
            "p99_s": round(float(np.percentile(total_times, 99)), 2),
            "mean_s": round(float(np.mean(total_times)), 2),
            "min_s": round(float(np.min(total_times)), 2),
            "max_s": round(float(np.max(total_times)), 2),
            "std_s": round(float(np.std(total_times)), 2),
            "pass_rate_5s": round(float(np.mean(np.array(total_times) <= 5.0)) * 100, 1),
            "analysts_p50": round(float(np.percentile([t["analysts_concurrent"] for t in all_timings], 50)), 2),
            "debate_p50": round(float(np.percentile([t["debate"] for t in all_timings], 50)), 2),
            "manager_p50": round(float(np.percentile([t["manager"] for t in all_timings], 50)), 2),
        })
        # 打印前 3 个报错
        if error_details:
            result["sample_errors"] = error_details[:3]
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=50)
    ap.add_argument("--jitter", type=float, default=0.5)
    args = ap.parse_args()

    if not os.environ.get(PROVIDER_CONFIG["api_key_env"]):
        print("❌ 设环境变量: export {}='sk-...'".format(PROVIDER_CONFIG["api_key_env"]))
        sys.exit(1)

    result = run_stress_test(args.runs, args.jitter)

    print("\n" + "=" * 60)
    print("📊 Phase 0 压力测试报告")
    print("=" * 60)
    for k, v in result.items():
        print("  {}: {}".format(k, v))
    print("=" * 60)

    if result.get("p99_s", 999) > 5.0:
        print("\n🔥 决策：P99={:.1f}s > 5s → 必须上快慢分道".format(result["p99_s"]))
    else:
        print("\n✅ 决策：P99={:.1f}s ≤ 5s → 纯快路径即可".format(result["p99_s"]))
