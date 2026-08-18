---
"@thread-memory/core": minor
---

情境化记忆传达（§1.5 P0 情境 C+A）：buildStatusCard 升级为情境路由器

- 新增 `situation` 参数（normal/new-session/post-compact）与 `detectSituation` 程序判定
- 情境 A 新会话续接：首轮有历史 → 追加"会话接续块"（沿用目标/决策），用户无需显式提醒
- 情境 C 压缩边界回归：最近事件含 compact_checkpoint → 追加"压缩回归块"（目标重述）
- normal 情境不追加传达块（避免每轮塞指令）；隔离模式下不继承
- 单测 +8（detectSituation 4 + 传达块 4）
