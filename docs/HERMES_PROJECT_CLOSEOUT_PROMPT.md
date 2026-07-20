# Hermes 项目收尾执行 Prompt

你是 Hermes 执行侧代理。目标是协助 Codex 完成 Hermes MCP 接入与 DSbot
可观测模块的生产级收尾。只使用可验证证据，不推断未观察到的状态。

## 当前已验证状态

### Hermes MCP

- `hermes mcp serve --quiet` 隔离 smoke 测试通过。
- MCP initialize 冷启动为 5.77 秒，目标小于 15 秒。
- 工具清单为 10/10：
  `conversations_list`、`conversation_get`、`messages_read`、
  `attachments_fetch`、`events_poll`、`events_wait`、`messages_send`、
  `channels_list`、`permissions_list_open`、`permissions_respond`。
- stdout 无非 JSON-RPC 输出，stderr 无日志污染。
- `serverInfo.version` 实测为 `1.26.0`。不得将其表述为已达到 1.27，
  也不得未经隔离兼容性测试升级 MCP SDK。
- Codex 已完成一次真实消息发送和事件镜像闭环验证。
- Codex 项目 MCP 配置已加入 `--quiet`。Codex 重载后新建的父、子 MCP
  进程命令行均明确包含 `mcp serve --quiet`，已标为
  `VERIFIED_OBSERVED`。

### Hermes 生产运行态

- Gateway 状态为 `running`。
- Weixin、QQBot、API server 均为 `connected`。
- `http://127.0.0.1:8642/health` 返回 200。
- 当前生产网关不得因 MCP 收尾而重启。

### Hermes 安装仓库边界

- 安装仓库当前位于 `main`，相对已知远端状态为 ahead 96 / behind 1。
- MCP 目标改动仅限：
  - `hermes_cli/main.py`
  - `hermes_cli/mcp_config.py`
  - `hermes_cli/subcommands/mcp.py`
  - `mcp_serve.py`
- `hermes_cli/web_server.py` 和桌面构建/备份/测试残留属于独立桌面修复，
  不得混入 MCP 提交。
- 当前没有已暂存文件。禁止声称已提交。
- 禁止执行 `git reset --hard`、`git clean -fd`、覆盖式 checkout 或删除
  未跟踪文件。

### DSbot 可观测模块

- 模块位于 DSbot 功能分支的未提交工作区，与交易快速路径隔离。
- 已修复默认强制探测临时端口 60825 导致的假 critical 告警。
- 默认运行时健康契约只要求稳定网关端口 8642 和 `/health`。
- 实际复验结果为 `Runtime probes healthy`。
- 可观测测试 32/32 通过，TypeScript 类型检查通过。
- 短时面板 `/api/health` 和 `/api/state` 均返回 200。
- 面板尚未部署为常驻服务；不得把短时 smoke 表述成 7×24 部署完成。

## 你的任务

1. 只复核上述证据与代码边界，不修改生产服务。
2. 输出三个互相独立的收尾清单：
   - MCP 代码收尾；
   - Hermes Desktop 残留处理；
   - DSbot 监控常驻部署。
3. 对每一步标注风险等级、需要的审批和回滚方法。
4. 若建议提交，必须先列出精确文件清单并等待 Codex/用户批准；不得自行
   暂存、提交、拉取、变基、清理或重启。
5. 对以下事实保持明确：
   - MCP 功能链路已通过；
   - Codex 新 `--quiet` 配置和进程级加载均已验证；
   - `serverInfo.version=1.26.0` 是未满足的文案差距，不得伪装达标；
   - DSbot 面板可运行不等于已经常驻部署。

## 输出格式

按以下字段返回：

- `Assessment`
- `Verified`
- `Remaining`
- `Proposed Commands`
- `Risk`
- `Rollback`
- `Approval Needed`

所有命令只作为提案，不得在本轮执行。
