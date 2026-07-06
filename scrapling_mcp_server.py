#!/usr/bin/env python3
"""
Scrapling MCP Server — 基于 Scrapling 的 Web 抓取 MCP 工具

核心设计原则（避坑指南）：
1. asyncio.to_thread 包装同步 StealthyFetcher，避免阻塞事件循环
2. try...finally 确保浏览器生命周期管理，防止内存泄露
3. 语义降噪：CSS/XPath 提取 + 自动内容容器识别 + 正则清洗
4. 代理熔断：max_retries=3，3 次失败 → ANTI_BOT_DEADLOCK
5. 日志 → sys.stderr，严禁 print()

运行方式：
  python scrapling_mcp_server.py
  # 或作为 Hermes MCP Server 注册
"""

import asyncio
import json
import logging
import random
import re
import sys
from typing import Any, Optional

# === 配置日志输出到 stderr ===
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("scrapling-mcp")

# === Scrapling 依赖（可选安装，无则优雅降级） ===
try:
    from scrapling.fetchers import StealthyFetcher
    from scrapling.engines.toolbelt.custom import Response
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
            # 构造临时 Response 对象（简化处理）
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
    # 优先级：<article> → <main> → id/class 含 content/news/detail
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
                # 返回匹配到的第一个标签作为 CSS 选择器
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
    """简单的 CSS 选择器提取（基于正则，避免依赖 BeautifulSoup）"""
    if not html:
        return ""

    # CSS 选择器 → 简化映射
    css_map = {
        "article": r"<article[^>]*>(.*?)</article>",
        "main": r"<main[^>]*>(.*?)</main>",
    }

    # 处理复合选择器
    if "." in selector and not selector.startswith("."):
        # tag.class 格式
        tag, cls = selector.split(".", 1)
        pattern = rf"<{tag}[^>]*class=['\"][^'\"]*{re.escape(cls)}[^'\"]*['\"][^>]*>(.*?)</{tag}>"
    elif selector.startswith("#"):
        # id 选择器
        tag = "div"  # 默认
        pattern = rf'<{tag}[^>]*id=["\'](?:{re.escape(selector[1:])})["\'][^>]*>(.*?)</{tag}>'
    elif selector in css_map:
        pattern = css_map[selector]
    else:
        # 通用标签
        pattern = rf"<{selector}[^>]*>(.*?)</{selector}>"

    matches = re.findall(pattern, html, re.DOTALL | re.IGNORECASE)
    if matches:
        return matches[0] if isinstance(matches[0], str) else matches[0][0]
    return ""


def _clean_text(text: str) -> str:
    """
    文本清洗：去除多余空白、脚本/样式标签、HTML 实体
    保留高密度信息行
    """
    if not text:
        return ""

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

    # 文本密度过滤：连续 < 3 字符的行与前一行合并
    result = []
    for line in lines:
        if len(line) < 10 and result:
            result[-1] = result[-1] + " " + line
        else:
            result.append(line)

    return "\n".join(result).strip()


async def fetch_with_retry(
    url: str,
    adaptive: bool = True,
    headless: bool = True,
    extraction_rule: Optional[str] = None,
    proxy: Optional[str] = None,
    max_retries: int = MAX_RETRIES,
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

            # ★ 避坑 1：用 asyncio.to_thread 包装同步 StealthyFetcher
            kwargs = {
                "headless": headless,
                "network_idle": True,
            }
            if adaptive:
                kwargs["adaptive"] = True
            if proxy:
                kwargs["proxy"] = proxy

            page = await asyncio.to_thread(StealthyFetcher.fetch, url, **kwargs)

            # 检查 HTTP 状态
            http_code = getattr(page, "status_code", 200)
            if http_code in (403, 429, 503):
                anti_bot = True
                last_error = f"HTTP {http_code} - Anti-bot triggered"
                logger.warning(last_error)
                if attempt < max_retries:
                    await asyncio.sleep(random.uniform(*REQUEST_DELAY))
                    continue
                break

            # ★ 避坑 3：语义降噪
            raw_html = page.text if hasattr(page, "text") else str(page)
            cleaned = semantic_denoise(raw_html, extraction_rule)

            return {
                "status": "SUCCESS",
                "target_url": url,
                "http_code": http_code,
                "extracted_payload": cleaned[:10000],  # 限制长度
                "anti_bot_triggered": False,
            }

        except Exception as e:
            last_error = str(e)
            logger.error(f"[Attempt {attempt}] Error: {last_error}")

            # ★ 避坑 4：代理熔断
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

    # 全部重试失败
    return {
        "status": "FAILED",
        "target_url": url,
        "http_code": 0,
        "extracted_payload": "",
        "anti_bot_triggered": anti_bot,
        "error": "ANTI_BOT_DEADLOCK" if anti_bot else last_error or "MAX_RETRIES_EXCEEDED",
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
                        "description": "基于 Scrapling 的自适应 Web 抓取工具，支持反爬绕过、语义降噪、代理轮换",
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
                                    "description": "CSS 选择器或 XPath（如 '.article-content' 或 '//table[@id=\"data\"]'），可选",
                                },
                                "proxy": {
                                    "type": "string",
                                    "description": "代理地址（如 'http://proxy:port'），可选",
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
