---
"@thread-memory/core": minor
---

阻塞性问题通道（P0-3 数据层）：

- 新表 `open_questions(id, project_key, session_id, call_id, questions_json, timed, deadline, status, answers_json, created_at, resolved_at)`，`SCHEMA_VERSION` 11 → 12；
- `recordOpenQuestion` / `listOpenQuestions` / `settleOpenQuestion` / `openQuestionCount`：问题进收件箱，settled/cancelled/timed_out 出队；
- `markTimedOut(store, id, assumption)`：超时后把「模型假设的答案」落成**待确认候选**（不是正式决策），交人工复核——不静默替用户做决定；
- 表现层：状态卡在有待答问题时多一行「待答问题 N 条（未答前不应假设答案继续）」，面板新增「待答问题」区块（id / 问题文本 / call_id）；
- 6 项单测：入队、settled 出队、cancelled 出队、超时落候选、未知 id 不抛错、卡片文案。
