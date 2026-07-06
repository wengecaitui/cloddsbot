#!/usr/bin/env python3
"""
Scrapling MCP Server — 功能验证脚本
测试：环境检测 + 语法验证 + 实际抓取
"""

import asyncio
import json
import sys
import time

# 1. 语法检查
print("=== 1. 语法检查 ===")
import py_compile
for f in ["scrapling_mcp_server.py", "check_scrapling_env.py"]:
    try:
        py_compile.compile(f, doraise=True)
        print(f"✅ {f}")
    except Exception as e:
        print(f"❌ {f}: {e}")
        sys.exit(1)

print()

# 2. 模块导入检查
print("=== 2. 模块导入 ===")
try:
    from scrapling_mcp_server import (
        SCRAPLING_AVAILABLE,
        semantic_denoise,
        _clean_text,
        fetch_with_retry,
    )
    print(f"✅ 导入成功，Scrapling 可用: {SCRAPLING_AVAILABLE}")
except Exception as e:
    print(f"❌ 导入失败: {e}")
    sys.exit(1)

print()

# 3. 语义降噪单元测试
print("=== 3. 语义降噪测试 ===")

test_html = """
<html>
<head><title>Test Page</title></head>
<body>
<nav>导航栏 | 关于 | 联系我们</nav>
<article>
<h1>测试文章标题</h1>
<p>这是正文内容。</p>
<p>第二段文字。</p>
</article>
<footer>版权所有 © 2026</footer>
</body>
</html>
"""

cleaned = semantic_denoise(test_html)
print(f"输入长度: {len(test_html)} → 输出长度: {len(cleaned)}")
print(f"输出预览:\n{cleaned[:200]}")

assert "测试文章标题" in cleaned, "应包含标题"
assert "正文内容" in cleaned, "应包含正文"
assert "导航栏" not in cleaned, "应排除导航栏"
assert "版权所有" not in cleaned, "应排除页脚"
print("✅ 语义降噪通过")

print()

# 4. fetch_with_retry 签名检查
print("=== 4. fetch_with_retry 接口 ===")
import inspect
sig = inspect.signature(fetch_with_retry)
params = list(sig.parameters.keys())
print(f"参数: {params}")
assert "url" in params
assert "adaptive" in params
assert "headless" in params
assert "extraction_rule" in params
assert "proxy" in params
print("✅ 接口签名正确")

print()

# 5. 实际抓取测试（可选）
print("=== 5. 实际抓取测试 ===")
if SCRAPLING_AVAILABLE:
    test_url = "https://quotes.toscrape.com/"
    print(f"抓取: {test_url}")
    try:
        result = asyncio.run(fetch_with_retry(
            url=test_url,
            adaptive=True,
            headless=True,
            extraction_rule=".quote",
            max_retries=2,
        ))
        status = result.get("status")
        http_code = result.get("http_code")
        payload_len = len(result.get("extracted_payload", ""))
        print(f"状态: {status}, HTTP: {http_code}, 内容长度: {payload_len}")
        if status == "SUCCESS":
            print(f"内容预览: {result['extracted_payload'][:200]}")
            print("✅ 实际抓取通过")
        else:
            print(f"⚠️ 抓取失败: {result.get('error')}")
    except Exception as e:
        print(f"❌ 抓取异常: {e}")
else:
    print("⏭️ Scrapling 未安装，跳过实际抓取")

print()
print("=== 验证完成 ===")
