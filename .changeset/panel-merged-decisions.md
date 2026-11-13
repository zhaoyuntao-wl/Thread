---
"@thread-memory/core": patch
---

只读面板的决策链改为按项目合并，与状态卡同口径：

- 新增 `getDecisionsMerged(sessionId, status?, projectKey?)`：全状态按项目合并（同会话 + 同项目 project 级，带隔离过滤），面板的生效/已取代/proposed 三处都改用它；
- 修复新会话面板显示「生效 0 · 已被取代 0」、而同轮状态卡同时列出 11 条项目决策的自相矛盾（2026-11-14 实测：`/thread-panel` 只按 session_id 过滤）；
- 未决计数同步按项目键取（`pendingCount({ sessionId, projectKey })`），与状态卡一致。
