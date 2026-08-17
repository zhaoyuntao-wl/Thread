---
"dsh-thread": patch
---

规范对齐：dsh-tools 官方类型 + 生命周期清理 + 插件配置化

- 用官方 `@deepseek-ai/dsh-tools@0.1.0-rc.6` 的 `ToolGuard`/`ToolExecution` 类型替代手写
  `ToolGuardRuntime` 接口 + 强转（Context 声明合并直接提供 `ctx.tools`），类型随 rc 升级
  漂移可被 typecheck 捕获
- `ctx.effect` 注册生命周期清理：guard 返回的 disposer + `ThreadStore.close()`，插件卸载/HMR
  时撤销注册并关闭 SQLite 连接，不再泄漏
- 导出 `Config`（zod Standard Schema，cordis 校验后注入 apply 第二参）：`budgetLines` /
  `feedbackRows` / `busyRetries` / `busyRetryDelayMs` 四个部署参数配置化，替换硬编码
  200 / 50 / 20×100ms
