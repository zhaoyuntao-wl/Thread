---
"@thread/core": minor
---

新增 `eventKindCounts(db)`：按 kind 统计 events 表中的事件计数（如 `{ user_message: 3, tool_call: 5 }`），供事件分布统计/审计路径使用。
