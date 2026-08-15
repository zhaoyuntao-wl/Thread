# AGENTS.md — Thread 项目指南（AI 编码工作流）

## 项目是什么

Thread：编码 Agent 的会话记忆层（*Session memory with lineage for coding agents*），底座无关。
核心价值：长任务上下文保真——决策不丢、目标不漂移、不重复提问。事件流水无损存储 + 按需检索，关键路径（目标 + 情节状态）O(1) 常驻。

**动手前必读**：[docs/design/v1/session-memory-system-design.md](./docs/design/v1/session-memory-system-design.md)——需求与架构权威文档（v1 基线，已确认）。实现与设计不一致时，先改设计文档再改代码。二期规划与未决项见 [docs/design/v2/session-memory-system-design.md](./docs/design/v2/session-memory-system-design.md)，规划讨论不进 v1 基线。

## 技术栈与结构

- TypeScript（strict / ESM / NodeNext）、Node >= 20、pnpm monorepo
- `packages/core`：事件流水、结构化表（目标/决策/反馈）、血缘图、BM25 检索
- `packages/adapters/qoder-cli`：适配器矩阵一员（hooks 采集 / 上下文注入 / MCP query 工具，Qoder 基线保留）
- `packages/adapters/dsh`：dsh 旗舰插件（订阅 `session/event` 采集 + `agent/pre-step` 状态卡注入；查询走 MCP overlay）
- `packages/evals`：回归集（长任务场景、事实保留率检查）
- 底座：**dsh（当前狗粮，2026-08-14 切换，headless profile）**；Qoder CLI 降为适配器矩阵一员（hooks 代码与回归保留）；Codewhale（Hmbown/CodeWhale）= 第二候选，能力未验证。dsh 插件升级受 preview 破坏性变更影响，依赖钉 `0.1.0-rc.6`，挂载方式与风险见设计 v2 待验证点 ④。

## 常用命令

```sh
pnpm install       # 安装依赖
pnpm typecheck     # build + 类型检查（全部包）
pnpm lint          # eslint
pnpm test          # vitest
pnpm eval          # B⑦ 场景级保真回归集（9 场景聚合，CI 门禁）
pnpm build         # 编译全部包（core 先构建，依赖拓扑自动排序）
pnpm changeset     # 用户可见变更需生成 changeset
```

## 代码约定

- strict 模式、ESM 专用（NodeNext 解析）；`dist` 是构建产物，源码在 `src`。
- 不写注释，除非 WHY 非显而易见。
- 测试放源码旁：`src/**/*.test.ts`。
- 用户可见变更必须附带 changeset。
- 提交前跑完整验证链：`pnpm typecheck && pnpm lint && pnpm test && pnpm eval`。

## 工作流约定

1. 以设计文档为准：改动涉及架构/接口时，先更新设计文档再实现。
2. 旁路增强（语义抽取、本地小模型、轻确认模型化）属于二期；MVP 只做确定性实现，绝不阻塞主路径。
3. 事件流写入必须"写时即建索引"；任何旁路处理可失败可重试，不得阻塞对话主路径。
4. 存储选型已定方向：SQLite（better-sqlite3）+ FTS5 BM25；`session_id` 从第一天带上。
5. Agent 本地配置（`.qoder/`、`.claude/` 等）不入库；项目级规则统一维护在本文件与设计文档中。

## 狗粮循环（Dogfooding）

- **原则**：用当前版本的 Thread 管理 Thread 自身的开发会话上下文——开发即测试。当前基线 = 当前已提交版本（v0 MVP）。
- **狗粮双通道（2026-08-14 起 dsh 为主）**：
  - **dsh 通道（现网狗粮）**：`dsh --profile headless "任务"` 跑编码任务——采集 = `@thread/adapter-dsh` 订阅 `session/event` 写双库；注入 = `agent/pre-step` 每轮注入状态卡；查询 = MCP overlay `mcp__thread__query_session_memory`（thread-sms）。挂载 = 复制 dist 到 `~/.dsh/profiles/headless/node_modules/@thread/{adapter-dsh,core}` + `cordis.patch.yml` 持久化 MCP 条目；改插件后 `pnpm --filter @thread/adapter-dsh build` + 重新复制。
  - **Qoder 通道（保留）**（`.qoder/settings.json` hooks + `.qoder/settings.local.json` MCP，均为本地配置不入库）：
    - 采集：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` → `scripts/capture.mjs`（异步）；capture 内联确定性轻确认（`applyAnalysis`），用户消息/Agent 回复写入结构化表（目标/决策/反馈）；Agent 回复正文从 `transcript_path` 尾部提取（`extractLastAssistantTurn`，按 uuid 去重）
    - 注入：`UserPromptSubmit` → `scripts/status-card.mjs`（同步，`hookSpecificOutput.additionalContext` + 必填 `hookEventName`）
    - 查询：MCP server `thread-sms` → `packages/adapters/qoder-cli/dist/server.js`，工具 `query_session_memory`
- **生效时机**：hooks 即时生效（当前会话可用）；MCP 配置变更后 `/mcp reload` 或开新会话生效。
- **升级循环**：迭代 Thread 代码 → `pnpm build` 重建 → 开新会话即用新版本（脚本路径固定，无需改配置）；新版本经回归集 + 狗粮验证后再升级基线。
- **迭代时的自测纪律**：本会话中的用户消息/工具调用/决策已实时入库（B④ 后双库：`~/.thread/structured.db` 结构化 + `~/.thread/projects/<项目键 hash>/events.db` 事件，项目键 = 规范化 git 根、目录名 = 31 哈希 base36），可用 `query_session_memory`（新会话）或直接查库验证；发现漏召回/误判记入回归集场景。手动演练 capture/status-card 脚本时必须设 `THREAD_ROOT` 指向临时根目录，严禁写入生产 `~/.thread/`。
- **双代理协作约定（2026-08-14 用户定）**：dsh 与 Qoder 是 Thread 的两个消费者，两者信息交换**只走 Thread 标准能力**，工作区不做通信信道。
  - 标准信道（唯一允许）：事件流水（共享项目事件库）＋结构化表（目标/决策/反馈）＋ MCP 查询（`query_session_memory`）。读对方进展 = 通过 MCP 查询对方会话事件/结构化行，不直查生产库（演练除外）。
  - 非信道（禁止作通信用途）：git 提交信息/commit message 不承担进展汇报职能（只描述代码变更）；工作区共享状态文件（如 `docs/thread-feature-checklist.md`）**单一写者**维护，不做双写同步（当前清单由 dsh 侧维护，Qoder 只读）；不通过读对方正在编辑的文件/提交猜测对方意图。
  - 能力不足时：记入设计 v2 迭代规划，优先实现标准能力（如结构化查询路径），不临时走近路绕过。
