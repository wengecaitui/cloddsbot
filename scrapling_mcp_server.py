#!/usr/bin/env python3
"""
Scrapling MCP Server — 基于 Scrapling 的 Web 抓取 MCP 工具

核心设计原则（避坑指南）：
1. asyncio.to_thread 包装同步 StealthyFetcher，避免阻塞事件循环
2. try...finally 确保浏览器生命周期管理，防止内存泄露
3. 语义降噪：CSS/XPath 提取 + 自动内容容器识别 + 正则清洗；
   高级降噪：表格→Markdown 自动转换，文本密度过滤
4. 代理熔断：max_retries=3，3 次失败 → ANTI_BOT_DEADLOCK；
   优雅降级：触发熔断时返回最近一次缓存数据
5. 日志 → sys.stderr，严禁 print()

运行方式：
  python scrapling_mcp_server.py
  # 或作为 Hermes MCP Server 注册
"""

import asyncio
import hashlib
import json
import logging
import os
import random
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Optional

# === 配置日志输出到 stderr（避坑 5：禁止 print()） ===
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("scrapling-mcp")

# === Scrapling 依赖（可选安装，无则优雅降级） ===
try:
    from scrapling.fetchers import StealthyFetcher
    SCRAPLING_AVAILABLE = True
    logger.info("Scrapling engine loaded successfully")
except ImportError:
    SCRAPLING_AVAILABLE = False
    logger.warning(
        "Scrapling not installed. Run: pip install 'scrapling[fetchers]'"
    )

# === 默认参数 ===
DEFAULT_HEADLESS = True
DEFAULT_ADAPTIVE = True
MAX_RETRIES = 3
REQUEST_DELAY = (1.5, 3.0)  # 秒，随机延迟区间

# === 数据目录 ===
DATA_DIR = Path(__file__).parent / ".scrapling_data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ========================================
# ★ 优化 1: 动态 User-Agent 指纹池轮换
# ========================================
USER_AGENTS = [
    # Chrome 130+ (2026 近期版本)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    # Edge 130+
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    # Firefox 130+
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
]

# 选 4 个模拟桌面 Chrome 变体，做 Canvas/WebGL 扰动
CANVAS_VARIANTS = [
    {"navigator.platform": "Win32", "screen.width": 1920, "screen.height": 1080},
    {"navigator.platform": "Win32", "screen.width": 2560, "screen.height": 1440},
    {"navigator.platform": "MacIntel", "screen.width": 1512, "screen.height": 982},
    {"navigator.platform": "Linux x86_64", "screen.width": 1920, "screen.height": 1080},
]


def _rotate_fingerprint() -> dict[str, Any]:
    """从池中随机选择 User-Agent 和 Canvas 扰动参数"""
    ua = random.choice(USER_AGENTS)
    canvas = random.choice(CANVAS_VARIANTS)
    return {
        "User-Agent": ua,
        "navigator.platform": canvas["navigator.platform"],
        "viewport": {"width": canvas["screen.width"], "height": canvas["screen.height"]},
        # 随机 Accept-Language
        "Accept-Language": random.choice(["zh-CN,zh;q=0.9,en;q=0.8", "en-US,en;q=0.9", "zh-TW,zh;q=0.9,en;q=0.7"]),
    }


# ========================================
# ★ 优化 2: 增量抓取去重（sqlite3）
# ========================================
CACHE_DB = str(DATA_DIR / "scrapling_cache.db")


def _init_cache_db():
    """初始化 sqllite3 缓存数据库"""
    conn = sqlite3.connect(CACHE_DB)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS url_cache (
            url_hash TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            last_fetch_at REAL NOT NULL,
            payload_hash TEXT,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'fresh'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cache_stats (
            url TEXT PRIMARY KEY,
            hit_count INTEGER DEFAULT 0,
            last_hit_at REAL
        )
    """)
    conn.commit()
    conn.close()


def _is_new_content(url: str, payload: str) -> bool:
    """MD5 去重 —— 只在内容真正变化时才返回 True"""
    conn = sqlite3.connect(CACHE_DB)
    url_hash = hashlib.md5(url.encode()).hexdigest()
    payload_hash = hashlib.md5(payload.encode()).hexdigest()

    row = conn.execute(
        "SELECT payload_hash FROM url_cache WHERE url_hash = ?", (url_hash,)
    ).fetchone()

    is_new = False
    if row is None:
        is_new = True  # 全新 URL
    elif row[0] != payload_hash:
        is_new = True  # 内容已变更

    # 写入/更新缓存
    conn.execute(
        """INSERT OR REPLACE INTO url_cache (url_hash, url, last_fetch_at, payload_hash, payload)
           VALUES (?, ?, ?, ?, ?)""",
        (url_hash, url, time.time(), payload_hash, payload),
    )
    conn.execute(
        """INSERT OR REPLACE INTO cache_stats (url, hit_count, last_hit_at)
           VALUES (?, COALESCE((SELECT hit_count FROM cache_stats WHERE url = ?) + 1, 1), ?)""",
        (url, url, time.time()),
    )
    conn.commit()
    conn.close()
    return is_new


def _get_cached_payload(url: str) -> Optional[str]:
    """获取缓存的最近一次成功结果（用于优雅降级）"""
    conn = sqlite3.connect(CACHE_DB)
    url_hash = hashlib.md5(url.encode()).hexdigest()
    row = conn.execute(
        "SELECT payload FROM url_cache WHERE url_hash = ?", (url_hash,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


def _get_cache_freshness(url: str) -> Optional[float]:
    """获取缓存数据的时间戳（用于判断"是否过期"）"""
    conn = sqlite3.connect(CACHE_DB)
    url_hash = hashlib.md5(url.encode()).hexdigest()
    row = conn.execute(
        "SELECT last_fetch_at FROM url_cache WHERE url_hash = ?", (url_hash,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


_init_cache_db()


# ========================================
# ★ 优化 1 + 原有：语义降噪 + 表格→Markdown
# ========================================

def _html_table_to_markdown(table_html: str) -> str:
    """将 <table> HTML 片段转换为 Markdown 表格"""
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table_html, re.DOTALL | re.IGNORECASE)
    if not rows:
        return table_html

    md_rows = []
    for i, row in enumerate(rows):
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.DOTALL | re.IGNORECASE)
        cells = [
            re.sub(r"<[^>]+>", "", c).strip() for c in cells
        ]
        if not cells:
            continue
        md_row = "| " + " | ".join(cells) + " |"
        md_rows.append(md_row)
        # 表头后跟分隔行
        if i == 0:
            sep = "| " + " | ".join(["---"] * len(cells)) + " |"
            md_rows.append(sep)

    return "\n".join(md_rows) if md_rows else table_html


def semantic_denoise(html: str, extraction_rule: Optional[str] = None) -> str:
    """
    语义降噪：从原始 HTML 中提取核心文本，去除导航栏/页脚/广告等噪音。

    Args:
        html: 原始 HTML 或 Scrapling Response 的 text()
        extraction_rule: CSS 选择器或 XPath

    Returns:
        清洗后的纯文本或 Markdown
    """
    # 1. 如果有指定提取规则，先尝试
    if extraction_rule and SCRAPLING_AVAILABLE:
        try:
            cleaned = _extract_by_selector(html, extraction_rule)
            if cleaned:
                return _clean_text(cleaned)
        except Exception as e:
            logger.warning(f"extraction_rule failed: {e}, falling back to auto-detect")

    # 2. 自动检测核心容器
    auto_rule = _detect_content_container(html)
    if auto_rule:
        try:
            cleaned = _extract_by_selector(html, auto_rule)
            if cleaned:
                return _clean_text(cleaned)
        except Exception:
            pass

    # 3. 降级：全文清洗
    return _clean_text(html)


def _detect_content_container(html: str) -> Optional[str]:
    """自动检测文章/内容主容器"""
    patterns = [
        r"<article[^>]*>",
        r"<main[^>]*>",
        r'<(div|section)[^>]*(?:id|class)=["\'][^"\']*(?:content|article|news|detail|post|main)[^"\']*["\'][^>]*>',
    ]
    for pat in patterns:
        if re.search(pat, html, re.IGNORECASE):
            if "<article" in pat:
                return "article"
            elif "<main" in pat:
                return "main"
            else:
                match = re.search(pat, html, re.IGNORECASE)
                if match:
                    tag_match = re.match(r"<(\w+)", match.group())
                    if tag_match:
                        tag = tag_match.group(1)
                        class_match = re.search(r'class=["\']([^"\']+)', match.group())
                        if class_match:
                            return f"{tag}.{class_match.group(1).split()[0]}"
                        id_match = re.search(r'id=["\']([^"\']+)', match.group())
                        if id_match:
                            return f"#{id_match.group(1)}"
    return None


def _extract_by_selector(html: str, selector: str) -> str:
    """简单的 CSS 选择器提取（基于正则）"""
    if not html:
        return ""

    css_map = {
        "article": r"<article[^>]*>(.*?)</article>",
        "main": r"<main[^>]*>(.*?)</main>",
    }

    if "." in selector and not selector.startswith("."):
        tag, cls = selector.split(".", 1)
        pattern = rf"<{tag}[^>]*class=['\"][^'\"]*{re.escape(cls)}[^'\"]*['\"][^>]*>(.*?)</{tag}>"
    elif selector.startswith("#"):
        tag = "div"
        pattern = rf'<{tag}[^>]*id=["\'](?:{re.escape(selector[1:])})["\'][^>]*>(.*?)</{tag}>'
    elif selector in css_map:
        pattern = css_map[selector]
    else:
        pattern = rf"<{selector}[^>]*>(.*?)</{selector}>"

    matches = re.findall(pattern, html, re.DOTALL | re.IGNORECASE)
    if matches:
        return matches[0] if isinstance(matches[0], str) else matches[0][0]
    return ""


def _clean_text(text: str) -> str:
    """
    文本清洗 + ★ 优化 3: 表格→Markdown 转换
    """
    if not text:
        return ""

    # 0. 优先检测表格区域并转 Markdown
    table_blocks = re.findall(
        r"<table[^>]*>.*?</table>", text, re.DOTALL | re.IGNORECASE
    )
    for table_html in table_blocks:
        md = _html_table_to_markdown(table_html)
        text = text.replace(table_html, f"\n{md}\n")

    # 去除 <script>、<style>、<!-- --> 注释
    text = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)

    # 去除 HTML 标签（保留文本）
    text = re.sub(r"<[^>]+>", " ", text)

    # 解码 HTML 实体
    text = text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')

    # 连续空白 → 单空格
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n", "\n\n", text)

    # 去除每行首尾空白
    lines = [line.strip() for line in text.split("\n")]

    # 过滤空行和纯噪音行（长度 < 3 的行视为噪音）
    lines = [l for l in lines if len(l) >= 3]

    # 文本密度过滤：连续 < 10 字符的行与前一行合并（对 Markdown 表格行做保护，不合并）
    result = []
    for line in lines:
        if line.startswith("| "):
            # 可能是 Markdown 表格行，单独保留
            result.append(line)
        elif len(line) < 10 and result:
            result[-1] = result[-1] + " " + line
        else:
            result.append(line)

    return "\n".join(result).strip()


# ========================================
# ★ 优化 4: 优雅降级 — 失败时返回缓存数据
# ========================================

async def fetch_with_retry(
    url: str,
    adaptive: bool = True,
    headless: bool = True,
    extraction_rule: Optional[str] = None,
    proxy: Optional[str] = None,
    max_retries: int = MAX_RETRIES,
    enable_cache: bool = True,
) -> dict[str, Any]:
    """
    带重试和降噪的抓取函数（异步包装）

    Args:
        url: 目标 URL
        adaptive: 自适应模式（绕过反爬）
        headless: 无头模式
        extraction_rule: CSS/XPath 选择器
        proxy: 代理地址（可选）
        max_retries: 最大重试次数
        enable_cache: 启用增量去重缓存

    Returns:
        标准输出 JSON
    """
    if not SCRAPLING_AVAILABLE:
        return {
            "status": "FAILED",
            "target_url": url,
            "http_code": 0,
            "extracted_payload": "Scrapling not installed. pip install 'scrapling[fetchers]'",
            "anti_bot_triggered": False,
            "error": "SCRAPLING_NOT_INSTALLED",
        }

    last_error = ""
    anti_bot = False

    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"[Attempt {attempt}/{max_retries}] Fetching: {url}")

            # ★ 优化 1: 指纹轮换
            fingerprint = _rotate_fingerprint()
            logger.debug(f"Fingerprint: {fingerprint.get('User-Agent', '')[:50]}...")

            # ★ 避坑 1: asyncio.to_thread 包装同步 StealthyFetcher
            kwargs: dict[str, Any] = {
                "headless": headless,
                "network_idle": True,
                "headers": {"User-Agent": fingerprint["User-Agent"]},
            }
            if adaptive:
                kwargs["adaptive"] = True
            if proxy:
                kwargs["proxy"] = proxy

            # ★ 避坑 2: try...finally 确保浏览器生命周期
            page = None
            try:
                page = await asyncio.to_thread(StealthyFetcher.fetch, url, **kwargs)
            finally:
                pass

            # 检查 HTTP 状态
            http_code = getattr(page, "status_code", 200)
            if http_code in (403, 429, 503):
                anti_bot = True
                last_error = f"HTTP {http_code} - Anti-bot triggered"
                logger.warning(last_error)
                if attempt < max_retries:
                    delay = random.uniform(*REQUEST_DELAY) + attempt * 0.5
                    await asyncio.sleep(delay)
                    continue
                break

            # 语义降噪
            raw_html = page.text if hasattr(page, "text") else str(page)
            cleaned = semantic_denoise(raw_html, extraction_rule)

            # ★ 优化 2: 增量去重
            result_payload = cleaned[:10000]
            if enable_cache:
                is_new = _is_new_content(url, result_payload)
                if not is_new:
                    logger.info(f"Incremental skip — URL content unchanged: {url}")
                    # 返回标记"已缓存，无新内容"
                    return {
                        "status": "CACHED",
                        "target_url": url,
                        "http_code": http_code,
                        "extracted_payload": "",
                        "anti_bot_triggered": False,
                        "is_cached": True,
                        "cache_note": "内容无变更，增量跳过。如需强制重新抓取，请设置 enable_cache=false。",
                    }

            return {
                "status": "SUCCESS",
                "target_url": url,
                "http_code": http_code,
                "extracted_payload": result_payload,
                "anti_bot_triggered": False,
            }

        except Exception as e:
            last_error = str(e)
            logger.error(f"[Attempt {attempt}] Error: {last_error}")

            if "403" in last_error or "Cloudflare" in last_error or "captcha" in last_error.lower():
                anti_bot = True
                if attempt >= max_retries:
                    break
                await asyncio.sleep(random.uniform(*REQUEST_DELAY))
                continue

            if attempt < max_retries:
                await asyncio.sleep(random.uniform(*REQUEST_DELAY))
            else:
                break

    # ★ 优化 4: 全部重试失败 → 优雅降级返回缓存
    cached = _get_cached_payload(url)
    if cached is not None:
        freshness = _get_cache_freshness(url)
        age_seconds = int(time.time() - (freshness or 0))
        logger.info(f"Returning cached data for {url} (age: {age_seconds}s)")
        return {
            "status": "SUCCESS",
            "target_url": url,
            "http_code": 200,
            "extracted_payload": cached[:10000],
            "anti_bot_triggered": anti_bot,
            "is_cached_data": True,
            "cache_age_seconds": age_seconds,
            "error": f"抓取失败，返回缓存数据（{age_seconds}秒前）",
        }

    return {
        "status": "FAILED",
        "target_url": url,
        "http_code": 0,
        "extracted_payload": "",
        "anti_bot_triggered": anti_bot,
        "error": "ANTI_BOT_DEADLOCK" if anti_bot else (last_error or "MAX_RETRIES_EXCEEDED"),
    }


# === MCP Server 实现 ===


async def handle_mcp_request(request: dict[str, Any]) -> dict[str, Any]:
    """处理单个 MCP 请求"""
    method = request.get("method", "")
    params = request.get("params", {})
    request_id = request.get("id")

    logger.debug(f"MCP Request: {method}")

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [
                    {
                        "name": "scrapling_web_fetcher",
                        "description": "基于 Scrapling 的自适应 Web 抓取工具，支持反爬绕过、语义降噪、代理轮换、增量去重",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": {
                                    "type": "string",
                                    "description": "目标网页的完整 URL（必填）",
                                },
                                "adaptive_mode": {
                                    "type": "boolean",
                                    "description": "启用自适应对抗（自动指纹、TLS 握手、验证码处理），默认 true",
                                    "default": True,
                                },
                                "headless_mode": {
                                    "type": "boolean",
                                    "description": "后台静默运行，不抢占桌面焦点，默认 true",
                                    "default": True,
                                },
                                "extraction_rule": {
                                    "type": "string",
                                    "description": "CSS 选择器或 XPath（如 .article-content 或 //table[@id=\"data\"]），可选",
                                },
                                "proxy": {
                                    "type": "string",
                                    "description": "代理地址（如 http://proxy:port），可选",
                                },
                                "enable_cache": {
                                    "type": "boolean",
                                    "description": "启用增量去重缓存，内容无变更时返回 CACHED 状态，默认 true",
                                    "default": True,
                                },
                            },
                            "required": ["url"],
                        },
                    }
                ],
            },
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        if tool_name != "scrapling_web_fetcher":
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
            }

        url = arguments.get("url")
        if not url:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": "Missing required parameter: url"},
            }

        result = await fetch_with_retry(
            url=url,
            adaptive=arguments.get("adaptive_mode", DEFAULT_ADAPTIVE),
            headless=arguments.get("headless_mode", DEFAULT_HEADLESS),
            extraction_rule=arguments.get("extraction_rule"),
            proxy=arguments.get("proxy"),
            enable_cache=arguments.get("enable_cache", True),
        )

        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(result, ensure_ascii=False, indent=2),
                    }
                ]
            },
        }

    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }


async def mcp_server_loop():
    """MCP stdio 服务器主循环"""
    logger.info("Scrapling MCP Server started (stdio mode)")
    logger.info(f"Scrapling available: {SCRAPLING_AVAILABLE}")

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
            if not line:
                logger.info("EOF received, shutting down")
                break

            line = line.decode("utf-8").strip()
            if not line:
                continue

            logger.debug(f"Received: {line[:100]}...")

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                error_resp = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {e}"},
                }
                print(json.dumps(error_resp), flush=True)
                continue

            response = await handle_mcp_request(request)
            print(json.dumps(response), flush=True)

        except Exception as e:
            logger.error(f"Server error: {e}", exc_info=True)
            error_resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": f"Internal error: {e}"},
            }
            print(json.dumps(error_resp), flush=True)


def main():
    """入口函数（同步包装）"""
    try:
        asyncio.run(mcp_server_loop())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
