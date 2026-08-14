---
"@thread/core": minor
"@thread/adapter-qoder-cli": minor
"@thread/adapter-dsh": minor
---

dsh 狗粮切换（2026-08-14）：路径解析与状态卡构建抽 core 复用（`defaultPaths`/`threadRoot`/`buildStatusCard`，qoder 与 dsh 共用防漂移）；新增 `@thread/adapter-dsh` 旗舰插件——订阅 `session/event` 采集（user/assistant/tool 四类事件写双库，SQLITE_BUSY 重试，自身注入过滤防自循环）+ `agent/pre-step` 每轮注入状态卡（预算 ≤200 行，词法边界）；headless profile 挂载（bundle + MCP overlay 持久化，手工复制 dist 到 profile node_modules，pnpm 跨盘 file/link 已知坑）；端到端验证通过（采集入库/注入入会话/`mcp__thread__query_session_memory` 查询可用），回归链全绿。
