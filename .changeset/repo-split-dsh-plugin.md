---
"@thread/core": minor
---

仓库分仓（2026-08-18）：dsh-thread 迁出为独立仓库 dsh-plugin-thread（私有，稳定后公开）。

- 本仓库 = 通用内核（core）+ 薄适配器（qoder-cli）+ 回归集（evals）
- 移除 packages/adapters/dsh 及 CI compat-dsh job（迁移至独立仓库 CI）
- 清理 changeset 中 dsh-thread 引用（发布面收窄为 @thread/core + @thread/adapter-qoder-cli）
- 文档同步：AGENTS.md / CONTRIBUTING / MAINTAINING / README / 设计文档 v1+v2 修订记录
- dsh-thread 开发期依赖 core 走 file: link，core 稳定后切 npm 版本
