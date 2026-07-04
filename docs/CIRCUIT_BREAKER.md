# Circuit Breaker + Fallback Chain + Health Check

## 熔断器（Circuit Breaker）

原项目已内建 Circuit Breaker（`ProviderManager` 的 `circuits` Map），通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLODDS_PROVIDER_CB_FAILURE_THRESHOLD` | 3 | 连续失败次数触发熔断 |
| `CLODDS_PROVIDER_CB_COOLDOWN_MS` | 60000 | 熔断冷却期（毫秒） |
| `CLODDS_PROVIDER_CB_SUCCESS_RESET` | 2 | 熔断半开后连续成功次数才关闭 |

### 熔断流程

```
请求 → isCircuitOpen? → YES → 跳过该 provider → 走 fallback chain
                     → NO  → 请求上游 → 成功 → reportSuccess() → 关闭熔断
                                         → 失败 → reportFailure() → 失败数 ≥ 3 → 打开熔断 60s
```

## Fallback Chain

`ProviderManager` 内建 fallback chain（`complete()` 方法中的 `chain` 变量）。

**兼容性**: fallback chain 的每个 provider 必须是同一种协议（OpenAI-compatible 或 Anthropic）。
OrangeAI 是 OpenAI-compatible 的，fallback 使用 SiliconFlow 也是 OpenAI-compatible，所以兼容。

## /health 端点增强

`health.ts` 已新增：
- **延迟检测**: 每次检查发 `ping` 请求计时
- **Lane 标签**: 每个 provider 标记 `slow` / `fast`
- **阈值报警**:
  - Fast path > 1.5s → 日志警告
  - Slow path > 10s → 日志警告

## 测试

```bash
# 启动后查看 health 端点
curl http://localhost:18789/health

# 输出示例
{
  "checkedAt": 1741234567890,
  "statuses": [
    {
      "provider": "orangeai-fast",
      "available": true,
      "latencyMs": 842,
      "lane": "fast"
    }
  ]
}
```
