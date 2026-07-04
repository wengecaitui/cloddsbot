# CloddsBot 全量依赖树

**总依赖数**: 1724 个包 (lockfile)

## ai_providers (4)

- @anthropic-ai

## cex (19)

- binance
- bybit-api
- hyperliquid
- node-domexception

## db_storage (18)

- @ioredis
- better-sqlite3
- ioredis
- pg
- pg-cloudflare
- pg-connection-string
- pg-int8
- pg-pool
- pg-protocol
- pg-types
- pgpass
- postgres-array
- postgres-bytea
- postgres-date
- postgres-interval
- redis-errors
- redis-parser
- sql.js

## evm (11)

- ethers
- ethers-multicall-provider
- viem

## infra (36)

- @inquirer
- @pinojs
- browser-headers
- browserslist
- bullmq
- chalk
- commander
- cron-parser
- dotenv
- express
- inquirer
- is-windows
- isomorphic-ws
- isows
- js-yaml
- jws
- node-cron
- path-expression-matcher
- pino
- pino-abstract-transport
- ...(7 more)

## math_computation (10)

- @noble
- bigint-buffer
- bn.js
- decimal.js
- decimal.js-light
- math-intrinsics

## messaging (30)

- @discordjs
- @slack
- baseline-browser-mapping
- discord-api-types
- discord.js
- libsignal
- lines-and-columns
- signal-exit

## prediction_markets (11)

- @drift-labs

## solana (291)

- @jup-ag
- @kamino-finance
- @metaplex-foundation
- @meteora-ag
- @orca-so
- @raydium-io
- @solana
- @solana-program
- pump
- solana-bankrun
- solana-bankrun-darwin-arm64
- solana-bankrun-darwin-universal
- solana-bankrun-darwin-x64
- solana-bankrun-linux-x64-gnu
- solana-bankrun-linux-x64-musl

## 精度风险区清单

### 数学计算库

| 库 | 版本 | 使用文件数 | 精度风险 | 备注 |
|----|------|-----------|---------|------|
| bn.js | 5.2.3 | 0+ | 中 | Solana签名/链上计算 |
| @types/bn.js | 5.2.0 | 0+ | 中 | Solana签名/链上计算 |
| @noble/hashes | 1.8.0 | 0+ | 中 | Solana签名/链上计算 |
| @noble/ed25519 | 2.3.0 | 0+ | 中 | Solana签名/链上计算 |
| @noble/secp256k1 | 3.0.0 | 0+ | 中 | Solana签名/链上计算 |

### 技术指标库

项目中没有独立的指标库依赖。技术指标计算直接在 TypeScript 代码中硬编码。

### 内联指标计算位置

| 文件 | 涉及的指标 | 风险 |
|------|-----------|------|
| src\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\types.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\@types\marginfi-client-v2.d.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\acp\agreement.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\acp\discovery.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\acp\escrow.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\acp\identity.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\acp\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\acp\persistence.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\acp\registry.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\agents\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\agents\subagents.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\agents\tool-registry.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\acp.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\agentbets.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\arbitrage.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\betfair.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\binance.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\bittensor.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\bybit.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\credentials.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\hyperliquid.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\kalshi.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\manifold.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\markets.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\opinion.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\paper-trading.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\polymarket.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\predictfun.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\smarkets.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\solana.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\types.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\virtuals.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\agents\handlers\wallets.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\alerts\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\arbitrage\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\auth\copilot.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\auth\google.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\auth\oauth.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\auth\qwen.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\auto-reply\index.ts | ATR | 中（TS手算 vs Python无标准库可对比）|
| src\bin\worker.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\bittensor\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\bittensor\persistence.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\bittensor\service.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\bittensor\types.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\browser\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cache\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\canvas\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\channels\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\channels\bluebubbles\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\channels\discord\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\channels\googlechat\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\channels\imessage\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\channels\matrix\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\channels\mattermost\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\channels\teams\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\channels\telegram\index.ts | indicator | 中（TS手算 vs Python无标准库可对比）|
| src\channels\voice\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\channels\webchat\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\channels\whatsapp\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cli\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cli\secure.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\cli\commands\doctor.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cli\commands\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cli\commands\onboard.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cli\commands\repl.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\cli\commands\skills.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\commands\registry.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\config\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\credentials\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\cron\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\daemon\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\db\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\db\migrations.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\docker\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\doctor\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\embeddings\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\evm\contracts.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\evm\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\evm\pancakeswap.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\evm\transfers.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\evm\wallet.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\exchanges\lighter\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\exchanges\mexc\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\exchanges\opinion\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\exchanges\predictfun\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\execution\auto-redeem.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\execution\bracket-orders.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\execution\dca-persistence.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\execution\dca.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\execution\futures.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\execution\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\execution\order-persistence.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\execution\smart-router.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\execution\twap.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\extensions\google-auth\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\extensions\llm-task\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\extensions\memory-lancedb\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\extensions\open-prose\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\extensions\task-runner\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\descriptors.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\registry.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\acled\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\agentbets\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\betfair\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\crypto\whale-tracker.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\fred\index.ts | indicator | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\kalshi\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\manifold\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\metaculus\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\news\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\polymarket\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\polymarket\user-ws.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\smarkets\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\feeds\weather-openmeteo\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\api-routes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\bracket-routes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\control-ui.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\dca-routes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\embeddings-routes.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\launch-routes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\monitoring-routes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\routing-routes.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\server.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\signal-bus.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\gateway\twap-routes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\history\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\hooks\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\identity\erc8004.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\infra\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\infra\retry.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\ledger\anchor.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\ledger\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\ledger\storage.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\link-understanding\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\logging\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\macos\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\markdown\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\market-index\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\mcp\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\mcp\installer.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\mcp\server.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\media\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\memory\context.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\memory\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\ml-pipeline\trainer.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\monitoring\alerts.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\monitoring\health.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\monitoring\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\nodes\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\analytics.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\combinatorial.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\correlation.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\executor.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\links.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\matching.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\outcomes.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\risk.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\opportunity\scoring.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\pairing\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\payments\x402\evm.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\payments\x402\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\payments\x402\solana.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\percolator\accounts.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\percolator\slab.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\percolator\tx.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\permissions\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\plugins\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\portfolio\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\presence\index.ts | indicator | 中（TS手算 vs Python无标准库可对比）|
| src\process\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\providers\discovery.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\providers\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\queue\jobs\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\queue\jobs\producer.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\queue\jobs\types.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\remote\index.ts | ATR | 中（TS手算 vs Python无标准库可对比）|
| src\risk\dashboard.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\risk\engine.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\risk\stress.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\risk\volatility.ts | ATR | 中（TS手算 vs Python无标准库可对比）|
| src\routing\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\search\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\security\address-checker.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\security\code-scanner.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\security\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\security\scam-db.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\services\alt-data\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\services\alt-data\market-matcher.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\services\alt-data\sentiment.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\services\feature-engineering\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\services\feature-engineering\indicators.ts | indicator | 中（TS手算 vs Python无标准库可对比）|
| src\services\tick-recorder\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\services\tick-recorder\schema.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\services\tick-recorder\timescale.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\services\tick-streamer\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\session\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\sessions\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\signal-router\router.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\signal-router\types.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\errors.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\executor.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\loader.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\registry.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\acp\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\agentbets\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\ai-strategy\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\alerts\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\analytics\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\arbitrage\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\backtest\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\bags\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\bankr\index.ts | ATR | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\betfair\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\binance-futures\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\bridge\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\bybit-futures\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\copy-trading\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\credentials\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\crypto-hft\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\dca\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\divergence\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\doctor\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\drift\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\drift-sdk\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\embeddings\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\erc8004\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\execution\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\feeds\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\harden\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\history\index.ts | ATR | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\hyperliquid\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\integrations\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\jupiter\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\kamino\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\lighter\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\market-index\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\markets\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\mcp\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\memory\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\meteora-dbc\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\mexc-futures\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\mm\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\monitoring\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\onchainkit\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\opinion\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\opportunity\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\plugins\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\portfolio\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\predictfun\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\predictit\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\presence\index.ts | indicator | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\pump-swarm\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\pumpfun\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\qmd\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\qrcoin\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\research\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\risk\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\router\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\search-config\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\setup\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\signals\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\smarkets\index.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\solend\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\strategy\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\streaming\index.ts | indicator | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\tailscale\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\token-security\index.ts | ATR | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\trading-kalshi\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\trading-manifold\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\trading-polymarket\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\trading-system\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\tts\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\tweet-ideas\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\veil\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\voice\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\weather\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\x-research\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\skills\bundled\yoink\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\solana\copytrade.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\drift.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\solana\jupiter.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\marginfi.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\solana\meteora-dbc.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\meteora.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\solana\pump-swarm.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\pumpapi.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\raydium.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\swarm-ai-builder.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\solana\swarm-arbitrage.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\swarm-builders.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\swarm-copytrade.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\swarm-signals.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\solana\swarm-strategies.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\solana\wallet.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\crypto-hft\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\crypto-hft\market-scanner.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\crypto-hft\positions.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\crypto-hft\presets.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\crypto-hft\strategies.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\crypto-hft\types.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\hft-divergence\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\hft-divergence\market-rotator.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\strategies\hft-divergence\strategy.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\streaming\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\tailscale\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\telemetry\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\terminal\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\tools\browser.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\tools\docker.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\tools\email.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\tools\exec.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\tools\files.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\tools\image.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\tools\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\tools\nodes.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\tools\web-fetch.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\accounts.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\builder.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\copy-trading.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\trading\devtools.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\kelly.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\trading\logger.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\ml-signals.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\position-bridge.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\resilience.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\trading\risk.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\safety.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\secrets.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\state.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\stream.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\trading\tracking.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\trading\bots\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\futures\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\market-making\engine.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\trading\market-making\strategy.ts | EMA | 中（TS手算 vs Python无标准库可对比）|
| src\trading\market-making\types.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\attachments.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\config.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\id.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\json-utils.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\polymarket-order-signer.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\polymarket-setup.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\production.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\utils\rate-limiter.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\utils\webhook-security.ts | SMA | 中（TS手算 vs Python无标准库可对比）|
| src\wizard\index.ts | RSI | 中（TS手算 vs Python无标准库可对比）|
| src\workspace\index.ts | EMA | 中（TS手算 vs Python无标准库可对比）|

**结论**: 指标逻辑都在 TypeScript 里手算，没有依赖第三方 Python/Native 指标库。Phase 4 桥接层如果要对接到 Python，需要做精度对比测试。
