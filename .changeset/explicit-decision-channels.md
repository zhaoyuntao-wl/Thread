---
"@thread-memory/core": major
---

决策/偏好结构通道化 + 目标判定粘贴守卫 + 资源治理 API（2026-08-21 碎片误报治理，发布前定案）

- **停用决策/偏好自然语言判定**：USER_DECLARE_RE / DECLARE_RE / PREFERENCE_RE / SUPERSEDE_RE / REVOKE_RE / ACCEPT 全部移除——无锚定正则对粘贴/回显文本零防御（生产实证：9 条候选 5 条碎片误报）。决策与偏好只走显式通道（命令/模型工具），文本启发式误报归零
- **目标判定保留 + 粘贴守卫**：GOAL_RE（句首祈使动词）保留；新增多行（含换行）与 >200 字符守卫——md 提示词粘贴/附件内联/文件直读均不误判（生产实证：真实目标单行 ≤~105 字符，误报目标为多行粘贴转写）
- **显式决策通道 store API**：addDecision（命令/工具创建直接 active）/ promoteCandidate（候选转正，可带修正文本；修旧 confirm 只翻候选状态不落 decisions 行的死路）/ deleteDecision（硬删除 + 血缘边清理，事件流水保留原文）/ supersedeDecisionById（按 id 取代，replacement 继承项目/scope/隔离字段）；移除 confirmLatestProposed / revokeLatestActive / supersedeLatestActive / getLatestProposed 旧 latest 系 API
- **资源治理 API（命令重构配套）**：deleteAsset（产出解除登记 + 双库血缘边清理）/ getGoals（全状态目标列表）/ listIsolatedRows 扩展 ast 产出 / unisolateRow 覆盖 knowledge_assets
- **产出登记路径幂等 + 隐藏目录排除（2026-08-21 狗粮实证：thread-reg ast 重复与 changeset 噪音）**：registerAsset 同 path 可见范围内去重（只刷新标题，不再堆行——生产 README 同 path 12 行）；classifyWriteEvent 不识别隐藏目录（.changeset 等）下的 md
- **完成判定窗口分级（2026-08-21 狗粮误报修复）**：英文 4 字符窗口可碰撞（北极星"Thread"被消息"thread-reg"命中"read"误 completed）→ 含非 ASCII 窗口 ≥4、纯 ASCII 窗口 ≥8 连字符；归一化去空白
- 完成判定（短消息守卫 >100 字符）保持不变；事件流水无损 = 未显式记录内容仍可回拉（下限不丢）
- 验证链：core 204 单测 + eval 15/15（decision-chain/isolation/rebuild 场景改走显式通道断言）
