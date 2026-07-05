# CloddsBot 跨语言协议版本控制 (Protocol Versioning)

本规范用于管理 TS (Node.js) 与 Python Compute Layer 的通信格式。

## 1. 版本策略
协议遵循语义化版本（SemVer 2.0.0）。
- **Major**: 发生破坏性修改（字段增删、类型变更、指令集重组）。需同步更新 TS 和 Python 校验层。
- **Minor**: 新增指令、新增响应字段、新增指标。保持向前兼容。
- **Patch**: 优化性能、内部错误处理逻辑、非逻辑性变动。

## 2. 当前版本
`protocol_version: "1.0.0"`

## 3. 演进路线图
| 版本 | 内容 | 影响 |
|------|------|------|
| **1.0.0** | 基础 Ping/Pong, P0 计算流 (HMA/CE/UTBot) | 初始规范 |
| **1.1.0** | 新增 Vol Profile 支持，Price-Volume-Matrix 数据注入 | 增量字段，向前兼容 |
| **2.0.0** | 进程池架构引入，增加 `workerId` 字段 | 破坏性（架构重组） |

## 4. 落地实施规范
1. **强制校验**：TS 侧 `PythonBridgeDaemon` 必须加载 `protocol-schema.json` 进行校验，非法包直接拦截。
2. **优雅降级**：Python 侧收到未知指令返回 `status: UNKNOWN`，TS 侧记录日志并继续工作，不触发崩溃。
3. **版本握手**：Daemon 启动 Ping 阶段，TS/Python 需交换版本，若版本不匹配（Major），Daemon 拒绝启动并返回 `FATAL_VERSION_MISMATCH`。
