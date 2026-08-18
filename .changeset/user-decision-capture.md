---
"@thread-memory/core": minor
---

机制 1：用户侧决策宣告入库 + 系统噪声过滤（§1.5.3c，2026-08-18 误判复盘驱动）

- 轻确认新增 `USER_DECLARE_RE`：用户口头定案（"就定为/就按/方案是/以后就在"等肯定性决策语）→ 写入 decisions（propose）而非 feedback——决策权威性高于偏好
- 新增 `SYSTEM_NOISE_RE`：system-reminder / AGENTS.md 变更等系统注入不抽任何结构化行（现网 35 条 feedback 中大量此类噪声）
- 决策 vs 偏好区分：偏好语（"以后不要用"）仍走 feedback，决策语（"以后就在 X 开发"）走 decisions
- 单测 +3（用户决策宣告 / 噪声过滤 / 决策偏好区分）
