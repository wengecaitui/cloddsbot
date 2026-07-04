# Skill Schema 矩阵 (Phase 2.1)

**提取时间**: 2026-07-05
**来源**: `src/agents/index.ts` → `buildTools()` 函数
**总工具数**: 216

---

## 分类统计

| 分类 | 数量 | 说明 |
|------|------|------|
| 📖 Read-Only | 150 | 查询余额/行情/列表，可放宽超时 |
| ✍️ Write-Action | 66 | 下单/撤单/执行，必须走 Fast 路径 |

## Write-Action 工具清单 (必须走 Fast Path)

| 工具名 | 描述 |
|--------|------|
| `create_alert` | Exclude sports-related markets (default true) |
| `delete_alert` | Minimum liquidity threshold (best-effort per platform) |
| `get_wallet_trades` | Minimum similarity score to include |
| `get_top_traders` | Optional list of platforms to report |
| `copy_trade` | Get the last market index sync summary. |
| `execute_arbitrage` | Max snapshots to return (default 200) |
| `polymarket_buy` | Market name (for display) |
| `polymarket_sell` | Alert condition |
| `polymarket_cancel_all` | List all active alerts for the user |
| `polymarket_orderbook` | Delete an alert |
| `polymarket_cancel` | Get recent market-moving news |
| `polymarket_orders` | Number of items (default 10) |
| `polymarket_market_sell` | Search news by keyword |
| `polymarket_market_buy` | Search query |
| `polymarket_maker_buy` | Get news relevant to a specific market |
| `polymarket_maker_sell` | The market question to find news for |
| `polymarket_last_trade` | Market category for finding relevant external data |
| `polymarket_trades` | Current market price (0.0-1.0) |
| `polymarket_cancel_market` | Your estimated true probability (0.0-1.0) |
| `orderbook_imbalance` | Wallet address (0x...) or username depending on platform |
| `polymarket_orderbooks_batch` | Get leaderboard of top traders/forecasters by profit, ROI, or accuracy |
| `polymarket_last_trades_batch` | Sort criteria |
| `polymarket_market_trades_events` | Wallet to copy from |
| `polymarket_get_order` | Trade ID to copy |
| `polymarket_post_orders_batch` | Size multiplier (0.1 = 10% of their size, 1.0 = same size) |
| `polymarket_cancel_orders_batch` | Enable automatic copy trading for a wallet |
| `polymarket_create_api_key` | Wallet to auto-copy |
| `polymarket_delete_api_key` | Only copy if wallet has > this win rate (0-1) |
| `polymarket_create_readonly_api_key` | Disable automatic copy trading for a wallet |
| `polymarket_delete_readonly_api_key` | List all wallets with auto-copy enabled and their settings |
| `polymarket_update_balance_allowance` | Minimum edge % to report (default 1%) |
| `polymarket_is_order_scoring` | internal (YES+NO) | cross (price gaps) | both |
| `polymarket_are_orders_scoring` | Minimum 24h volume filter (default 0) |
| `polymarket_orderbook_hash` | Execute a YES+NO arbitrage trade (buy both YES and NO when sum < $1 for guarante |
| `kalshi_buy` | Order ID to cancel |
| `kalshi_sell` | Get all open orders on Polymarket |
| `kalshi_orders` | Token ID to buy |
| `kalshi_cancel` | USDC amount to spend (e.g., 50 for $50) |
| `kalshi_orderbook` | Token ID to sell |
| `kalshi_market_trades` | Price (0.01-0.99). Must be ABOVE current bid to be maker. |
| `kalshi_market_order` | Get the last trade price for a token. |
| `kalshi_batch_create_orders` | Get the tick size (minimum price increment) for a token. Returns "0.1", "0.01",  |
| `kalshi_batch_cancel_orders` | Get trade history for your account. Shows recent fills with prices and sizes. |
| `kalshi_cancel_all` | Optional: filter by market (condition_id) |
| `kalshi_get_order` | Optional: filter by token |
| `kalshi_amend_order` | Cancel all orders for a specific market or token. More targeted than cancel_all. |
| `kalshi_decrease_order` | Market condition_id to cancel orders for |
| `kalshi_create_api_key` | Platform (polymarket or kalshi) |
| `kalshi_delete_api_key` | Token ID (Polymarket) or ticker (Kalshi) |
| `kalshi_create_order_group` | If true, returns neg_risk exchange (for crypto markets) |
| `kalshi_order_groups` | Get the best price for a specific side (BUY or SELL). |
| `kalshi_order_group` | BUY or SELL |
| `kalshi_order_group_limit` | Check if a token is in a negative risk market. Use the /fee-rate endpoint to che |
| `kalshi_order_group_trigger` | Get midpoint prices for multiple tokens at once. |
| `kalshi_order_group_reset` | Array of token IDs |
| `kalshi_delete_order_group` | Get best prices for multiple tokens at once. |
| `kalshi_resting_order_value` | Array of {token_id, side} objects |
| `kalshi_create_subaccount` | Get spreads for multiple tokens at once. |
| `kalshi_subaccount_transfer` | Get orderbooks for multiple tokens at once. |
| `kalshi_subaccount_transfers` | Array of token IDs |
| `kalshi_create_rfq` | Array of token IDs |
| `kalshi_cancel_rfq` | Results per page (default 25, max 100) |
| `kalshi_create_quote` | Get simplified market list (returns 25 per page, use next_cursor to paginate). |
| `kalshi_cancel_quote` | Get featured/trending markets (returns 25 per page, use next_cursor to paginate) |
| `kalshi_fcm_orders` | List all your API keys. |
| `manifold_sell` | The read-only API key to delete |


## Read-Only 工具清单 (可走 Slow/Fast 均可)

| 工具名 | 描述 |
|--------|------|
| `search_markets` | Search prediction markets by keyword across all platforms. Returns top results w |
| `get_market` | Search query (e.g., "Trump 2028", "Fed rate cut", "Bitcoin 100k") |
| `market_index_sync` | Optional: filter to specific platform |
| `market_index_search` | Get detailed info about a specific market including all outcomes and prices |
| `market_index_stats` | The market ID or slug |
| `market_index_last_sync` | The platform |
| `market_index_prune` | Sync market index for semantic search (Polymarket, Kalshi, Manifold, Metaculus). |
| `get_portfolio` | Optional list of platforms to sync |
| `get_portfolio_history` | Max markets to index per platform (default 500) |
| `add_position` | Market status filter |
| `list_alerts` | Minimum 24h volume threshold (best-effort per platform) |
| `get_recent_news` | Minimum open interest threshold (Kalshi only) |
| `search_news` | Minimum number of predictions (Metaculus only) |
| `get_news_for_market` | Exclude resolved markets regardless of status filter |
| `analyze_edge` | Semantic search over indexed markets. |
| `calculate_kelly` | Search query |
| `watch_wallet` | Optional platform filter |
| `unwatch_wallet` | Max results (default 10) |
| `list_watched_wallets` | Max candidates to consider (default 1500) |
| `get_wallet_positions` | Optional per-platform weights (overrides config) |
| `get_wallet_pnl` | Get indexed market counts by platform. |
| `enable_auto_copy` | Prune stale indexed markets. |
| `disable_auto_copy` | Optional platform to prune |
| `list_auto_copy` | Age in ms beyond which entries are removed |
| `find_arbitrage` | Get portfolio P&L history snapshots for the user |
| `compare_prices` | Only return snapshots after this timestamp (ms) |
| `paper_trading_mode` | Sort order (default desc) |
| `paper_balance` | Manually track a position (for platforms without API sync) |
| `paper_positions` | Platform name |
| `paper_reset` | Market question text |
| `paper_history` | Outcome name (e.g., "Yes", "No", "Trump") |
| `whale_alerts` | Number of shares |
| `new_market_alerts` | Average entry price (0.0-1.0) |
| `volume_spike_alerts` | Create a price alert for a market |
| `polymarket_positions` | Threshold (0.0-1.0 for price, percentage for change) |
| `polymarket_balance` | Alert ID to delete |
| `polymarket_fee_rate` | Analyze potential edge by comparing market price to external models (538, CME Fe |
| `polymarket_midpoint` | Market question |
| `polymarket_spread` | Current market price (0.0-1.0) |
| `polymarket_tick_size` | Calculate Kelly criterion bet sizing given edge estimate |
| `polymarket_estimate_fill` | Available bankroll in dollars |
| `polymarket_market_info` | Start tracking a wallet/user for real-time trade alerts. Get notified when they  |
| `polymarket_health` | Optional nickname for this wallet (e.g., "Whale #1") |
| `polymarket_server_time` | Stop tracking a wallet address |
| `polymarket_get_address` | Wallet address to stop watching |
| `polymarket_collateral_address` | List all wallets you are currently tracking |
| `polymarket_conditional_address` | Get recent trades for a specific wallet/user |
| `polymarket_exchange_address` | Wallet address or username depending on platform |
| `polymarket_price` | Number of trades (default 20) |
| `polymarket_neg_risk` | Get current positions for a wallet/user |

... 以及另外 100 个 Read-Only 工具（完整清单见 `SKILL_MATRIX.csv`）


## 精度风险区（数学/指标库）

| 库 | 版本 | 位置 | 风险 | 处理方案 |
|----|------|------|------|---------|
| `bn.js` | 5.2.3 | src/agents/index.ts + solana/* | 高 | Phase 4: Python bridge |
| `@noble/hashes` | 1.8.0 | src/solana/wallet.ts | 中 | Phase 4: 大数精度对齐 |
| `@noble/ed25519` | 2.3.0 | src/solana/wallet.ts | 中 | Phase 4: 签名序列化对比 |
| `@noble/secp256k1` | 3.0.0 | src/agents/index.ts | 中 | Phase 4: 签名序列化对比 |

**外部指标库**: 无。所有技术指标计算直接在 TypeScript 内联实现。
**Phase 4 行动**: 对每个高风险库，提取输入/输出样例 → Python 重算 → 对比 JSON 序列化是否一致。
