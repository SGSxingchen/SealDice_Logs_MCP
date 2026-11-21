# SealDice Logs MCP

只读直连海豹骰（SealDice）跑团日志 SQLite（WAL）数据库的 **MCP 服务 + Web 实时日志阅览与链接分发台**。

专为 TRPG 跑团 AI 辅助扮演打造：AI 可以通过游标增量与时间区间自主按需拉取跑团日志，自动区分场内（IC）、场外（OOC 括号发言）与掷骰检定结果，彻底告别手动复制粘贴与漏消息/重复粘贴烦恼。

## 核心能力

- **零锁库只读直连**：基于 Node.js v22+ 内置 `node:sqlite` 以 `readOnly: true` + `PRAGMA query_only = ON` 直连海豹骰 `data-logs.db`（WAL）与可选 `data.db`，毫秒级读取实时写入的新消息，零干扰海豹骰运行。
- **标准跑团 IC / OOC / 掷骰分类**：
  - 剥离前置 `[CQ:reply,...]` 等标签后再识别中英文圆括号 `(...)` / `（...）` 场外发言；
  - 海豹检定结果（`is_dice=1`）与玩家掷骰指令默认归入场内，并可一键开关隐藏；
  - 自动将 `[CQ:image,...]` / `[CQ:at,...]` / `[CQ:reply,...]` 清洗为紧凑可读文本，显著节省 AI 上下文 Token。
- **防重防漏的 5 个只读 MCP 工具**：
  - `list_logs`：按最近活跃列出授权日志，标注“记录中”状态、群名与规则体系；
  - `get_log_messages`：支持 `after_id` 增量、`before_id` 翻历史、`start_time`/`end_time`/`last_minutes` 时间截取、`filter_mode`（`all`/`ic`/`ooc`）与 `include_dice` 筛选，并返回始终推进的 `next_cursor_id`；
  - `get_recent_updates`：专为“回复期间群里有没有新发言”设计的增量续读工具；
  - `search_log_messages`：检索历史线索与台词，并附带命中前后上下文；
  - `get_log_participants`：统计参团角色列表与场内/场外/掷骰分布。
- **分级授权 MCP 链接分发**：支持签发「全部日志」或「限定指定群 / 指定日志」的独立加密链接（`/sealdice-logs-mcp/:token/mcp`），支持有效期、停用、轮换与删除，变更权限立即断开旧会话。
- **配套 Web 阅览与管理台（`/sealdice-logs/`）**：实时对话时间轴、角色染色、日期分割线、5 秒增量自动追踪、筛选复制与导出 TXT、以及可视化链接与范围管理。

## 快速运行

```bash
npm install
npm run build
npm test
```

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `SEALDICE_LOGS_DB` | 海豹骰 `data-logs.db` 路径 | `data/default/data-logs.db` |
| `SEALDICE_DATA_DB` | 可选，海豹骰 `data.db` 路径（用于读取群名、规则体系与录制状态） | 无 |
| `MCP_STATE_DIR` | 管理台密码、会话与链接状态持久化目录 | `.admin` |
| `PORT` | HTTP 监听端口 | `3004` |
| `MCP_BIND_HOST` | HTTP 监听地址 | `127.0.0.1` |
| `MCP_PUBLIC_ORIGIN` | 对外完整源地址（如 `https://example.com`） | 自动推断 |
| `MCP_ALLOWED_ORIGINS` | MCP 跨域白名单（`*` 或逗号分隔源地址） | 同源 |
| `MCP_ADMIN_PASSWORD` | 自定义管理台管理员口令（未设时自动生成至状态目录） | 自动生成 |
| `MCP_ENABLE_UNAUTH_LOCAL_MCP` | 是否开启无令牌本地调试入口 `/mcp` | `false` |

启动 HTTP（Streamable HTTP + Web 管理台）：

```bash
SEALDICE_LOGS_DB=/path/to/data-logs.db \
SEALDICE_DATA_DB=/path/to/data.db \
MCP_STATE_DIR=/var/lib/sealdice-logs-mcp \
npm run start:http
```
