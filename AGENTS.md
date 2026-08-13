# AGENTS.md — Thread 项目指南（AI 编码工作流）

## 项目是什么

Thread：编码 Agent 的会话记忆层（*Session memory with lineage for coding agents*），底座无关。
核心价值：长任务上下文保真——决策不丢、目标不漂移、不重复提问。事件流水无损存储 + 按需检索，关键路径（目标 + 情节状态）O(1) 常驻。

**动手前必读**：[session-memory-system-design.md](./session-memory-system-design.md)——需求与架构权威文档（已确认）。实现与设计不一致时，先改设计文档再改代码。

## 技术栈与结构

- TypeScript（strict / ESM / NodeNext）、Node >= 20、pnpm monorepo
- `packages/core`：事件流水、结构化表（目标/决策/反馈）、血缘图、BM25 检索
- `packages/adapters/qoder-cli`：第一参考适配器（hooks 采集 / 上下文注入 / MCP query 工具）
- `packages/evals`：回归集（长任务场景、事实保留率检查）
- 底座：Qoder CLI（狗粮）；Codewhale（Hmbown/CodeWhale）= 第二候选，能力未验证

## 常用命令

```sh
pnpm install       # 安装依赖
pnpm typecheck     # build + 类型检查（全部包）
pnpm lint          # eslint
pnpm test          # vitest
pnpm build         # 编译全部包（core 先构建，依赖拓扑自动排序）
pnpm changeset     # 用户可见变更需生成 changeset
```

## 代码约定

- strict 模式、ESM 专用（NodeNext 解析）；`dist` 是构建产物，源码在 `src`。
- 不写注释，除非 WHY 非显而易见。
- 测试放源码旁：`src/**/*.test.ts`。
- 用户可见变更必须附带 changeset。
- 提交前跑完整验证链：`pnpm typecheck && pnpm lint && pnpm test`。

## 工作流约定

1. 以设计文档为准：改动涉及架构/接口时，先更新设计文档再实现。
2. 旁路增强（语义抽取、本地小模型、轻确认模型化）属于二期；MVP 只做确定性实现，绝不阻塞主路径。
3. 事件流写入必须"写时即建索引"；任何旁路处理可失败可重试，不得阻塞对话主路径。
4. 存储选型已定方向：SQLite（better-sqlite3）+ FTS5 BM25；`session_id` 从第一天带上。
5. Agent 本地配置（`.qoder/`、`.claude/` 等）不入库；项目级规则统一维护在本文件与设计文档中。

## 狗粮循环（Dogfooding）

- **原则**：用当前版本的 Thread 管理 Thread 自身的开发会话上下文——开发即测试。当前基线 = 当前已提交版本（v0 MVP）。
- **接入点**（`.qoder/settings.json` hooks + `.qoder/settings.local.json` MCP，均为本地配置不入库）：
  - 采集：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` → `scripts/capture.mjs`（异步）；capture 内联确定性轻确认（`applyAnalysis`），用户消息/Agent 回复写入结构化表（目标/决策/反馈）；Agent 回复正文从 `transcript_path` 尾部提取（`extractLastAssistantTurn`，按 uuid 去重）
  - 注入：`UserPromptSubmit` → `scripts/status-card.mjs`（同步，`hookSpecificOutput.additionalContext` + 必填 `hookEventName`）
  - 查询：MCP server `thread-sms` → `packages/adapters/qoder-cli/dist/server.js`，工具 `query_session_memory`
- **生效时机**：hooks 即时生效（当前会话可用）；MCP 配置变更后 `/mcp reload` 或开新会话生效。
- **升级循环**：迭代 Thread 代码 → `pnpm build` 重建 → 开新会话即用新版本（脚本路径固定，无需改配置）；新版本经回归集 + 狗粮验证后再升级基线。
- **迭代时的自测纪律**：本会话中的用户消息/工具调用/决策已实时入库（`.thread/sms.db`），可用 `query_session_memory`（新会话）或直接查库验证；发现漏召回/误判记入回归集场景。手动演练 capture/status-card 脚本时必须设 `THREAD_DB` 指向临时库，严禁写入生产 `.thread/sms.db`。
