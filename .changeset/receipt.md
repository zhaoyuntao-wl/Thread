---
"@thread-memory/core": minor
---

注入回执（P0-0 第二步）：

- 新增 `recordInjection(store, sessionId, { kind, summary })` 与 `lastInjection(store, sessionId)`：只记「本轮喂给模型的是什么」的摘要与时间（`kind` = status-card / handoff / anchor），不存注入正文；
- `renderPanel` 新增「本轮注入」区块，没有记录时明示未注入；
- 6 项单测：空记录、读写往返、后写覆盖、坏数据不抛错、面板披露、空态文案。
