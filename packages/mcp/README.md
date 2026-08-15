# thread-mcp

Thread 会话记忆的 MCP 查询通道——全底座通用（dsh / Claude Code / Codex / 任何 MCP 宿主），零配置接入 `query_session_memory` 工具：事件流水（BM25 语义检索）+ 结构化表（目标/决策/反馈）按需召回，命中带引用可回拉原文。

## 安装（一条命令）

```sh
npm install -g thread-mcp
```

依赖（`@thread/core` + `better-sqlite3`）随包安装，无需额外配置。

## 用法

- **dsh**（`--patch` overlay，零代码）：在 profile 的 `cordis.patch.yml` 插入 `@deepseek-ai/dsh-mcp-client` 条目，stdio 指向 `thread-mcp` 命令即可。
- **Claude Code / Codex**：MCP 配置中注册 `{"command": "thread-mcp"}`。
- **任意 MCP 客户端**：`npx thread-mcp` 启动 stdio server。

## 工具：query_session_memory

| 参数 | 说明 |
|---|---|
| `query` | 语义检索关键词（BM25） |
| `session_id` | 会话 ID，缺省最近活跃会话 |
| `kind` / `since` / `until` / `order` / `count_only` | 结构化精确查询路径（审计/抽查/计数） |
| `token_budget` / `limit` | 返回预算控制 |

数据写入由各底座适配器负责（dsh 插件 / Qoder hooks），本包只读查询，无常驻进程。
