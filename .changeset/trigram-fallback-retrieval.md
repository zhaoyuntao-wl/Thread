---
"@thread-memory/core": minor
---

检索质量补强：trigram 子串召回兜底（0-e 定案第 5 条落地，SCHEMA_VERSION 6）

- 新增 `events_fts_tri` 独立 trigram FTS 表：主路径（jieba 词级 BM25）0 命中时，"用户只记得半句"（查询是正文 token 的连续子串）由 trigram 短语匹配兜底召回
- 兜底表用纯时间衰减排序（trigram 打分区分度差），隔离/会话过滤语义与主路径一致
- **实现修正（2026-08-18）**：初版尝试单表双列（body_seg + body_tri tokenize='trigram'）失败——better-sqlite3 内置 SQLite 3.53.2 不支持 FTS5 列级 tokenizer 覆盖（parse error），改为双表（主表 unicode61 + 独立 trigram 表），语义等价
- 迁移：SCHEMA_VERSION 4→5→6 自动重建回填（按兜底表数据量判断，v5 库升级触发）
- 测试 +4（v6 迁移、半句子串兜底、隔离语义、<3 字符边界）；query 降级路径测试适配新语义（trigram 优先于降级摘要）
