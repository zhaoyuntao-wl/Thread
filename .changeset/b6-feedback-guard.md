---
"@thread/core": minor
---

B⑥-② 反馈拦截（教训从提示升级为强制）：core 新增确定性匹配 `matchToolFeedback`/`extractBlockedTokens`——反馈行（correction/preference，合并视图）中提取"不要/别/禁止/never/don't use/avoid"后的目标工具名 token，与待执行工具名 case-insensitive 匹配，命中即拒绝并附教训原文。dsh 侧挂 `tools.guard()`（tools/pre-execute 后同步守卫，返回字符串即 deny）；Qoder 侧新增 `scripts/tool-guard.mjs`（PreToolUse 同步 hook，命中 exit 2 + stderr 教训原文）。同步修正 `scripts/capture.mjs` 隔离指令白名单（⑦ 对齐 dsh 侧）。附 9 例单测。
