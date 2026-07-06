# C 盘空间审计 (2026-07-06)

**概况**: 201G 总容量 / 171G 已用 / **30G 剩余 (86%)**

---

## 已确认大文件

| 路径 | 大小 | 说明 |
|------|------|------|
| `AppData/Local/hermes/state.db` | **204M** | Hermes 状态库（sessions + memory） |
| `iCloudPhotos/Photos/` | **1.2G** (4301 文件) | iCloud 同步照片 |
| `Downloads/` | **502M** | 下载目录 |
| `AppData/Local/npm-cache/` | ~300M (estimate) | npm 包缓存 |
| `AppData/Local/Temp/` | ~500M (estimate) | 系统临时文件 |

---

## 深度清理候选

| 优先级 | 目标 | 预估可释放 | 风险 |
|--------|------|-----------|------|
| 🔴 P0 | `state.db` 清理（sessions 归档） | **500M** | 低 — 旧 sessions 可删 |
| 🔴 P0 | `Downloads/` 大安装包清理 | **300M** | 低 — 删已安装的 exe |
| 🟡 P1 | iCloud Photos 优化（移出本地） | **1.2G** | 中 — 需确认 iCloud 设置 |
| 🟡 P1 | npm/pip/uv 包缓存 | **200M** | 低 — `npm cache clean --force` |
| 🟢 P2 | Windows Update 缓存 | **1-2G** | 低 — `cleanmgr /sagerun:1` |

---

## 下一步

确认后我将执行：
1. **清理 Hermes state.db**（归档旧 sessions，保留最近 7 天）
2. **清理 Downloads 中的大安装包**（Obsidian、Tor Browser、Ollama 等已安装的 exe）
3. **清理 npm/pip/uv 缓存**

是否执行？
