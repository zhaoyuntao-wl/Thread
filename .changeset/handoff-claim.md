---
"@thread-memory/core": minor
---

handoff 领取语义硬化（编排器并发安全）：

- `store.claimHandoff`：单条 `UPDATE … RETURNING` 把「选中最旧 pending」与「推进为 delivered」合成一步——两个 worker 并发 `handoff_next` 不会拿到同一条；
- `nextHandoff` 改为领取（返回后该交接即为 `delivered`）；
- `ackHandoff` 幂等：已 `ack` 再确认仍返回成功；
- 新增 `task_id` 寻址测试与并发领取测试（core 单测 224 项）。
