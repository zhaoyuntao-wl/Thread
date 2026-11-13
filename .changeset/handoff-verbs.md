---
"@thread-memory/core": minor
---

handoff 三动词（P0-1 补全，设计 v2 §1.4b.7）：

- `proposeHandoff`：模型侧提议交接——以当前会话状态为底，可覆盖目标/决策/未决/下一步/产物指针；同会话同目标重复提议幂等；
- `nextHandoff`：编排器动词，按 `task_id`/`role`（缺省按 project）取一条待投递交接，只读不改状态；
- `ackHandoff`：确认已消费（推进为 `ack`）；
- 与既有 `createCloseOutHandoff`/`renderBrief` 共用同一张 `handoffs` 表：命令、事件、模型、编排器四种入口，同一状态机。
