---
"@thread/core": minor
"@thread/adapter-qoder-cli": minor
---

B④ 物理分库：用户级结构化库 + 项目事件库。schema 拆分（EVENTS_SCHEMA/STRUCTURED_SCHEMA，两库独立 schema_version/迁移链）；ThreadStore 双库构造（eventsPath/structuredPath/projectKey，方法按表域路由）；血缘分库路由（任一端 ∈ {goal,decision,feedback} → 结构化库，两端均 ∈ {event,file,tool} → 事件库，跨库引用无外键由写入时序保证）；THREAD_ROOT 取代 THREAD_DB；capture 双库写入 + compact_checkpoint body+ts 哈希 origin 兜底；迁移核心 migrate.ts（复制式迁移：旧库只读、project_key 回填、按域拆分、count+抽样 sha256+integrity 校验、增量重放 replayIncrement 零差异）+ scripts/migrate-split.mjs CLI 包装（--dry-run/--replay）；旧库备份 .bak-b4；设计专篇 docs/design/v2/b4-storage-split.md。
