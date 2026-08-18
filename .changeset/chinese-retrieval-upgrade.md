---
"@thread-memory/core": minor
---

检索质量升级：FTS5 中文分词（0-e 定案落地，development-priority 项 14）

- **jieba 预分词 shadow 列**：events_fts 重建为 contentless `body_seg` 列（`@node-rs/jieba` 2.x `Jieba.withDict`，napi-rs 预编译无 build script），写时同步分词索引
- **查询侧对称分词 + 全 OR**：替代原单字 AND（"登录方案" → `"登" AND "录" AND "方" AND "案"` 缺一字即 miss）；查询词 jieba 分词 + 停用词过滤 + 全 OR，召回精度交给 BM25
- **BM25 时间衰减**：排序 `score ASC, ts DESC`（同分近期优先；深调留 B⑤ 度量）
- **降级容错**：jieba 加载失败（平台无预编译二进制）→ 回退单字空格，检索降级不阻塞主路径
- **SCHEMA_VERSION 4 → 5**：v4 FTS 表（body 单字）自动重建为 body_seg 并回填历史（幂等，origin 无关）
- 新依赖：`@node-rs/jieba@^2.0.2`（含 win32/darwin/linux 预编译 optionalDependencies）
- 测试 +12（segment 5 + 中文检索回归 4 + FTS 迁移 1 + 版本断言更新 2），eval 10/10 保持全绿
