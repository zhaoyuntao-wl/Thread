---
"@thread-memory/core": minor
---

证据门（P0-2 第一步）：

- 新表 `evidence(id, project_key, session_id, criterion, command, exit, passed, env_fingerprint, commit_ref, created_at)`，`SCHEMA_VERSION` 10 → 11，旧库打开补建；
- `verifyCriteria(store, {projectKey, sessionId, criteria})`：逐条跑命令、落证据（退出码 + 环境指纹 + commit），返回结构化结论（passed / failed / missing-env）；
- `evidenceProgress` / `checkCompletionGate`：按验收条目算"已证 X/Y"，缺证据时拒绝标完成并列出缺口；
- `renderEvidenceLine`：`验收 3/5 已证（缺：a、b）`；
- 8 项单测覆盖通过与失败落库、缺环境不落证据、门禁放行/拦截、失败证据不算已证、进度渲染。
