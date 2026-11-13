---
"@thread-memory/core": minor
---

可见性原语（P0-0 第一步）：

- 新增 `renderPanel(store, { sessionId, limit })`：纯文本只读面板，五个区块——目标、决策链（生效 / 已被取代，标出 `superseded → #id`）、未决（候选数 + proposed）、交接（未确认，含 `from`/`to` 角色）、最近事件（走 `queryEvents`）；
- 渲染器与底座无关：命令、MCP 工具、演示脚本共用同一份实现；
- 4 项单测覆盖区块齐全、取代关系、交接角色、空会话。
