---
"@thread/core": minor
"@thread/adapter-qoder-cli": minor
---

B② 作用域与命名空间：schema v2（events/goals/decisions/feedback 增 project_key/scope/origin 列；新增 spills/entities/decision_entities/metrics 表；幂等迁移 ensureSchema）；存储治理源头控制（SpillPolicy 4K 阈值、FTS 只索引 user/assistant/compact 三类、事件正文永不进全局库）；项目键推导（规范化 git 根，非 git 退化为 cwd）；结构化写路径支持 scope（session/project/global）+ project_key + origin（先到先得默认 project 级，origin 幂等跨会话去重）；作用域合并查询（当前会话 + 同项目 project 级 + global 级反馈，非当前项目硬过滤零泄漏）；检索接口内聚（queryEvents 结构化参数在单一工具内路由，不新增工具面）；引用回拉 expand（spill 原文恢复）；capture 多写者重试（SQLITE_BUSY 100ms 重试上限 20 次）；状态卡合并显示 + 预算分档（Qoder ≤100 行）+ 词汇边界（机制词汇不进状态卡）；回归集新增 scope-filter/幂等/spill 回拉场景（evals）。
