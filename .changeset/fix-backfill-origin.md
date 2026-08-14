---
"@thread/adapter-qoder-cli": patch
---

A3 历史回填：新增 scripts/backfill-origin.mjs 为存量 origin IS NULL 事件补齐幂等键（规则与 capture.mjs 一致：tool_call 哈希兜底、tool_result 用 tool_use_id、消息/压缩摘要 body+ts 哈希）；已对生产库执行回填 2541 条，NULL 归零、零重复、integrity ok。
