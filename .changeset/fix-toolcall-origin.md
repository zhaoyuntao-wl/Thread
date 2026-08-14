---
"@thread/adapter-qoder-cli": patch
---

修复 tool_call 事件 origin 缺失：PreToolUse 解析补传 `tool_use_id`，capture 侧 tool_call 使用独立前缀 `qoder://toolcall#`（与 tool_result 共用 tool_use_id 前缀会触发 append 全局 origin 去重、互相覆盖），无 tool_use_id 时哈希兜底；回归：重复 capture 同一 tool_call 只落库一条。
