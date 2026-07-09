# Phase A — 验证 .env 在任意 CWD 下被加载
import subprocess, json, sys, os

# 从 Hermes 根目录（E:/Hermes）调用 adapter（CWD 不是 TA 项目目录）
r = subprocess.run(
    [sys.executable, "-c",
     "import os, json; "
     "from pathlib import Path; "
     "sys.path.insert(0, 'E:/Workplace/CloddsBot'); "
     "import tradingagents_adapter; "
     "print(json.dumps({"
     "  'TRADINGAGENTS_LLM_PROVIDER': os.environ.get('TRADINGAGENTS_LLM_PROVIDER', '<NOT SET>'), "
     "  'TRADINGAGENTS_DEEP_THINK_LLM': os.environ.get('TRADINGAGENTS_DEEP_THINK_LLM', '<NOT SET>'), "
     "  'TRADINGAGENTS_LLM_BACKEND_URL': os.environ.get('TRADINGAGENTS_LLM_BACKEND_URL', '<NOT SET>'), "
     "  'OPENAI_COMPATIBLE_API_KEY': os.environ.get('OPENAI_COMPATIBLE_API_KEY', '<NOT SET>'), "
     "  'OPENAI_API_KEY': os.environ.get('OPENAI_API_KEY', '<NOT SET>'), "
     "}))"],
    capture_output=True, text=True, cwd="E:/Hermes"
)
print("Phase A — Environment Variables (CWD=E:/Hermes):")
print(r.stdout.strip())
assert r.returncode == 0, f"exit code {r.returncode}"

data = json.loads(r.stdout)
provider = data.get("TRADINGAGENTS_LLM_PROVIDER", "<NOT SET>")
print(f"\nprovider = {provider}")
assert provider != "openai", f"provider 仍为硬编码默认 'openai'，.env 加载失败！"
assert provider == "openai_compatible", f"期望 openai_compatible，实际 {provider}"
print("✅ .env 已正确加载（provider = openai_compatible）")
