---
"@thread-memory/core": minor
---

新增 handoff 交接原语（P0-1，设计 v2 §1.4b.3 / §1.4b.7）：

- `handoffs` 表（`project_key / task_id / from_session / from_role / to_session / to_role / brief_json / status / delivered_at / acked_at`）与 store 读写（`addHandoff` / `listHandoffs` / `getHandoff` / `setHandoffStatus`）；
- `buildCloseOutBrief`：从生效目标、最近生效决策、待办、proposed 决策、知识产出生成一句话目标 + ≤3 条决策 + 未决 + 下一步 + 产物指针 + 条件；
- `createCloseOutHandoff`（幂等，按 project/task 寻址）、`pendingHandoffsFor`、`renderBrief`（可推到手机的紧凑形态）、`parseBrief`；
- 状态卡新增「交接（N 条待投递）」块；`query_session_memory kind=handoff` 支持列表与按 id 取结构化 brief；
- 8 项单测覆盖 brief 生成、幂等、ack 状态推进、渲染与查询通道、卡片披露。
