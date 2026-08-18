---
"@thread-memory/core": minor
---

情境化记忆传达（§1.5 P0 情境 C+A + 机制 3 决策变更）：buildStatusCard 升级为情境路由器

- 新增 `situation` 参数（normal/new-session/post-compact/decision-change）与 `detectSituation` 程序判定
- 情境 A 新会话续接：首轮有历史 → 追加"会话接续块"（沿用目标/决策），用户无需显式提醒
- 情境 C 压缩边界回归：最近事件含 compact_checkpoint → 追加"压缩回归块"（目标重述）
- 情境 decision-change（§1.5.3c 机制 3）：项目最近决策 updated_at 晚于本会话最新事件 → 追加"最近决策块"（防模型基于旧状态行动，2026-08-18 误判复盘驱动）
- 新增 `getRecentDecisionsMerged`（项目级最近决策，按 updated_at 倒序）
- normal 情境不追加传达块（避免每轮塞指令）；隔离模式下不继承
- 单测 +11（detectSituation 5 + 传达块 6）
