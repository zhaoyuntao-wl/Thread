---
"dsh-thread": minor
---

发布形态修正：dsh-thread 一个包闭环（采集 + 注入 + 内嵌 MCP server，bin=`dsh-thread`），插件 id 统一 `dsh-thread`，better-sqlite3 随包解决；thread-mcp / t-dsh 不再作为独立发布物（profile 配置是 dsh 通用流程，README 示例即可）；dsh-thread-max（完全接管形态）列为发布后路线图。CI compat 矩阵钉 dsh 0.1.0-rc.6。
