# OrangeAI 双发动机配置说明

## 概述

为 CloddsBot 的 Provider 层引入 **快慢分道（Dual-Speed）** 架构，使用 OrangeAI 作为主力渠道，
为不同场景提供差异化的 AI 推理能力。

## 环境变量

```env
# Slow path: 用于多 Agent 深度辩论/全局判断（可容忍 42s 推理）
ORANGEAI_SLOW_KEY="sk-T6o8KlWMx..."
ORANGEAI_SLOW_BASE_URL="https://api4.orangeai.cc/v1"
ORANGEAI_SLOW_MODEL="glm-5.2"

# Fast path: 用于秒级信号响应（< 2s 超时熔断）
ORANGEAI_FAST_KEY="sk-T6o8KlWMx..."
ORANGEAI_FAST_BASE_URL="https://api4.orangeai.cc/v1"
ORANGEAI_FAST_MODEL="glm-5.2"

# Fallback provider (used when OrangeAI fast path exceeds 1.5s timeout)
SILICONFLOW_API_KEY="sk-..."
```

## Provider 名

| Provider 名 | 适用范围 | 超时时间 | 熔断阈值 |
|-------------|---------|---------|---------|
| `orangeai-slow` | 多 Agent 辩论/Research Manager/Portfolio Manager | 300s | 3 次失败/60s 冷却 |
| `orangeai-fast` | 信号响应/技术分析/快速决策 | 5s | 3 次失败/60s 冷却 |
| `siliconflow` | Fast path fallback | 30s (OpenAI 默认) | 同上 |

## 调用方式

在代码中通过 `ProviderManager` 获取不同路径的 Provider：

```typescript
import { providers } from '../providers';

// 慢路径：深度分析
const result = await providers.slowProvider!.complete([...], { model: 'glm-5.2' });

// 快路径：秒级响应
const result = await providers.fastProvider!.complete([...], { model: 'glm-5.2' });
```

## 熔断机制

- **Fast path**: 1.5s 无 Token 返回 → 日志报警 → 自动切换到 SiliconFlow fallback
- **Slow path**: 10s 无 Token 返回 → 日志报警（不停机，慢路径本身可容忍长延迟）
- 熔断状态持续 60s → 自动半开 → 下一次成功调用后恢复正常

## 延迟检测

`/health` 端点每次检查时，会发送 `ping` 请求并记录延迟：

```json
{
  "checkedAt": 1741234567890,
  "statuses": [
    {
      "provider": "orangeai-fast",
      "available": true,
      "latencyMs": 842,
      "lane": "fast"
    },
    {
      "provider": "orangeai-slow",
      "available": true,
      "latencyMs": 6531,
      "lane": "slow"
    }
  ]
}
```
