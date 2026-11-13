---
"@thread-memory/core": patch
---

修复：`handoffs` 表加了但 `SCHEMA_VERSION` 未升级，已存在的库被 `ensureSchema` 的快速短路跳过建表 → `/thread-panel`、`handoff_next` 在真实库上报 `no such table: handoffs`。

- `SCHEMA_VERSION` 9 → 10，旧库打开时补建 `handoffs` 与索引；
- 新增迁移回归测试：构造「盖到上一版本、无 handoffs 表」的旧库，打开后必须能查询 handoffs。
