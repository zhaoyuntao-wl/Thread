---
"dsh-thread": minor
---

修复注入卡片独立成轮自循环：`agent.inject()` 的状态卡会被 dsh agent-loop 作为新 turn 输入再驱动一轮（inbox hasPending → wakeDriver，dsh-agent-loop 源码实证），用户无新问题时模型被迫对纯卡片消息再答一轮并引发连锁注入。pre-step 增加守卫——本轮 claimed 消息全部为本插件注入（source.kind=plugin + source.plugin=dsh-thread）时跳过注入，切断循环；纯卡片轮由模型行为契约兜底（只读不回）。附 `isOwnInjection` 单测。
