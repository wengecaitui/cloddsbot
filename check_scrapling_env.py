#!/usr/bin/env python3
"""
检查 Scrapling 环境依赖是否就绪
运行: python check_scrapling_env.py
"""

import importlib
import subprocess
import sys

errors = []
warnings = []

def check_module(name, pip_name=None):
    try:
        mod = importlib.import_module(name)
        ver = getattr(mod, "__version__", "未知")
        return f"✅ {name} ({ver})"
    except ImportError:
        errors.append(f"❌ {name} 未安装")
        if pip_name:
            errors.append(f"   安装: pip install '{pip_name}'")
        return f"❌ {name} 未安装"

def check_command(cmd, name):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        return f"✅ {name} 可用"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        warnings.append(f"⚠️ {name} 未找到（可选依赖）")
        return f"⚠️ {name} 未找到（可选）"

def check_py_version():
    if sys.version_info < (3, 8):
        errors.append(f"❌ Python {sys.version} (< 3.8)")
    return f"✅ Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"


def main():
    print("=" * 50)
    print("Scrapling MCP Server — 环境检测")
    print("=" * 50)
    print()

    print(check_py_version())
    print()

    print("--- 核心依赖 ---")
    print(check_module("scrapling", "scrapling[fetchers]"))
    print()

    print("--- 浏览器引擎（可选） ---")
    print(check_module("playwright"))
    print(check_command(["playwright", "--version"], "Playwright CLI"))
    print()

    print("--- 工具库 ---")
    print(check_module("lxml"))
    print(check_module("cssselect"))
    print()

    print("--- MCP 依赖 ---")
    print("✅ json（内置）")
    print()

    if errors:
        print("=" * 50)
        print("❌ 需要修复:")
        for e in errors:
            print(f"  {e}")

    if warnings:
        print()
        print("⚠️ 警告（非阻塞）:")
        for w in warnings:
            print(f"  {w}")

    if not errors:
        print()
        print("✅ 所有核心依赖就绪，MCP Server 可启动！")
        print()
        print("启动命令:")
        print("  python scrapling_mcp_server.py")


if __name__ == "__main__":
    main()
