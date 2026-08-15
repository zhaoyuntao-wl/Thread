# Thread 功能清单与状态（双代理开发验证用）

> 用途：Qoder 与 DSH 两代理交替/同时推进项目时，对照本清单顺手验证 Thread 功能。
> 状态图例：✅ 已实现+单测+狗粮实证｜🟡 已实现+单测，狗粮验证不足｜🔵 已实现，验证待补｜⚪ 规划中
> 验证维度：Q=Qoder 狗粮实证｜D=dsh 狗粮实证｜X=双代理互证（两底座写同一项目库、互查记忆）｜T=单测（vitest）
> 双库：`~/.thread/structured.db`（结构化）+ `~/.thread/projects/<项目键 hash>/events.db`（事件）；Thread 项目键 = `12k3cap`

## A. 事件流水（无损存储）

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| A1 | 事件追加（user/assistant/tool_call/tool_result/compact_checkpoint） | ✅ | T+Q+D | dsh 会话写的事件 Qoder 可查，反之亦然（**X 已证 2026-08-14**：同项目库共存 qoder:// 537 + dsh:// 172，web GUI 内 MCP 互查成功） |
| A2 | 写时即建索引（FTS5 BM25，只索引 user/assistant/compact 三类） | ✅ | T+Q+D | — |
| A3 | origin 幂等去重（同一 origin 只写一次） | ✅ | T+Q+D | **X 已证 2026-08-14**：qoder:// 与 dsh:// 体系共存互不冲突、各自唯一；**遗留已清**：迁移前 schema v1 旧事件 origin=NULL 已回填（backfill-origin.mjs，2541 条，NULL 归零、零重复、integrity ok） |
| A4 | 正文截断 + 溢出 spill（SpillPolicy 4K 阈值 → spills 表） | ✅ | T+Q | — |
| A5 | 事件流检索（queryMemory BM25 + 结构化查询 kind/since/until/count） | ✅ | T+Q+D | dsh 会话内 MCP 查 Qoder 历史事件（**X 已证 2026-08-14**：本会话 web GUI 内 query_session_memory 命中 Qoder 时代事件） |
| A6 | 引用回拉 expand（spill 原文恢复，不可回拉给缺失标记） | ✅ | T+Q | — |
| A7 | 事件 kind 分布统计 eventKindCounts（审计/分布路径） | ✅ | T | 新增 2026-08-14（events.ts + events.test.ts，changeset feat-event-kind-counts） |

## B. 结构化表（目标/决策/反馈状态机）

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| B1 | 轻确认分析 applyAnalysis（用户消息→目标、Agent 回复→决策/反馈） | 🟡 | T+Q+D | **2026-08-14 降级**：实测结构化库 goals=0/decisions=0/feedback=4，规则阈值过严（GOAL_RE 动词开头、DECLARE_RE 显式宣称），真实会话产出极少，狗粮实证不足 |
| B2 | 决策状态机（proposed/active/superseded，assertTransition） | ✅ | T+Q | — |
| B3 | 目标状态更新（updateGoalStatus） | ✅ | T+Q | — |
| B4 | 结构化查询视图（active 目标/决策/反馈） | ✅ | T+Q+D | — |

## C. 跨会话继承（v2 核心）

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| C1 | 合并视图（当前会话 + 同项目 + global） | ✅ | T+Q | — |
| C2 | 分层优先级裁决 applyScopePriority（session > project > global，归一化去重） | ✅ | T+Q | — |
| C3 | 状态卡继承展示（"（来自其他会话）"标记） | ✅ | T+Q+D | **已实证**：dsh 状态卡显示 Qoder 会话反馈（D） |
| C4 | 项目键隔离（非当前项目硬过滤零泄漏） | ✅ | T+Q | — |

## D. 作用域与命名空间（schema v2）

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| D1 | 作用域字段（scope: session/project/global）+ 项目键（project_key） | ✅ | T+Q | — |
| D2 | 项目键推导（规范化 git 根，非 git 退化 cwd） | ✅ | T+Q+D | 两底座在同一目录跑必须解析出同一项目键（X 已证：均 12k3cap） |
| D3 | 幂等 schema 迁移 ensureSchema | ✅ | T+Q | — |

## E. 存储治理（B④ 物理分库）

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| E1 | 双库路由（结构化=用户级库、事件=项目库；血缘边按端点域路由） | ✅ | T+Q+D | — |
| E2 | 迁移 migrateSplit（复制式+校验+增量重放 replayIncrement） | ✅ | T+Q | — |
| E3 | SQLITE_BUSY 重试（100ms×20，capture/插件侧） | ✅ | T+Q+D+X | **X 已证 2026-08-14**：真并发窗口（dsh 会话写至 id 3363 时 Qoder hooks 并行写），integrity_check=ok、零丢失 |
| E4 | THREAD_ROOT 覆盖根目录（测试隔离） | ✅ | T | — |

## F. 注入与展示

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| F1 | 状态卡构建 buildStatusCard（合并视图+预算分档+词法边界） | ✅ | T+Q+D | 2026-08-14 起 defaultPaths/threadRoot/buildStatusCard 抽 core 复用，qoder 与 dsh 共用防漂移（paths.ts/status-card.ts） |
| F2 | Qoder hooks 注入（UserPromptSubmit → additionalContext） | ✅ | Q | — |
| F3 | dsh 注入（agent/pre-step 每轮 + 自身注入过滤防自循环） | ✅ | D | — |
| F4 | 注入进压缩摘要（inject → compaction 输入重放前缀） | ✅ | D（spike 实证） | — |

## G. 适配器（底座无关矩阵）

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| G1 | Qoder 适配器（capture/status-card/query hooks + MCP server） | ✅ | Q | 保留为基线，双代理下持续用 |
| G2 | dsh 插件 @thread/adapter-dsh（采集+注入） | ✅ | D | headless + web 双 profile 已挂载 |
| G3 | MCP 查询通道（thread-sms → query_session_memory） | ✅ | Q+D | dsh web UI 内工具可用（**X 已证 2026-08-14**：本 dsh web 会话内调用成功） |
| G4 | 双代理同项目并行写（SQLITE_BUSY 窗口） | ✅ | T（压测 8×500）+X | **X 已证 2026-08-14**：真并发窗口（dsh 会话与 Qoder 会话同时活跃写同一项目库，事件 id 连续至 3366），integrity_check=ok、双 writer 均成功、MCP 实时互查命中 |

## H. 验证体系

| # | 功能 | 状态 | 验证维度 | 双代理验证点 |
|---|---|---|---|---|
| H1 | 回归集 evals（B⑦ 场景级保真） | ✅ | T | **B⑦ 已实现 2026-08-15**：6 turns 场景（decision-chain / goal-retention / repeat-question / file-lineage / compact-fidelity / injection-follow）+ 3 专项（scope-filter / migration-lossless / rebuild-recovery），`pnpm eval` 聚合 9/9 PASS + 非零退出码，CI 门禁已加（ci.yml） |
| H2 | 场景级保真度量 | ⚪ | — | 规划（B⑤ 度量埋点） |
| H3 | 知识记忆轨/一体化记忆轨 | ⚪ | — | 规划（B⑥） |

## 双代理工作流建议

- **交替推进**：一个代理改核心（core/store 等），另一个代理跑回归 + 补测试（evals），互查对方产生的记忆（A1/A3 互见）
- **同时推进**：两代理开不同会话同跑项目（写同一项目事件库），结束时查 E3（并发写零丢失）与 A3（origin 幂等互不污染）
- **验收顺序**：改功能 → 本清单标状态 → 双代理各跑一遍验证路径 → 记入回归集（H1）
- **切换底座时的记忆连续性**：新 dsh 会话开场状态卡应显示 Qoder 会话的决策/反馈（C3 已实证，保持为常驻检查项）
