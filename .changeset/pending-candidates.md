---
"@thread-memory/core": minor
---

轻确认候选机制（§1.5.3d）：粗筛-候选-提示，用户决策宣告需确认后入库

- 新增 `pending_candidates` 表（schema v4）：用户决策宣告（USER_DECLARE_RE）暂存为候选，未确认绝不进正式 decisions 表——防"抽错污染决策表"（2026-08-18 误判复盘驱动）
- store 候选 CRUD：addPendingCandidate / listPendingCandidates / confirmCandidate / ignoreCandidate / markCandidatePrompted / expireCandidates（提示衰减 + 超时丢弃）/ pendingCount
- light-confirm：assistant 宣告（DECLARE_RE）仍直接入库；用户宣告走候选；偏好仍直接进 feedback（保持跨项目全局偏好共享，scope-filter 回归验证）
- 状态卡：pending 计数行（"待确认（N 条，/thread-pending 查看）: 模型不得将未确认候选当正式决策执行"）——通道二提示
- 单测 +8（候选流程 4 + 判定 source 适配 4）；schema 版本断言更新
