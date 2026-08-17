# Thread 技术设计（代码级设计与约束）

## 0. 文档关系

- [v1 设计](./session-memory-system-design.md)：需求与架构权威基线
- [v2 设计](./session-memory-system-design.md)：二期规划、底座战略、产品包络
- [物理分库专篇](./b4-storage-split.md)：用户级结构化库 + 项目事件库
- **本文**：代码级设计与约束——实现必须遵守。与 v1/v2 冲突时先改文档再改代码。

范围：产品包络"做 9 / 不做 4"全部功能 + provider 抽象 + 适配器矩阵的代码级设计。

## 1. 模块边界（monorepo）

```
packages/core                保真核心（底座无关）
  src/events.ts              事件 kind / 截断
  src/schema.ts              schema v3 + 迁移链
  src/store.ts               schema + 读写 + 血缘
  src/state.ts               状态机转换断言
  src/query.ts               BM25 检索 + 结构化查询
  src/light-confirm.ts       轻确认旁路
  src/status-card.ts         状态卡构建
  src/migrate.ts             单库 → 双库迁移核心
  src/governor.ts            存储治理：SpillPolicy / 索引分层 / Archiver 接口
  src/providers.ts           KnowledgeProvider / CompactionSource 抽象
  src/retrieve.ts            引用回拉：search → expand(origin)
packages/adapters/qoder-cli  Qoder 适配器（capture/status-card/server）
packages/adapters/claude-code [规划] MCP overlay + hooks
packages/adapters/codex      [规划] MCP overlay + hooks
packages/evals               回归集 runner + 度量
```

依赖规则（硬约束）：`core` 不得 import 任何 `adapters/*` 或底座 SDK；适配器只做三弱能力映射与协议翻译；`evals` 可依赖 core 与适配器。

## 2. 数据模型

### 2.1 事件库 schema（events.db）

`events`（session_id/kind/ts/seq/body/meta/truncated/project_key/scope/origin/spilled/isolation）、`events_fts`（FTS5 unicode61, content='events'）、`episodes`、`spills`（event_id/ref/blob/sha256）、`schema_version`。WAL + busy_timeout。

### 2.2 结构化库 schema（structured.db）

`goals` / `decisions`（proposed/active/superseded/revoked + superseded_by）/ `feedback`（preference/correction）/ `entities` / `decision_entities` / `metrics` / `schema_version`，均含 `project_key`/`scope`/`origin`/`isolation` 列。

### 2.3 会话隔离（schema 增量）

```sql
-- 事件与结构化表增量列：isolation=1 的行仅建立会话可见
ALTER TABLE events    ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals     ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback  ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0;

-- 会话级隔离开关
CREATE TABLE IF NOT EXISTS session_isolation (
  session_id TEXT PRIMARY KEY,
  isolated INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

隔离过滤语义：`isolation=1` 的行全链路仅自己可见（合并视图 / search / queryEvents / expand / 血缘全部过滤）；tool 类事件恒共享（写入时 isolation 强制 0，项目事实不断链）；解除隔离后历史仍隔离，`unisolateRow` 按需转共享。schema 版本常量 `SCHEMA_VERSION = 3`。

### 2.4 索引分层

FTS5 只对 `indexable` 事件建索引。indexable 集合：`user_message`、`assistant_message`、`compact_checkpoint`、结构化表正文（目标/决策/反馈）。`tool_call` / `tool_result` 大块**不建全文索引**，检索命中轻量事件后经 `origin`/`spill` 回拉原文。

### 2.5 迁移（单库 → 双库物理分库）

`ensureSchema` 幂等迁移（schema v1 → v2 → v3 加列/建表，schema.ts）；物理分库迁移核心在 `packages/core/src/migrate.ts`（纯函数，可被测试直接 import）。

**复制式迁移**：旧库只读、不改旧库 DDL，新库独立写入——避免"原地结构变更 + 并发写"组合风险；零差异由**增量重放**保证（快照后 `id > snapshot_id` 增量按 origin 幂等补拉）。

## 3. 核心接口契约

### 3.1 EventWriter.append 事务契约

```ts
interface AppendOptions {
  sessionId: string;
  kind: EventKind;
  ts: string;
  body: string;
  meta?: Record<string, unknown>;
  projectKey?: string;
  scope?: "global" | "project";
  origin: string;           // 幂等键 + 底座事件引用（含底座前缀：qoder:// / dsh:// / claude:// / codex:// + 事件 uuid）——跨底座天然唯一
  isolation?: boolean;      // 本会话隔离期写入标记（tool 类事件恒共享，忽略此标记）
}
```

单事务内顺序：① 幂等检查（`origin` 已存在 → 返回已有，不重复落库）② 截断决策（`SpillPolicy.evaluate(body)`）③ 落 events ④ 若 spill：摘要入 body + spills 表写入 + `spilled=1` ⑤ FTS 分层索引（仅 indexable）⑥ 血缘边（file/tool 元数据）⑦ 情节更新。任一步抛错 → 整体回滚，调用方视为未写入。幂等键统一为 `origin`。

### 3.2 SpillPolicy

```ts
interface SpillPolicy {
  evaluate(body: string): { spill: boolean; kept: string; ref?: string };
}
// 默认：正文 > 4K → 保留前 400 字符摘要 + origin 引用；blob 存 spills 或 ref 指向底座日志
// dsh 适配器：正文不复制（事件订阅，origin = dsh://session/event，spill 恒 false）
```

### 3.3 Retriever（引用回拉 + 结构化查询）

```ts
interface RetrievalHit {
  eventId: number;
  sessionId: string;
  kind: EventKind;
  body: string;          // 索引正文（轻量）
  score: number;
  origin?: string;       // 可回拉原文的引用
  spill?: { sha256: string; ref: string };
}
interface Retriever {
  search(query: string, opts: { scope?: "global" | "project"; projectKey?: string; limit?: number }): RetrievalHit[];
  expand(hit: RetrievalHit): string;  // 回拉原文：spill.blob → spills 表；origin → 底座日志/适配器；不可回拉时返回 body + 缺失标记
}
```

**双路径**：语义类查询走 BM25（`queryMemory`）；时序/计数/审计类查询走结构化路径（`queryEvents`——kind 过滤/时间范围/排序/计数，MCP 工具内置结构化参数 `kind`/`since`/`until`/`order`/`count_only`，server 内聚路由）。

**设计方向（接口内聚 + 主动提醒，非接口膨胀）**：不新增一堆查询接口——**模型不该被指望自觉识别查询类型**。① **查询接口内部做路由**——单一 `search` 入口内识别查询意图（时序/计数/审计类 → 结构化执行路径，语义类 → BM25 路径），对外保持一个接口；② **状态卡注入提醒驱动触发**——状态卡按上下文注入合适的检索提醒（何时可用/该走哪条路径），由提醒触发查询而非模型自己判断。回归场景：抽查类精确时序问题必须有服务层路径，禁止绕过直查库。

### 3.4 StateCardBuilder

```ts
interface StateCard {
  goals: Goal[];
  decisions: Decision[];        // active 优先，superseded 折叠
  feedback: FeedbackRow[];      // 最近 N 条
  recent?: SessionEvent[];      // 最近事件摘要
}
// build(): O(1) 查询（按 project_key + scope 合并，分层优先级 会话内>项目>用户>全局）
// build(opts.isolated=true)：隔离模式只列本会话内容（不继承项目/全局），状态卡标注"本会话已隔离"
// 预算约束：≤200 行 / 单轮注入 token 预算（借鉴 CLAUDE.md 200 行 + workbuddy 分层裁决）
// 序列化：XML 标签包裹 + 分级格式（critical 区 JSON / context 键值 / recent 摘要），
//   预算分层 critical 60% / context 25% / recent 15%（默认可配）——见 business-design §2.3
// 注入隔离：内容 = 数据非指令（XML 区域 + JSON 转义 + 物理隔离），防存储型提示注入（business-design §2.3）
```

### 3.5 StateMachine

现有转换规则（`state.ts` assertTransition）：goal `active → completed | dropped`；decision `proposed → active → superseded | revoked`；所有转换必须经断言。

### 3.6 Provider 抽象

```ts
interface KnowledgeProvider {
  save(entry: { text: string; scope: "global" | "project"; projectKey?: string }): Promise<void>;
  query(q: string, opts: { limit?: number }): Promise<Array<{ text: string; ref?: string }>>;
  delete(id: string): Promise<void>;
}
// 实现：marm / codebase-memory-mcp（MCP client）/ 本地 BM25 兜底（core 自带）
// CompactionSource：各底座压缩事件 → compact_checkpoint
```

**集成层约束**：Provider 为**可选注入**（接口存在、缺省降级），非强依赖——core 不 import 第三方实现；发布物只含集成推荐清单（文档），不打包第三方代码；BM25 兜底常驻，provider 缺失走降级不报错。

### 3.7 StorageGovernor / Archiver / Rebuilder（接口预留，实现延后）

```ts
interface Archiver {
  archive(projectKey: string, beforeTs: string): Promise<{ moved: number; dbPath: string }>;
  // VACUUM INTO + 摘要级二级索引；实测膨胀率后定阈值，再实现
}
interface Rebuilder {
  rebuild(sessionId?: string): Promise<{ events: number; episodes: number }>;
  // 从事件流水重建派生层（FTS/情节/结构化表/血缘）——事件流水是唯一真相源
}
```

**事件溯源可重建性**：结构化表 / FTS 索引 / 情节 / 血缘 = 派生数据，`events` 流水 = 唯一真相源；崩溃、DB 损坏、迁移事故的恢复路径 = `Rebuilder.rebuild()`；恢复演练入回归集。

## 4. 不变量（代码级约束）

1. **写时即建索引**：append 事务内完成 FTS + 血缘，失败回滚；不存在"后补索引"路径。
2. **确定性**：核心路径零 LLM；旁路（light-confirm / 语义抽取）可失败可重试，绝不阻塞主路径。
3. **无损语义**：任何截断必须带 `truncated` + `origin`/`spill`，原文可回拉；"无损"= 可检索回拉，非全文复制两份。
4. **引用不可断裂**：lineage_edges / spills.event_id 必须指向存在的 id；适配器写入时校验，违规拒绝。
5. **状态机合法转换**：所有状态变更经 `assertTransition`。
6. **幂等**：capture 按事件 `origin`（底座前缀 + 事件 uuid）去重（全 kind）。
7. **预算**：状态卡 ≤200 行；FTS 只索引 indexable kind（存储治理源头控制）。
8. **底座无关**：core 零底座 import；适配器只做三弱能力映射（hook 事件 / 上下文注入 / MCP）。
9. **迁移无损**：迁移后 count + 抽样 hash 校验，失败回滚。
10. **事件溯源可重建**：events 流水 = 唯一真相源；派生层（结构化表/FTS/情节/血缘）可从流水重建；禁止只改派生层不落流水。
11. **主动权在 Thread（顶层原则）**：模型不可控，**不把希望放在模型上**——Thread 与模型的交互口越少越好，模型不需要理解记忆系统的结构；状态卡主动注入提醒触发查询，模型只需记住一条行为契约：**"需要啥就来问，别自己瞎猜"**。任何新能力先问"能否收进现有接口 / 能否由状态卡提醒驱动"，禁止靠暴露更多接口让模型自觉识别。
    - **边界声明**：本原则**降低而非根除模型元认知依赖**——"需要啥就来问"仍要求模型先意识到自己不确定；无意识盲区（模型以为自己知道）由状态卡提醒兜底，兜不住时接受失败可见（not-found 契约 + 漏召回日志），不得假装兜底完美。
    - **提醒治理**：接口少 ≠ 提醒少——提醒过频导致"狼来了"脱敏；提醒内容不得泄露记忆系统内部结构（只说"需要就说"，不说"有哪些查询路径"）。频度/内容走度量（injection_follow_rate + 脱敏信号）。
    - **词汇边界**：状态卡 = 用户可理解的事实 + 低频冲突询问（如"项目已有决策：用 pnpm（来自其他会话）。本会话沿用还是改用？"），**永不出现 session/project/scope 等机制词汇**；机制词汇只出现在工具描述契约段。后来者选择提醒仅在冲突发生时出现（低频，非每轮），面向用户意图而非机制。
    - **契约载体分层**：行为契约独立于状态卡（状态卡保持纯数据），走"最强且不可修改"通道——① **主通道 = 工具描述内置**（`query_session_memory` 的 description 写死契约段：需要历史/不确定时调用、不编造、结果带引用；工具描述模型每轮可见、用户不可改、不进事件流水，跨底座一致）；② **增强 = dsh `agent/pre-step` 每步校验/重注入**（旗舰专属）；③ **系统侧注入段** = 适配器常量文本（尽力而为）；④ **状态卡提醒 = 兜底触发**（只说"需要就说"）。
    - **注入安全原则**：Thread 的每轮注入一律以**追加 user message** 形式落地（pre-step `agent.inject` / Qoder additionalContext），**禁止改写、删除、替换底座任何 section**（persona/plan 等）——整段替换曾导致模型丢 plan 边界、重复探索仓库（外部实证）；追加式注入天然免疫该病，原则写死防回归。

## 5. 适配器契约

| 底座 | 采集 | 注入 | 查询 | 幂等键 |
|---|---|---|---|---|
| Qoder | UserPromptSubmit/PreToolUse/PostToolUse/Stop/PostCompact hooks | UserPromptSubmit → status-card（additionalContext） | MCP server query_session_memory | transcript 事件 uuid |
| dsh | session/event 订阅（零正文复制） | agent.inject()（进下一条被采纳请求） | 内嵌 MCP server（bin=`dsh-thread`；`ctx.tools` 注册为备用接缝） | session 事件 id |
| Claude Code | hooks（UserPromptSubmit/Stop/PreCompact） | hookSpecificOutput.additionalContext | MCP | 事件 uuid |
| Codex | hooks / rules | hooks / MCP 注入 | MCP | 事件 uuid |

dsh 原生接缝补充：`agent/pre-step` 瀑布可改写/拒绝模型所见（完全接管通道）；`ctx.goals` 仅同会话，跨会话由 Thread 结构化表承担。

### 5.1 幂等与多写者

- **幂等键 = origin**：`origin` 含底座前缀（`qoder://` / `dsh://` / `claude://` / `codex://` + 事件 uuid），跨底座天然唯一；多底座同项目并发写同一库不冲突。
- **同项目单库多写者**：SQLite WAL + busy_timeout + 写失败重试队列（capture 异步，失败入队重试，不阻塞）。**实证：`busy_timeout` 不排队**——多进程并发写 WAL 时立即抛 `SQLITE_BUSY`（"database is locked"），重试循环（catch `e.code==='SQLITE_BUSY'` → sleep → 重试）是成功保证（压测 8 写者 × 500 全成功、70 次重试、零丢失、integrity ok）；**capture 必须实现 SQLITE_BUSY 重试**（100ms 间隔、上限 ≥20 次），超限仍失败则入持久化重试队列不丢弃。
- **结构化表多写者语义（先到先得 + 后来者选择 + 建立者专属）**：
  - **先到先得**：决策/目标/反馈同域无对立时，第一次提出默认 `project` 级（成为项目共有，跨会话继承有内容）——不需用户显式确认即可建立项目共有层
  - **后来者选择**：写入时经冲突域检测（实体共享）发现同域已有 project 级 active → 状态卡提醒（"项目级：pnpm；可跟随或会话级覆盖"），不自动写入对立决策，等用户当前会话表态——**跟随**（不入库）或 **session 级覆盖**（落 `scope=session`，不动 project）
  - **建立者专属**：project 级只有 `origin` 建立者可发起修改（仍须用户确认）；其他会话只读（状态卡标注"只读，改需回建立会话或显式授权"）或 session 级覆盖
  - **冲突域 = 实体共享（图谱，确定性，迭代通道预留）**：决策写时确定性抽取实体（包名/文件/命令/函数）→ `decision_entities` 边；新决策实体集 ∩ project active 决策实体集 ≠ ∅ → 冲突提醒。纯对话决策（抽不到共享实体）退回 text 匹配 + 用户确认兜底；语义实体（抽象主题）列为旁路增强。误报可接受（宁可多提醒，后来者选择成本低），误报率入度量
- **子代理**：不采集子代理内部事件——子代理结论经主会话 tool_result 回流（轻确认旁路可提取候选决策）；主会话 → 子代理会话血缘关联为**可选边**（底座暴露时记录，低成本）。

## 6. 验证体系代码级

- `packages/evals` runner：`runScenario(name, script)`——脚本构造真实会话事件流 → 跑断言；CLI 入口 `pnpm eval`。
- 回归场景清单 + 断言 + 判据（10 场景，`pnpm eval` 聚合 PASS）：
  - decision-chain：决策链跨事件保留 → 断言：压缩后 active 决策仍可检索，判据 = 保留率 ≥90%
  - repeat-question：已答信息不重复提问 → 断言：检索命中原文，判据 = 命中率 ≥90%
  - goal-retention：目标跨压缩留存 → 断言：checkpoint 后状态卡含原目标，判据 = 100%
  - compact-fidelity：压缩掉细节可回拉 → 断言：expand 返回原文，判据 = 回拉成功率 ≥95%
  - injection-follow：状态卡 active 决策被遵循 → 判据 = 遵循率 ≥80%
  - scope-filter：非当前项目硬过滤 → 判据 = 零泄漏
  - migration-lossless：迁移后 count + 抽样 hash → 判据 = 零差异
  - rebuild-recovery：删除派生层后 rebuild 恢复 → 判据 = 与重建前一致
  - isolation：会话隔离边界 → 断言：隔离行仅建立会话可见（合并视图/检索/血缘过滤）、tool 事件共享、解除后历史仍隔离、按需沉淀转共享，判据 = 零泄漏
  - **对比基准（待发布前补）**：固定 3 场景（decision-chain / repeat-question / goal-retention）跑"外部底座对照"——Claude Code 或 dsh 原生（无 Thread）基线，结果入 metrics 不阻塞 CI 主链（需真实底座环境，手动脚本）；产出 = "场景级保真度量无人区"的对比证据
- 度量埋点：metrics 表（recall_miss / repeat_question / correction / storage_growth / injection_follow_rate）；埋点后由 evals 汇总输出。
- CI 门禁：`pnpm eval` 纳入提交前验证链（typecheck && lint && test && eval）；回归失败阻塞合入。

## 7. 存储治理代码级

- 源头控制：SpillPolicy 默认阈值 4K；FTS 分层（indexable 集合）；项目分库（project_key 隔离）。
- 冷热归档（延后）：Archiver 接口预留；实测膨胀率（metrics.storage_growth）后定阈值（天数/GB）与实现（VACUUM INTO + zstd + 摘要级二级索引）。
- 无损语义约束下归档：归档只迁移"索引影子 + 摘要"，原文仍留在底座日志/归档库，`expand()` 对归档库只读回拉。
