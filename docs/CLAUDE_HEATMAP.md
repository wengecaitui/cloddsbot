# Claude 代码热力图 (v1.8.0)

**生成时间**: 2026-07-05T02:42:58.164203
**Fast/Slow 比**: 21 / 372 = 5.3% / 94.7%

---

## 按文件汇总

- **src\agents\index.ts**: 46 行 (⚡11 🧠35)
- **src\agents\subagents.ts**: 26 行 (⚡6 🧠20)
- **src\auth\oauth.ts**: 9 行 (⚡0 🧠9)
- **src\channels\telegram\index.ts**: 1 行 (⚡0 🧠1)
- **src\cli\commands\doctor.ts**: 11 行 (⚡0 🧠11)
- **src\cli\commands\index.ts**: 50 行 (⚡0 🧠50)
- **src\cli\commands\onboard.ts**: 17 行 (⚡0 🧠17)
- **src\cli\index.ts**: 1 行 (⚡0 🧠1)
- **src\commands\index.ts**: 13 行 (⚡0 🧠13)
- **src\commands\registry.ts**: 10 行 (⚡0 🧠10)
- **src\config\index.ts**: 2 行 (⚡0 🧠2)
- **src\doctor\index.ts**: 13 行 (⚡0 🧠13)
- **src\extensions\open-prose\index.ts**: 5 行 (⚡0 🧠5)
- **src\extensions\task-runner\index.ts**: 2 行 (⚡0 🧠2)
- **src\gateway\index.ts**: 1 行 (⚡0 🧠1)
- **src\gateway\server.ts**: 1 行 (⚡0 🧠1)
- **src\hooks\index.ts**: 3 行 (⚡3 🧠0)
- **src\index.ts**: 5 行 (⚡0 🧠5)
- **src\infra\retry.ts**: 4 行 (⚡0 🧠4)
- **src\mcp\index.ts**: 2 行 (⚡1 🧠1)
- **src\mcp\installer.ts**: 17 行 (⚡0 🧠17)
- **src\media\index.ts**: 11 行 (⚡0 🧠11)
- **src\memory\context.ts**: 33 行 (⚡0 🧠33)
- **src\memory\summarizer.ts**: 9 行 (⚡0 🧠9)
- **src\memory\tokenizer.ts**: 9 行 (⚡0 🧠9)
- **src\models\adaptive.ts**: 11 行 (⚡0 🧠11)
- **src\models\failover.ts**: 5 行 (⚡0 🧠5)
- **src\models\index.ts**: 1 行 (⚡0 🧠1)
- **src\providers\discovery.ts**: 6 行 (⚡0 🧠6)
- **src\providers\index.ts**: 34 行 (⚡0 🧠34)
- **src\sessions\index.ts**: 1 行 (⚡0 🧠1)
- **src\skills\bundled\doctor\index.ts**: 1 行 (⚡0 🧠1)
- **src\skills\bundled\usage\index.ts**: 1 行 (⚡0 🧠1)
- **src\skills\bundled\x-research\index.ts**: 1 行 (⚡0 🧠1)
- **src\strategies\hft-divergence\detector.ts**: 1 行 (⚡0 🧠1)
- **src\strategies\hft-divergence\index.ts**: 1 行 (⚡0 🧠1)
- **src\tools\image.ts**: 10 行 (⚡0 🧠10)
- **src\tools\web-fetch.ts**: 3 行 (⚡0 🧠3)
- **src\types.ts**: 1 行 (⚡0 🧠1)
- **src\usage\index.ts**: 3 行 (⚡0 🧠3)
- **src\utils\config.ts**: 1 行 (⚡0 🧠1)
- **src\wizard\index.ts**: 6 行 (⚡0 🧠6)
- **src\workspace\index.ts**: 5 行 (⚡0 🧠5)

---

## 详细列表

### src\agents\index.ts:6 🧠 [Slow]

```typescript
import Anthropic from '@anthropic-ai/sdk';
```

### src\agents\index.ts:39 🧠 [Slow]

```typescript
import { MemoryService, createClaudeSummarizer } from '../memory';
```

### src\agents\index.ts:220 🧠 [Slow]

```typescript
const SYSTEM_PROMPT = `You are Clodds, an AI assistant for prediction markets. Claude + Odds.
```

### src\agents\index.ts:345 🧠 [Slow]

```typescript
const MEMORY_EXTRACT_MODEL = process.env.CLODDS_MEMORY_EXTRACT_MODEL || process.env.CLODDS_SUMMARY_MODEL || 'claude-3-5-haiku-20241022';
```

### src\agents\index.ts:448 🧠 [Slow]

```typescript
async function extractMemoryWithClaude(
```

### src\agents\index.ts:449 🧠 [Slow]

```typescript
client: Anthropic,
```

### src\agents\index.ts:474 🧠 [Slow]

```typescript
.map((b) => (b as Anthropic.TextBlock).text)
```

### src\agents\index.ts:16961 🧠 [Slow]

```typescript
// Return a helpful message so Claude doesn't get a confusing error.
```

### src\agents\index.ts:17009 🧠 [Slow]

```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
```

### src\agents\index.ts:17011 🧠 [Slow]

```typescript
throw new Error('ANTHROPIC_API_KEY environment variable is required');
```

### src\agents\index.ts:17014 🧠 [Slow]

```typescript
const client = new Anthropic({ apiKey });
```

### src\agents\index.ts:17125 🧠 [Slow]

```typescript
const summarizer = createClaudeSummarizer();
```

### src\agents\index.ts:17272 🧠 [Slow]

```typescript
const messages: Anthropic.MessageParam[] = [];
```

### src\agents\index.ts:17304 ⚡ [Fast]

```typescript
const createMessageWithRetry = (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
```

### src\agents\index.ts:17306 🧠 [Slow]

```typescript
() => client.messages.create(params) as Promise<Anthropic.Message>,
```

### src\agents\index.ts:17327 🧠 [Slow]

```typescript
const extractResponseText = (response: Anthropic.Message): string => {
```

### src\agents\index.ts:17328 🧠 [Slow]

```typescript
const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
```

### src\agents\index.ts:17333 🧠 [Slow]

```typescript
params: Anthropic.MessageCreateParamsNonStreaming
```

### src\agents\index.ts:17334 🧠 [Slow]

```typescript
): Promise<Anthropic.Message> => {
```

### src\agents\index.ts:17448 🧠 [Slow]

```typescript
params: Anthropic.MessageCreateParamsNonStreaming
```

### src\agents\index.ts:17449 🧠 [Slow]

```typescript
): Promise<Anthropic.Message> => {
```

### src\agents\index.ts:17565 🧠 [Slow]

```typescript
'claude-opus-4-6': 200000,
```

### src\agents\index.ts:17566 🧠 [Slow]

```typescript
'claude-opus-4-5-20250514': 200000,
```

### src\agents\index.ts:17567 🧠 [Slow]

```typescript
'claude-sonnet-4-5-20250929': 200000,
```

### src\agents\index.ts:17568 🧠 [Slow]

```typescript
'claude-sonnet-4-20250514': 200000,
```

### src\agents\index.ts:17569 🧠 [Slow]

```typescript
'claude-haiku-4-5-20251001': 200000,
```

### src\agents\index.ts:17570 🧠 [Slow]

```typescript
'claude-haiku-3-5-20250514': 200000,
```

### src\agents\index.ts:17571 🧠 [Slow]

```typescript
'claude-3-5-sonnet-20241022': 200000,
```

### src\agents\index.ts:17572 🧠 [Slow]

```typescript
'claude-3-opus-20240229': 200000,
```

### src\agents\index.ts:17772 🧠 [Slow]

```typescript
// Strip internal metadata before sending to API — Anthropic rejects extra fields
```

### src\agents\index.ts:17773 🧠 [Slow]

```typescript
const toApiTools = (defs: ToolDefinition[]): Anthropic.Tool[] =>
```

### src\agents\index.ts:17774 🧠 [Slow]

```typescript
defs.map(({ metadata: _, ...rest }) => rest) as Anthropic.Tool[];
```

### src\agents\index.ts:17777 🧠 [Slow]

```typescript
// Send only tool_search so Claude can discover tools if the conversation turns trading.
```

### src\agents\index.ts:17790 🧠 [Slow]

```typescript
let response: Anthropic.Message;
```

### src\agents\index.ts:17844 ⚡ [Fast]

```typescript
while (response.stop_reason === 'tool_use' && toolTurnCount < MAX_TOOL_TURNS) {
```

### src\agents\index.ts:17849 🧠 [Slow]

```typescript
const toolResults: Anthropic.ToolResultBlockParam[] = [];
```

### src\agents\index.ts:17852 ⚡ [Fast]

```typescript
if (block.type === 'tool_use') {
```

### src\agents\index.ts:17877 ⚡ [Fast]

```typescript
type: 'tool_result',
```

### src\agents\index.ts:17878 ⚡ [Fast]

```typescript
tool_use_id: block.id,
```

### src\agents\index.ts:17992 ⚡ [Fast]

```typescript
const MAX_TOOL_RESULT_CHARS = 16384;
```

### src\agents\index.ts:17994 ⚡ [Fast]

```typescript
if (typeof truncatedResult === 'string' && truncatedResult.length > MAX_TOOL_RESULT_CHARS) {
```

### src\agents\index.ts:17995 ⚡ [Fast]

```typescript
truncatedResult = truncatedResult.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[truncated, result too large]';
```

### src\agents\index.ts:17996 ⚡ [Fast]

```typescript
logger.info({ tool: block.name, originalLen: result.length, truncatedTo: MAX_TOOL_RESULT_CHARS }, 'Truncated large tool result');
```

### src\agents\index.ts:18000 ⚡ [Fast]

```typescript
type: 'tool_result',
```

### src\agents\index.ts:18001 ⚡ [Fast]

```typescript
tool_use_id: block.id,
```

### src\agents\index.ts:18149 🧠 [Slow]

```typescript
const extraction = await extractMemoryWithClaude(client, extractInput, maxItems);
```

### src\agents\subagents.ts:20 🧠 [Slow]

```typescript
import Anthropic from '@anthropic-ai/sdk';
```

### src\agents\subagents.ts:37 🧠 [Slow]

```typescript
| 'extended'       // Extended thinking (Claude 3.5+)
```

### src\agents\subagents.ts:153 🧠 [Slow]

```typescript
'claude-3-opus-20240229': { input: 15, output: 75 },
```

### src\agents\subagents.ts:154 🧠 [Slow]

```typescript
'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
```

### src\agents\subagents.ts:155 🧠 [Slow]

```typescript
'claude-3-5-haiku-20241022': { input: 0.25, output: 1.25 },
```

### src\agents\subagents.ts:156 🧠 [Slow]

```typescript
'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
```

### src\agents\subagents.ts:467 🧠 [Slow]

```typescript
/** Set Anthropic client */
```

### src\agents\subagents.ts:468 🧠 [Slow]

```typescript
setClient(client: Anthropic): void;
```

### src\agents\subagents.ts:477 🧠 [Slow]

```typescript
let anthropicClient: Anthropic | null = null;
```

### src\agents\subagents.ts:540 🧠 [Slow]

```typescript
if (!anthropicClient) {
```

### src\agents\subagents.ts:541 🧠 [Slow]

```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
```

### src\agents\subagents.ts:545 🧠 [Slow]

```typescript
message: 'ANTHROPIC_API_KEY not set',
```

### src\agents\subagents.ts:550 🧠 [Slow]

```typescript
run.events.emit('error', new Error('ANTHROPIC_API_KEY not set'));
```

### src\agents\subagents.ts:553 🧠 [Slow]

```typescript
anthropicClient = new Anthropic({ apiKey });
```

### src\agents\subagents.ts:556 🧠 [Slow]

```typescript
const model = state.config.model || 'claude-3-5-sonnet-20241022';
```

### src\agents\subagents.ts:581 🧠 [Slow]

```typescript
const messages: Anthropic.MessageParam[] = state.messages.map(m => ({
```

### src\agents\subagents.ts:612 🧠 [Slow]

```typescript
const response = await anthropicClient.messages.create(
```

### src\agents\subagents.ts:628 ⚡ [Fast]

```typescript
const hasToolUse = response.content.some(block => block.type === 'tool_use');
```

### src\agents\subagents.ts:635 🧠 [Slow]

```typescript
const toolResults: Anthropic.ToolResultBlockParam[] = [];
```

### src\agents\subagents.ts:638 ⚡ [Fast]

```typescript
if (block.type === 'tool_use') {
```

### src\agents\subagents.ts:653 ⚡ [Fast]

```typescript
type: 'tool_result',
```

### src\agents\subagents.ts:654 ⚡ [Fast]

```typescript
tool_use_id: block.id,
```

### src\agents\subagents.ts:661 ⚡ [Fast]

```typescript
type: 'tool_result',
```

### src\agents\subagents.ts:662 ⚡ [Fast]

```typescript
tool_use_id: block.id,
```

### src\agents\subagents.ts:677 🧠 [Slow]

```typescript
.map(b => (b as Anthropic.TextBlock).text)
```

### src\agents\subagents.ts:956 🧠 [Slow]

```typescript
anthropicClient = client;
```

### src\auth\oauth.ts:3 🧠 [Slow]

```typescript
* Handles OAuth 2.0 flows for Anthropic, OpenAI, and other providers
```

### src\auth\oauth.ts:18 🧠 [Slow]

```typescript
provider: 'anthropic' | 'openai' | 'google' | 'github' | 'azure';
```

### src\auth\oauth.ts:43 🧠 [Slow]

```typescript
anthropic: {
```

### src\auth\oauth.ts:44 🧠 [Slow]

```typescript
authorizationEndpoint: 'https://console.anthropic.com/oauth/authorize',
```

### src\auth\oauth.ts:45 🧠 [Slow]

```typescript
tokenEndpoint: 'https://api.anthropic.com/oauth/token',
```

### src\auth\oauth.ts:46 🧠 [Slow]

```typescript
deviceCodeEndpoint: 'https://api.anthropic.com/oauth/device/code',
```

### src\auth\oauth.ts:47 🧠 [Slow]

```typescript
revokeEndpoint: 'https://api.anthropic.com/oauth/revoke',
```

### src\auth\oauth.ts:578 🧠 [Slow]

```typescript
export function createAnthropicOAuth(clientId: string, clientSecret?: string): OAuthClient {
```

### src\auth\oauth.ts:580 🧠 [Slow]

```typescript
provider: 'anthropic',
```

### src\channels\telegram\index.ts:128 🧠 [Slow]

```typescript
`Claude + Odds — your AI assistant for prediction markets.\n\n` +
```

### src\cli\commands\doctor.ts:84 🧠 [Slow]

```typescript
const anthropicKey = process.env.ANTHROPIC_API_KEY;
```

### src\cli\commands\doctor.ts:85 🧠 [Slow]

```typescript
if (anthropicKey) {
```

### src\cli\commands\doctor.ts:86 🧠 [Slow]

```typescript
const masked = anthropicKey.slice(0, 10) + '...' + anthropicKey.slice(-4);
```

### src\cli\commands\doctor.ts:88 🧠 [Slow]

```typescript
name: 'Anthropic API key',
```

### src\cli\commands\doctor.ts:94 🧠 [Slow]

```typescript
name: 'Anthropic API key',
```

### src\cli\commands\doctor.ts:97 🧠 [Slow]

```typescript
fix: 'Set ANTHROPIC_API_KEY environment variable',
```

### src\cli\commands\doctor.ts:457 🧠 [Slow]

```typescript
if (anthropicKey) {
```

### src\cli\commands\doctor.ts:458 🧠 [Slow]

```typescript
if (anthropicKey.startsWith('sk-ant-')) {
```

### src\cli\commands\doctor.ts:460 🧠 [Slow]

```typescript
name: 'Anthropic API key format',
```

### src\cli\commands\doctor.ts:466 🧠 [Slow]

```typescript
name: 'Anthropic API key format',
```

### src\cli\commands\doctor.ts:469 🧠 [Slow]

```typescript
fix: 'Verify your API key at console.anthropic.com',
```

### src\cli\commands\index.ts:134 🧠 [Slow]

```typescript
// Anthropic (Latest)
```

### src\cli\commands\index.ts:135 🧠 [Slow]

```typescript
{ id: 'claude-opus-4-6', provider: 'anthropic', context: '200K' },
```

### src\cli\commands\index.ts:136 🧠 [Slow]

```typescript
{ id: 'claude-sonnet-4-5-20250929', provider: 'anthropic', context: '200K' },
```

### src\cli\commands\index.ts:137 🧠 [Slow]

```typescript
{ id: 'claude-haiku-4-5-20251001', provider: 'anthropic', context: '200K' },
```

### src\cli\commands\index.ts:138 🧠 [Slow]

```typescript
// Anthropic (Legacy)
```

### src\cli\commands\index.ts:139 🧠 [Slow]

```typescript
{ id: 'claude-3-5-sonnet-20241022', provider: 'anthropic', context: '200K' },
```

### src\cli\commands\index.ts:140 🧠 [Slow]

```typescript
{ id: 'claude-3-opus-20240229', provider: 'anthropic', context: '200K' },
```

### src\cli\commands\index.ts:141 🧠 [Slow]

```typescript
{ id: 'claude-3-5-haiku-20241022', provider: 'anthropic', context: '200K' },
```

### src\cli\commands\index.ts:178 🧠 [Slow]

```typescript
console.log(`Default model: ${data.defaultModel || 'claude-3-5-sonnet-20241022'}`);
```

### src\cli\commands\index.ts:2037 🧠 [Slow]

```typescript
model: 'claude-3-5-sonnet-20241022',
```

### src\cli\commands\index.ts:2081 🧠 [Slow]

```typescript
.option('-p, --provider <provider>', 'Provider (anthropic, openai)')
```

### src\cli\commands\index.ts:2083 🧠 [Slow]

```typescript
const provider = options.provider || 'anthropic';
```

### src\cli\commands\index.ts:2176 🧠 [Slow]

```typescript
// Test Anthropic
```

### src\cli\commands\index.ts:2177 🧠 [Slow]

```typescript
const anthropicKey = process.env.ANTHROPIC_API_KEY;
```

### src\cli\commands\index.ts:2178 🧠 [Slow]

```typescript
if (!platform || platform === 'anthropic') {
```

### src\cli\commands\index.ts:2179 🧠 [Slow]

```typescript
if (!anthropicKey) {
```

### src\cli\commands\index.ts:2181 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:2183 🧠 [Slow]

```typescript
message: 'ANTHROPIC_API_KEY not set',
```

### src\cli\commands\index.ts:2184 🧠 [Slow]

```typescript
fix: 'Get key from: https://console.anthropic.com',
```

### src\cli\commands\index.ts:2186 🧠 [Slow]

```typescript
} else if (!anthropicKey.startsWith('sk-ant-')) {
```

### src\cli\commands\index.ts:2188 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:2191 🧠 [Slow]

```typescript
fix: 'Verify key at: https://console.anthropic.com',
```

### src\cli\commands\index.ts:2196 🧠 [Slow]

```typescript
const response = await fetch('https://api.anthropic.com/v1/messages', {
```

### src\cli\commands\index.ts:2200 🧠 [Slow]

```typescript
'x-api-key': anthropicKey,
```

### src\cli\commands\index.ts:2201 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\cli\commands\index.ts:2204 🧠 [Slow]

```typescript
model: 'claude-3-haiku-20240307',
```

### src\cli\commands\index.ts:2212 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:2218 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:2221 🧠 [Slow]

```typescript
fix: 'Check key at: https://console.anthropic.com',
```

### src\cli\commands\index.ts:2225 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:2231 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:2238 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\cli\commands\index.ts:3429 🧠 [Slow]

```typescript
const anthropicKey = process.env.ANTHROPIC_API_KEY;
```

### src\cli\commands\index.ts:3430 🧠 [Slow]

```typescript
if (!anthropicKey) {
```

### src\cli\commands\index.ts:3431 🧠 [Slow]

```typescript
results.push({ name: 'Anthropic', status: 'fail', message: 'ANTHROPIC_API_KEY not set', fix: 'https://console.anthropic.com' });
```

### src\cli\commands\index.ts:3434 🧠 [Slow]

```typescript
const r = await fetch('https://api.anthropic.com/v1/messages', {
```

### src\cli\commands\index.ts:3436 🧠 [Slow]

```typescript
headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
```

### src\cli\commands\index.ts:3437 🧠 [Slow]

```typescript
body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
```

### src\cli\commands\index.ts:3440 🧠 [Slow]

```typescript
results.push({ name: 'Anthropic', status: 'pass', message: r.ok ? 'Key valid' : 'Key valid (rate limited)' });
```

### src\cli\commands\index.ts:3442 🧠 [Slow]

```typescript
results.push({ name: 'Anthropic', status: 'fail', message: `HTTP ${r.status}`, fix: 'Check key at console.anthropic.com' });
```

### src\cli\commands\index.ts:3445 🧠 [Slow]

```typescript
results.push({ name: 'Anthropic', status: 'warn', message: `Network error: ${(e as Error).message}` });
```

### src\cli\commands\index.ts:3691 🧠 [Slow]

```typescript
.option('--api-key <key>', 'Anthropic API key (skip prompt)')
```

### src\cli\commands\index.ts:3764 🧠 [Slow]

```typescript
console.log(`  ${bgCyan(' 1 ')} ${bold('Anthropic API Key')}`);
```

### src\cli\commands\index.ts:3765 🧠 [Slow]

```typescript
console.log(`  ${dim('Powers the Claude AI brain. Get one free at:')}`);
```

### src\cli\commands\index.ts:3766 🧠 [Slow]

```typescript
console.log(`  ${cyan('https://console.anthropic.com')}`);
```

### src\cli\commands\index.ts:3769 🧠 [Slow]

```typescript
let apiKey = options.apiKey || envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
```

### src\cli\commands\index.ts:3777 🧠 [Slow]

```typescript
console.log(`  ${dim('echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.clodds/.env')}`);
```

### src\cli\commands\index.ts:3791 🧠 [Slow]

```typescript
envVars.ANTHROPIC_API_KEY = apiKey;
```

### src\cli\commands\index.ts:3796 🧠 [Slow]

```typescript
const r = await fetch('https://api.anthropic.com/v1/messages', {
```

### src\cli\commands\index.ts:3801 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\cli\commands\onboard.ts:31 🧠 [Slow]

```typescript
async function validateAnthropicKey(key: string): Promise<{ valid: boolean; error?: string }> {
```

### src\cli\commands\onboard.ts:33 🧠 [Slow]

```typescript
const response = await fetch('https://api.anthropic.com/v1/messages', {
```

### src\cli\commands\onboard.ts:38 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\cli\commands\onboard.ts:41 🧠 [Slow]

```typescript
model: 'claude-3-haiku-20240307',
```

### src\cli\commands\onboard.ts:116 🧠 [Slow]

```typescript
console.log('  1. Set up your Claude API key (required)');
```

### src\cli\commands\onboard.ts:126 🧠 [Slow]

```typescript
model: { primary: 'anthropic/claude-opus-4-6' },
```

### src\cli\commands\onboard.ts:138 🧠 [Slow]

```typescript
// Step 1: Anthropic API Key (Required)
```

### src\cli\commands\onboard.ts:140 🧠 [Slow]

```typescript
console.log('\x1b[1m1️⃣  Claude API (Required)\x1b[0m\n');
```

### src\cli\commands\onboard.ts:141 🧠 [Slow]

```typescript
console.log('\x1b[90m   Get your API key from: https://console.anthropic.com\x1b[0m\n');
```

### src\cli\commands\onboard.ts:143 🧠 [Slow]

```typescript
let anthropicKey = '';
```

### src\cli\commands\onboard.ts:144 🧠 [Slow]

```typescript
while (!anthropicKey) {
```

### src\cli\commands\onboard.ts:145 🧠 [Slow]

```typescript
anthropicKey = await question('   Enter your Anthropic API key: ');
```

### src\cli\commands\onboard.ts:146 🧠 [Slow]

```typescript
if (!anthropicKey) {
```

### src\cli\commands\onboard.ts:153 🧠 [Slow]

```typescript
const result = await validateAnthropicKey(anthropicKey);
```

### src\cli\commands\onboard.ts:158 🧠 [Slow]

```typescript
anthropicKey = '';
```

### src\cli\commands\onboard.ts:294 🧠 [Slow]

```typescript
`ANTHROPIC_API_KEY=${anthropicKey}`,
```

### src\cli\commands\onboard.ts:326 🧠 [Slow]

```typescript
console.log(`   \x1b[32m✓\x1b[0m Claude AI (Anthropic)`);
```

### src\cli\index.ts:52 🧠 [Slow]

```typescript
.description('Claude + Odds: AI assistant for prediction markets')
```

### src\commands\index.ts:87 🧠 [Slow]

```typescript
'opus': 'claude-opus-4-6',
```

### src\commands\index.ts:88 🧠 [Slow]

```typescript
'opus4.6': 'claude-opus-4-6',
```

### src\commands\index.ts:89 🧠 [Slow]

```typescript
'opus4.5': 'claude-opus-4-5-20250514',
```

### src\commands\index.ts:90 🧠 [Slow]

```typescript
'sonnet': 'claude-sonnet-4-5-20250929',
```

### src\commands\index.ts:91 🧠 [Slow]

```typescript
'sonnet4.5': 'claude-sonnet-4-5-20250929',
```

### src\commands\index.ts:92 🧠 [Slow]

```typescript
'haiku': 'claude-haiku-4-5-20251001',
```

### src\commands\index.ts:93 🧠 [Slow]

```typescript
'haiku4.5': 'claude-haiku-4-5-20251001',
```

### src\commands\index.ts:94 🧠 [Slow]

```typescript
'claude-opus-4': 'claude-opus-4-6',
```

### src\commands\index.ts:95 🧠 [Slow]

```typescript
'claude-sonnet-4': 'claude-sonnet-4-5-20250929',
```

### src\commands\index.ts:96 🧠 [Slow]

```typescript
'claude-haiku-4': 'claude-haiku-4-5-20251001',
```

### src\commands\index.ts:230 🧠 [Slow]

```typescript
const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
```

### src\commands\index.ts:256 🧠 [Slow]

```typescript
// Validate it looks like a Claude model
```

### src\commands\index.ts:257 🧠 [Slow]

```typescript
if (!resolvedModel.startsWith('claude-')) {
```

### src\commands\registry.ts:1025 🧠 [Slow]

```typescript
usage: '/model [sonnet|opus|haiku|claude-...]',
```

### src\commands\registry.ts:1027 🧠 [Slow]

```typescript
const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
```

### src\commands\registry.ts:1037 🧠 [Slow]

```typescript
opus: 'claude-opus-4-6',
```

### src\commands\registry.ts:1038 🧠 [Slow]

```typescript
'opus4.6': 'claude-opus-4-6',
```

### src\commands\registry.ts:1039 🧠 [Slow]

```typescript
'opus4.5': 'claude-opus-4-5-20250514',
```

### src\commands\registry.ts:1040 🧠 [Slow]

```typescript
sonnet: 'claude-sonnet-4-5-20250929',
```

### src\commands\registry.ts:1041 🧠 [Slow]

```typescript
'sonnet4.5': 'claude-sonnet-4-5-20250929',
```

### src\commands\registry.ts:1042 🧠 [Slow]

```typescript
haiku: 'claude-haiku-4-5-20251001',
```

### src\commands\registry.ts:1043 🧠 [Slow]

```typescript
'haiku4.5': 'claude-haiku-4-5-20251001',
```

### src\commands\registry.ts:1047 🧠 [Slow]

```typescript
if (!resolved.startsWith('claude-')) {
```

### src\config\index.ts:504 🧠 [Slow]

```typescript
model: 'claude-opus-4-6',
```

### src\config\index.ts:654 🧠 [Slow]

```typescript
ANTHROPIC_API_KEY: () => {}, // Used directly by agent
```

### src\doctor\index.ts:226 🧠 [Slow]

```typescript
const response = await fetch('https://api.anthropic.com', {
```

### src\doctor\index.ts:250 🧠 [Slow]

```typescript
async anthropicApi(): Promise<CheckResult> {
```

### src\doctor\index.ts:251 🧠 [Slow]

```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
```

### src\doctor\index.ts:255 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\doctor\index.ts:257 🧠 [Slow]

```typescript
message: 'ANTHROPIC_API_KEY not set',
```

### src\doctor\index.ts:258 🧠 [Slow]

```typescript
details: 'Set the environment variable to use Claude',
```

### src\doctor\index.ts:263 🧠 [Slow]

```typescript
const response = await fetch('https://api.anthropic.com/v1/messages', {
```

### src\doctor\index.ts:268 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\doctor\index.ts:271 🧠 [Slow]

```typescript
model: 'claude-3-haiku-20240307',
```

### src\doctor\index.ts:280 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\doctor\index.ts:288 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\doctor\index.ts:295 🧠 [Slow]

```typescript
name: 'Anthropic API',
```

### src\doctor\index.ts:297 🧠 [Slow]

```typescript
message: 'Could not connect to Anthropic API',
```

### src\extensions\open-prose\index.ts:301 🧠 [Slow]

```typescript
model: 'claude-3-5-sonnet-20241022',
```

### src\extensions\open-prose\index.ts:356 🧠 [Slow]

```typescript
model: 'claude-3-5-sonnet-20241022',
```

### src\extensions\open-prose\index.ts:382 🧠 [Slow]

```typescript
model: 'claude-3-5-sonnet-20241022',
```

### src\extensions\open-prose\index.ts:407 🧠 [Slow]

```typescript
model: 'claude-3-5-sonnet-20241022',
```

### src\extensions\open-prose\index.ts:451 🧠 [Slow]

```typescript
model: 'claude-3-5-sonnet-20241022',
```

### src\extensions\task-runner\index.ts:272 🧠 [Slow]

```typescript
const model = (task.input?.model as string) || 'claude-3-5-sonnet-20241022';
```

### src\extensions\task-runner\index.ts:444 🧠 [Slow]

```typescript
const planningModel = this.config.planningModel || 'claude-3-5-sonnet-20241022';
```

### src\gateway\index.ts:463 🧠 [Slow]

```typescript
anthropicKey: process.env.ANTHROPIC_API_KEY,
```

### src\gateway\server.ts:503 🧠 [Slow]

```typescript
{ key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', secret: true, required: true, helpUrl: 'https://console.anthropic.com' },
```

### src\hooks\index.ts:161 ⚡ [Fast]

```typescript
/** Result from tool_result_persist hook */
```

### src\hooks\index.ts:181 ⚡ [Fast]

```typescript
/** Whether this hook is sync-only (like tool_result_persist) */
```

### src\hooks\index.ts:305 ⚡ [Fast]

```typescript
/** Trigger sync hooks only (for hot paths like tool_result_persist) */
```

### src\index.ts:3 🧠 [Slow]

```typescript
* Claude + Odds
```

### src\index.ts:117 🧠 [Slow]

```typescript
// Check for Anthropic API key (required for AI functionality)
```

### src\index.ts:118 🧠 [Slow]

```typescript
if (!process.env.ANTHROPIC_API_KEY) {
```

### src\index.ts:120 🧠 [Slow]

```typescript
'ANTHROPIC_API_KEY is not set. The AI agent will not function.\n' +
```

### src\index.ts:121 🧠 [Slow]

```typescript
'  Fix: Add ANTHROPIC_API_KEY=sk-ant-... to your .env file\n' +
```

### src\infra\retry.ts:431 🧠 [Slow]

```typescript
/** Anthropic API policy */
```

### src\infra\retry.ts:432 🧠 [Slow]

```typescript
anthropic: {
```

### src\infra\retry.ts:433 🧠 [Slow]

```typescript
name: 'anthropic',
```

### src\infra\retry.ts:442 🧠 [Slow]

```typescript
// Anthropic-specific
```

### src\mcp\index.ts:1211 ⚡ [Fast]

```typescript
* Import skills from a Claude Code skills directory
```

### src\mcp\index.ts:1295 🧠 [Slow]

```typescript
join(homedir(), '.claude', 'mcp.json'),
```

### src\mcp\installer.ts:2 🧠 [Slow]

```typescript
* MCP Installer - Auto-configure Claude Desktop and Claude Code to use Clodds MCP
```

### src\mcp\installer.ts:13 🧠 [Slow]

```typescript
function getClaudeDesktopConfigPath(): string {
```

### src\mcp\installer.ts:16 🧠 [Slow]

```typescript
return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
```

### src\mcp\installer.ts:19 🧠 [Slow]

```typescript
return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
```

### src\mcp\installer.ts:22 🧠 [Slow]

```typescript
return join(homedir(), '.config', 'claude', 'claude_desktop_config.json');
```

### src\mcp\installer.ts:25 🧠 [Slow]

```typescript
function getClaudeCodeConfigPath(): string {
```

### src\mcp\installer.ts:26 🧠 [Slow]

```typescript
return join(homedir(), '.claude.json');
```

### src\mcp\installer.ts:74 🧠 [Slow]

```typescript
// Claude Desktop
```

### src\mcp\installer.ts:75 🧠 [Slow]

```typescript
const desktopPath = getClaudeDesktopConfigPath();
```

### src\mcp\installer.ts:81 🧠 [Slow]

```typescript
installed.push(`Claude Desktop: ${desktopPath}`);
```

### src\mcp\installer.ts:83 🧠 [Slow]

```typescript
skipped.push(`Claude Desktop: ${err.message}`);
```

### src\mcp\installer.ts:86 🧠 [Slow]

```typescript
// Claude Code
```

### src\mcp\installer.ts:87 🧠 [Slow]

```typescript
const codePath = getClaudeCodeConfigPath();
```

### src\mcp\installer.ts:93 🧠 [Slow]

```typescript
installed.push(`Claude Code: ${codePath}`);
```

### src\mcp\installer.ts:95 🧠 [Slow]

```typescript
skipped.push(`Claude Code: ${err.message}`);
```

### src\mcp\installer.ts:110 🧠 [Slow]

```typescript
['Claude Desktop', getClaudeDesktopConfigPath],
```

### src\mcp\installer.ts:111 🧠 [Slow]

```typescript
['Claude Code', getClaudeCodeConfigPath],
```

### src\media\index.ts:770 🧠 [Slow]

```typescript
// VISION / IMAGE UNDERSTANDING (Claude Vision API)
```

### src\media\index.ts:793 🧠 [Slow]

```typescript
/** Create vision service using Claude API */
```

### src\media\index.ts:795 🧠 [Slow]

```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
```

### src\media\index.ts:797 🧠 [Slow]

```typescript
async function callClaudeVision(imageBase64: string, mimeType: string, prompt: string): Promise<string> {
```

### src\media\index.ts:799 🧠 [Slow]

```typescript
throw new Error('Vision not configured. Set ANTHROPIC_API_KEY.');
```

### src\media\index.ts:802 🧠 [Slow]

```typescript
const response = await fetch('https://api.anthropic.com/v1/messages', {
```

### src\media\index.ts:807 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\media\index.ts:810 🧠 [Slow]

```typescript
model: 'claude-sonnet-4-20250514',
```

### src\media\index.ts:869 🧠 [Slow]

```typescript
const response = await callClaudeVision(base64, mimeType, analysisPrompt);
```

### src\media\index.ts:889 🧠 [Slow]

```typescript
const response = await callClaudeVision(
```

### src\media\index.ts:901 🧠 [Slow]

```typescript
const response = await callClaudeVision(
```

### src\memory\context.ts:6 🧠 [Slow]

```typescript
* - CLAUDE.md and project context loading
```

### src\memory\context.ts:25 🧠 [Slow]

```typescript
/** Maximum tokens for context window (default: 128000 for Claude) */
```

### src\memory\context.ts:35 🧠 [Slow]

```typescript
/** Project root for CLAUDE.md discovery */
```

### src\memory\context.ts:37 🧠 [Slow]

```typescript
/** Custom CLAUDE.md paths to check */
```

### src\memory\context.ts:38 🧠 [Slow]

```typescript
claudeMdPaths?: string[];
```

### src\memory\context.ts:95 🧠 [Slow]

```typescript
claudeMd?: string;
```

### src\memory\context.ts:96 🧠 [Slow]

```typescript
claudeMdPath?: string;
```

### src\memory\context.ts:172 🧠 [Slow]

```typescript
// CLAUDE.MD DISCOVERY
```

### src\memory\context.ts:176 🧠 [Slow]

```typescript
* Discover and load CLAUDE.md files
```

### src\memory\context.ts:178 🧠 [Slow]

```typescript
* - ~/.claude/CLAUDE.md (global)
```

### src\memory\context.ts:179 🧠 [Slow]

```typescript
* - Project root CLAUDE.md
```

### src\memory\context.ts:180 🧠 [Slow]

```typescript
* - .claude/CLAUDE.md in project
```

### src\memory\context.ts:183 🧠 [Slow]

```typescript
export function discoverClaudeMd(projectRoot?: string, customPaths?: string[]): ProjectContext {
```

### src\memory\context.ts:187 🧠 [Slow]

```typescript
// Global CLAUDE.md
```

### src\memory\context.ts:188 🧠 [Slow]

```typescript
const globalClaudeMd = join(homedir(), '.claude', 'CLAUDE.md');
```

### src\memory\context.ts:189 🧠 [Slow]

```typescript
searchPaths.push(globalClaudeMd);
```

### src\memory\context.ts:191 🧠 [Slow]

```typescript
// Project-level CLAUDE.md
```

### src\memory\context.ts:194 🧠 [Slow]

```typescript
join(projectRoot, 'CLAUDE.md'),
```

### src\memory\context.ts:195 🧠 [Slow]

```typescript
join(projectRoot, '.claude', 'CLAUDE.md'),
```

### src\memory\context.ts:196 🧠 [Slow]

```typescript
join(projectRoot, 'docs', 'CLAUDE.md')
```

### src\memory\context.ts:205 🧠 [Slow]

```typescript
// Find first existing CLAUDE.md
```

### src\memory\context.ts:209 🧠 [Slow]

```typescript
context.claudeMd = readFileSync(searchPath, 'utf-8');
```

### src\memory\context.ts:210 🧠 [Slow]

```typescript
context.claudeMdPath = searchPath;
```

### src\memory\context.ts:211 🧠 [Slow]

```typescript
logger.debug({ path: searchPath }, 'Loaded CLAUDE.md');
```

### src\memory\context.ts:214 🧠 [Slow]

```typescript
logger.warn({ path: searchPath, error: err }, 'Failed to read CLAUDE.md');
```

### src\memory\context.ts:287 🧠 [Slow]

```typescript
/** Load project context (CLAUDE.md, etc.) */
```

### src\memory\context.ts:600 🧠 [Slow]

```typescript
// Project context (CLAUDE.md)
```

### src\memory\context.ts:601 🧠 [Slow]

```typescript
if (promptConfig.includeProjectContext && projectContext?.claudeMd) {
```

### src\memory\context.ts:602 🧠 [Slow]

```typescript
parts.push('\n# Project Instructions (from CLAUDE.md)');
```

### src\memory\context.ts:603 🧠 [Slow]

```typescript
parts.push(projectContext.claudeMd);
```

### src\memory\context.ts:646 🧠 [Slow]

```typescript
projectContext = discoverClaudeMd(projectRoot, config.claudeMdPaths);
```

### src\memory\context.ts:647 🧠 [Slow]

```typescript
state.projectContext = projectContext.claudeMd;
```

### src\memory\context.ts:811 🧠 [Slow]

```typescript
discoverClaudeMd,
```

### src\memory\summarizer.ts:2 🧠 [Slow]

```typescript
* Claude-powered summarization for context compaction
```

### src\memory\summarizer.ts:5 🧠 [Slow]

```typescript
import Anthropic from '@anthropic-ai/sdk';
```

### src\memory\summarizer.ts:10 🧠 [Slow]

```typescript
interface ClaudeSummarizerOptions {
```

### src\memory\summarizer.ts:15 🧠 [Slow]

```typescript
const DEFAULT_SUMMARY_MODEL = process.env.CLODDS_SUMMARY_MODEL || 'claude-3-5-haiku-20241022';
```

### src\memory\summarizer.ts:17 🧠 [Slow]

```typescript
export function createClaudeSummarizer(options: ClaudeSummarizerOptions = {}): SummarizerFn | undefined {
```

### src\memory\summarizer.ts:18 🧠 [Slow]

```typescript
const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
```

### src\memory\summarizer.ts:21 🧠 [Slow]

```typescript
const client = new Anthropic({ apiKey });
```

### src\memory\summarizer.ts:47 🧠 [Slow]

```typescript
.map((b) => (b as Anthropic.TextBlock).text)
```

### src\memory\summarizer.ts:53 🧠 [Slow]

```typescript
logger.warn({ error }, 'Claude summarizer failed, falling back to naive summary');
```

### src\memory\tokenizer.ts:2 🧠 [Slow]

```typescript
* Tokenizer utilities (Anthropic + OpenAI)
```

### src\memory\tokenizer.ts:5 🧠 [Slow]

```typescript
import { countTokens as countClaudeTokens } from '@anthropic-ai/tokenizer';
```

### src\memory\tokenizer.ts:10 🧠 [Slow]

```typescript
return model.replace(/^anthropic\//, '').trim().toLowerCase();
```

### src\memory\tokenizer.ts:13 🧠 [Slow]

```typescript
function isAnthropicModel(model?: string): boolean {
```

### src\memory\tokenizer.ts:15 🧠 [Slow]

```typescript
return m.startsWith('claude');
```

### src\memory\tokenizer.ts:27 🧠 [Slow]

```typescript
process.env.ANTHROPIC_MODEL ||
```

### src\memory\tokenizer.ts:38 🧠 [Slow]

```typescript
// Prefer Anthropic tokenizer for Claude-family models.
```

### src\memory\tokenizer.ts:39 🧠 [Slow]

```typescript
if (isAnthropicModel(resolvedModel)) {
```

### src\memory\tokenizer.ts:40 🧠 [Slow]

```typescript
return countClaudeTokens(text);
```

### src\models\adaptive.ts:19 🧠 [Slow]

```typescript
// Heuristic metadata for known Anthropic models.
```

### src\models\adaptive.ts:23 🧠 [Slow]

```typescript
'claude-opus-4-6': { costScore: 1, speedScore: 3, qualityScore: 10 },
```

### src\models\adaptive.ts:24 🧠 [Slow]

```typescript
'claude-opus-4-5-20250514': { costScore: 2, speedScore: 4, qualityScore: 10 },
```

### src\models\adaptive.ts:25 🧠 [Slow]

```typescript
'claude-sonnet-4-5-20250929': { costScore: 5, speedScore: 7, qualityScore: 9 },
```

### src\models\adaptive.ts:26 🧠 [Slow]

```typescript
'claude-sonnet-4-20250514': { costScore: 6, speedScore: 7, qualityScore: 8 },
```

### src\models\adaptive.ts:27 🧠 [Slow]

```typescript
'claude-haiku-4-5-20251001': { costScore: 9, speedScore: 10, qualityScore: 7 },
```

### src\models\adaptive.ts:28 🧠 [Slow]

```typescript
'claude-haiku-3-5-20250514': { costScore: 10, speedScore: 10, qualityScore: 6 },
```

### src\models\adaptive.ts:30 🧠 [Slow]

```typescript
'claude-3-5-haiku-20241022': { costScore: 10, speedScore: 10, qualityScore: 6 },
```

### src\models\adaptive.ts:31 🧠 [Slow]

```typescript
'claude-3-5-sonnet-20241022': { costScore: 6, speedScore: 7, qualityScore: 8 },
```

### src\models\adaptive.ts:32 🧠 [Slow]

```typescript
'claude-3-opus-20240229': { costScore: 2, speedScore: 4, qualityScore: 9 },
```

### src\models\adaptive.ts:58 🧠 [Slow]

```typescript
// Supports anthropic/claude-... style prefixes.
```

### src\models\failover.ts:218 🧠 [Slow]

```typescript
/** Default failover chain for Claude models */
```

### src\models\failover.ts:219 🧠 [Slow]

```typescript
export const DEFAULT_CLAUDE_FAILOVER: FailoverConfig = {
```

### src\models\failover.ts:220 🧠 [Slow]

```typescript
primary: 'claude-opus-4-6',
```

### src\models\failover.ts:222 🧠 [Slow]

```typescript
'claude-opus-4-5-20250514',
```

### src\models\failover.ts:223 🧠 [Slow]

```typescript
'claude-sonnet-4-5-20250929',
```

### src\models\index.ts:7 🧠 [Slow]

```typescript
DEFAULT_CLAUDE_FAILOVER,
```

### src\providers\discovery.ts:118 🧠 [Slow]

```typescript
'claude-3-5-sonnet-20241022': {
```

### src\providers\discovery.ts:119 🧠 [Slow]

```typescript
name: 'Claude 3.5 Sonnet',
```

### src\providers\discovery.ts:126 🧠 [Slow]

```typescript
'claude-3-opus-20240229': {
```

### src\providers\discovery.ts:127 🧠 [Slow]

```typescript
name: 'Claude 3 Opus',
```

### src\providers\discovery.ts:134 🧠 [Slow]

```typescript
'claude-3-5-haiku-20241022': {
```

### src\providers\discovery.ts:135 🧠 [Slow]

```typescript
name: 'Claude 3.5 Haiku',
```

### src\providers\index.ts:5 🧠 [Slow]

```typescript
* - Multiple AI model providers (Anthropic, OpenAI, etc.)
```

### src\providers\index.ts:257 🧠 [Slow]

```typescript
// ANTHROPIC PROVIDER
```

### src\providers\index.ts:260 🧠 [Slow]

```typescript
export class AnthropicProvider implements Provider {
```

### src\providers\index.ts:261 🧠 [Slow]

```typescript
name = 'anthropic';
```

### src\providers\index.ts:267 🧠 [Slow]

```typescript
baseUrl: 'https://api.anthropic.com',
```

### src\providers\index.ts:268 🧠 [Slow]

```typescript
defaultModel: 'claude-3-5-sonnet-20241022',
```

### src\providers\index.ts:275 🧠 [Slow]

```typescript
const policy = config.retryPolicy ? RETRY_POLICIES[config.retryPolicy] : RETRY_POLICIES.anthropic;
```

### src\providers\index.ts:282 🧠 [Slow]

```typescript
provider: 'anthropic',
```

### src\providers\index.ts:287 🧠 [Slow]

```typescript
}, 'Anthropic API retry');
```

### src\providers\index.ts:321 🧠 [Slow]

```typescript
finishReason: response.stop_reason === 'end_turn' ? 'end_turn' :
```

### src\providers\index.ts:322 🧠 [Slow]

```typescript
response.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
```

### src\providers\index.ts:350 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\providers\index.ts:356 🧠 [Slow]

```typescript
throw new Error(`Anthropic API error: ${response.status}`);
```

### src\providers\index.ts:384 🧠 [Slow]

```typescript
if (event.type === 'content_block_delta' && event.delta?.text) {
```

### src\providers\index.ts:397 🧠 [Slow]

```typescript
logger.error({ error: err }, 'Anthropic SSE handle error');
```

### src\providers\index.ts:406 🧠 [Slow]

```typescript
'claude-3-5-sonnet-20241022',
```

### src\providers\index.ts:407 🧠 [Slow]

```typescript
'claude-3-opus-20240229',
```

### src\providers\index.ts:408 🧠 [Slow]

```typescript
'claude-3-sonnet-20240229',
```

### src\providers\index.ts:409 🧠 [Slow]

```typescript
'claude-3-haiku-20240307',
```

### src\providers\index.ts:420 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\providers\index.ts:423 🧠 [Slow]

```typescript
model: 'claude-3-haiku-20240307',
```

### src\providers\index.ts:441 🧠 [Slow]

```typescript
'anthropic-version': '2023-06-01',
```

### src\providers\index.ts:455 🧠 [Slow]

```typescript
`Anthropic rate limited: ${statusCode} - ${errorText}`,
```

### src\providers\index.ts:463 🧠 [Slow]

```typescript
throw new TransientError(`Anthropic server error: ${statusCode} - ${errorText}`, statusCode);
```

### src\providers\index.ts:467 🧠 [Slow]

```typescript
throw new Error(`Anthropic API error: ${statusCode} - ${errorText}`);
```

### src\providers\index.ts:1047 🧠 [Slow]

```typescript
'claude-3-5-sonnet-20241022': { inputCostPer1k: 0.003, outputCostPer1k: 0.015 },
```

### src\providers\index.ts:1048 🧠 [Slow]

```typescript
'claude-3-opus-20240229': { inputCostPer1k: 0.015, outputCostPer1k: 0.075 },
```

### src\providers\index.ts:1049 🧠 [Slow]

```typescript
'claude-3-sonnet-20240229': { inputCostPer1k: 0.003, outputCostPer1k: 0.015 },
```

### src\providers\index.ts:1050 🧠 [Slow]

```typescript
'claude-3-haiku-20240307': { inputCostPer1k: 0.00025, outputCostPer1k: 0.00125 },
```

### src\providers\index.ts:1072 🧠 [Slow]

```typescript
anthropicKey?: string;
```

### src\providers\index.ts:1082 🧠 [Slow]

```typescript
if (options.anthropicKey) {
```

### src\providers\index.ts:1083 🧠 [Slow]

```typescript
manager.register(new AnthropicProvider({ apiKey: options.anthropicKey }));
```

### src\providers\index.ts:1120 🧠 [Slow]

```typescript
if (process.env.ANTHROPIC_API_KEY) {
```

### src\providers\index.ts:1121 🧠 [Slow]

```typescript
providers.register(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
```

### src\sessions\index.ts:105 🧠 [Slow]

```typescript
/** Get conversation history for Claude API */
```

### src\skills\bundled\doctor\index.ts:15 🧠 [Slow]

```typescript
network: ['internet', 'anthropicApi'],
```

### src\skills\bundled\usage\index.ts:178 🧠 [Slow]

```typescript
const model = parts[1] || 'claude-sonnet-4-20250514';
```

### src\skills\bundled\x-research\index.ts:722 🧠 [Slow]

```typescript
/x search "claude code"
```

### src\strategies\hft-divergence\detector.ts:105 🧠 [Slow]

```typescript
// Matches CLAUDE.md format: BTC_DOWN_s12-14_w15
```

### src\strategies\hft-divergence\index.ts:6 🧠 [Slow]

```typescript
* signals matching CLAUDE.md encoding: BTC_DOWN_s12-14_w15
```

### src\tools\image.ts:5 🧠 [Slow]

```typescript
* - Analyze images using Claude's vision
```

### src\tools\image.ts:11 🧠 [Slow]

```typescript
import Anthropic from '@anthropic-ai/sdk';
```

### src\tools\image.ts:71 🧠 [Slow]

```typescript
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
```

### src\tools\image.ts:226 🧠 [Slow]

```typescript
* Convert image source to Anthropic API format
```

### src\tools\image.ts:230 🧠 [Slow]

```typescript
): Promise<Anthropic.ImageBlockParam> {
```

### src\tools\image.ts:280 🧠 [Slow]

```typescript
const anthropic = new Anthropic({
```

### src\tools\image.ts:281 🧠 [Slow]

```typescript
apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
```

### src\tools\image.ts:303 🧠 [Slow]

```typescript
const response = await anthropic.messages.create({
```

### src\tools\image.ts:352 🧠 [Slow]

```typescript
const content: Anthropic.ContentBlockParam[] = [];
```

### src\tools\image.ts:361 🧠 [Slow]

```typescript
const response = await anthropic.messages.create({
```

### src\tools\web-fetch.ts:39 🧠 [Slow]

```typescript
'docs.anthropic.com': [
```

### src\tools\web-fetch.ts:40 🧠 [Slow]

```typescript
{ pathPrefix: '/', transform: 'append-md', name: 'Anthropic Docs' },
```

### src\tools\web-fetch.ts:60 🧠 [Slow]

```typescript
'anthropic-api':     { url: 'https://docs.anthropic.com/en/api',         llmUrl: 'https://docs.anthropic.com/en/api.md',          description: 'Anthropic Claude API reference' },
```

### src\types.ts:3 🧠 [Slow]

```typescript
* Claude + Odds: AI assistant for prediction markets
```

### src\usage\index.ts:18 🧠 [Slow]

```typescript
'claude-opus-4-5-20250514': { input: 15.0, output: 75.0 },
```

### src\usage\index.ts:19 🧠 [Slow]

```typescript
'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
```

### src\usage\index.ts:20 🧠 [Slow]

```typescript
'claude-haiku-3-5-20250514': { input: 0.25, output: 1.25 },
```

### src\utils\config.ts:57 🧠 [Slow]

```typescript
model: { primary: 'anthropic/claude-opus-4-6' },
```

### src\wizard\index.ts:56 🧠 [Slow]

```typescript
id: 'anthropic',
```

### src\wizard\index.ts:57 🧠 [Slow]

```typescript
title: 'Anthropic API Key',
```

### src\wizard\index.ts:58 🧠 [Slow]

```typescript
description: 'Configure Claude API access',
```

### src\wizard\index.ts:60 🧠 [Slow]

```typescript
logger.info('Anthropic API Key - Get your API key from: https://console.anthropic.com/');
```

### src\wizard\index.ts:62 🧠 [Slow]

```typescript
const key = await prompt(ctx.rl, 'Enter your Anthropic API key (sk-ant-...): ');
```

### src\wizard\index.ts:64 🧠 [Slow]

```typescript
ctx.config.ANTHROPIC_API_KEY = key;
```

### src\workspace\index.ts:82 🧠 [Slow]

```typescript
'CLAUDE.md',
```

### src\workspace\index.ts:132 🧠 [Slow]

```typescript
// CLAUDE.md (alternative)
```

### src\workspace\index.ts:133 🧠 [Slow]

```typescript
const claudeMdPath = join(path, 'CLAUDE.md');
```

### src\workspace\index.ts:134 🧠 [Slow]

```typescript
if (existsSync(claudeMdPath) && !files.agentsMd) {
```

### src\workspace\index.ts:135 🧠 [Slow]

```typescript
files.agentsMd = readFileSync(claudeMdPath, 'utf-8');
```

