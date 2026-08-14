# Thread 技术设计（v2 代码级设计与约束）

## 0. 文档关系

- [v1 设计](./session-memory-system-design.md)：需求与架构权威基线
- [v2 设计](./session-memory-system-design.md)：二期规划、底座战略、产品包络
- [B④ 物理分库专篇](./b4-storage-split.md)：用户级结构化库 + 项目事件库（2026-08-14 提交评审，评审通过后实现）
- **本文**：代码级设计与约束——实现必须遵守。与 v1/v2 冲突时先改文档再改代码（AGENTS.md 工作流约定）。

范围：产品包络"做 9 / 不做 4"全部功能 + provider 抽象 + 适配器矩阵的代码级设计。

## 1. 模块边界（monorepo）

```
packages/core                保真核心（底座无关）
  src/events.ts              事件 kind / 截断（现有）
  src/store.ts               schema + 读写（现有）
  src/state.ts               状态机转换断言（现有）
  src/query.ts               BM25 检索（现有）
  src/lineage.ts             血缘图（现有）
  src/light-confirm.ts       轻确认旁路（现有）
  src/governor.ts            [新] 存储治理：SpillPolicy / 索引分层 / Archiver 接口
  src/providers.ts           [新] KnowledgeProvider / CompactionSource 抽象
  src/retrieve.ts            [新] 引用回拉：search → expand(origin)
packages/adapters/qoder-cli  Qoder 适配器（现有：capture/status-card/server）
packages/adapters/dsh        [新] dsh-thread 插件 bundle（订阅/注入/工具）
packages/adapters/claude-code [新] MCP overlay + hooks
packages/adapters/codex      [新] MCP overlay + hooks
packages/evals               回归集 runner + 度量
```

依赖规则（硬约束）：`core` 不得 import 任何 `adapters/*` 或底座 SDK；适配器只做三弱能力映射与协议翻译；`evals` 可依赖 core 与适配器。

## 2. 数据模型 v2

### 2.1 现库 schema（不变部分）

见 `packages/core/src/store.ts` SCHEMA：`events`（session_id/kind/ts/seq/body/meta/truncated）、`events_fts`（FTS5 unicode61, content='events'）、`episodes`、`goals`、`decisions`（proposed/active/superseded/revoked + superseded_by）、`feedback`（preference/correction）、`lineage_edges`。WAL + busy_timeout。

### 2.0 schema 版本管理（2026-08-14 补充）

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
```

迁移链规则：① 每次 schema 变更 = 一个迁移（含校验）；② 迁移按 version 递增应用；③ **禁止原地改表**（已有表结构变更必须走迁移 + 校验）；④ 迁移失败回滚（copy 备份）。B④ 是首个正式迁移。

### 2.2 v2 增量

```sql
-- events 增量列
ALTER TABLE events ADD COLUMN project_key TEXT;        -- B② 项目键
ALTER TABLE events ADD COLUMN scope TEXT DEFAULT 'project'; -- global | project
ALTER TABLE events ADD COLUMN origin TEXT;             -- 底座引用 qoder://transcript#uuid / dsh://session/event
ALTER TABLE events ADD COLUMN spilled INTEGER DEFAULT 0;

-- 大正文 sidecar：事件 body 只存摘要 + 引用
CREATE TABLE IF NOT EXISTS spills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ref TEXT NOT NULL,           -- 原文位置（spill 文件路径或底座日志引用）
  blob TEXT,                   -- 截断掉的原文（NULL 时 ref 指向底座日志，不复制正文）
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 度量埋点
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER,            -- 可空：非事件触发的度量
  name TEXT NOT NULL,          -- recall_miss | repeat_question | correction | storage_growth ...
  value REAL NOT NULL,
  ts TEXT NOT NULL
);

-- 结构化表增量列
ALTER TABLE goals     ADD COLUMN project_key TEXT;
ALTER TABLE decisions ADD COLUMN project_key TEXT;
ALTER TABLE feedback  ADD COLUMN project_key TEXT;
ALTER TABLE goals     ADD COLUMN scope TEXT DEFAULT 'project';    -- session | project | global（三层，2026-08-14 grill 定案）
ALTER TABLE decisions ADD COLUMN scope TEXT DEFAULT 'project';
ALTER TABLE feedback  ADD COLUMN scope TEXT DEFAULT 'project';
ALTER TABLE goals     ADD COLUMN origin TEXT;       -- 建立者（底座前缀 + 事件 uuid），project 级专属修改权绑定
ALTER TABLE decisions ADD COLUMN origin TEXT;
ALTER TABLE feedback  ADD COLUMN origin TEXT;

-- 冲突域图谱（2026-08-14 grill 定案：实体共享 = 冲突域，MVP 确定性抽取，迭代通道预留）
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,      -- 规范化实体名（包名/文件路径/命令/函数名）
  kind TEXT NOT NULL              -- file | package | command | function | topic
);
CREATE TABLE IF NOT EXISTS decision_entities (
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  edge TEXT NOT NULL DEFAULT 'references',   -- references | conflicts_in（预留）
  ts TEXT NOT NULL,
  PRIMARY KEY (decision_id, entity_id)
);
```

### 2.3 索引分层

FTS5 只对 `indexable` 事件建索引。indexable 集合：`user_message`、`assistant_message`、`compact_checkpoint`、结构化表正文（目标/决策/反馈，以独立 FTS 或 events 派生）。`tool_call` / `tool_result` 大块**不建全文索引**，检索命中轻量事件后经 `origin`/`spill` 回拉原文。

### 2.4 迁移（B④ → 物理分库，见专篇）

B② 已落地 ensureSchema 幂等迁移（schema v1 → v2 加列/建表，schema.ts）。B④ 为**物理分库**（用户级结构化库 + 项目事件库），代码级设计见 [B④ 物理分库专篇](./b4-storage-split.md)；迁移核心逻辑在 `packages/core/src/migrate.ts`，`scripts/migrate-split.mjs` 仅 CLI 包装。

**写者暂停协议（2026-08-14 评审修订，替代原定案）**：原定案"禁止无暂停协议下在线迁移"针对**原地结构变更 + 并发写**组合风险（SQLite DDL + 并发写）。B④ 采用**复制式迁移**——旧库只读、不改旧库 DDL，新库独立写入，组合风险解除，不再需要写者暂停协议；零差异由**增量重放**保证（快照后 `id > snapshot_id` 增量按 origin 幂等补拉，见专篇 §7）。

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
}
```

单事务内顺序：① 幂等检查（`origin` 已存在 → 返回已有，不重复落库）② 截断决策（`SpillPolicy.evaluate(body)`）③ 落 events ④ 若 spill：摘要入 body + spills 表写入 + `spilled=1` ⑤ FTS 分层索引（仅 indexable）⑥ 血缘边（file/tool 元数据，现有）⑦ 情节更新。任一步抛错 → 整体回滚，调用方视为未写入。幂等键统一为 `origin`（§5.1），不再用裸 sourceUuid——裸 uuid 跨底座可碰撞。

### 3.2 SpillPolicy

```ts
interface SpillPolicy {
  evaluate(body: string): { spill: boolean; kept: string; ref?: string };
}
// 默认：正文 > 4K → 保留前 400 字符摘要 + origin 引用；blob 存 spills 或 ref 指向底座日志
// dsh 适配器：正文不复制（事件订阅，origin = dsh://session/event，spill 恒 false）
```

### 3.3 Retriever（引用回拉）

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

**已知缺口（2026-08-14 狗粮实测）**：`search` 仅语义检索，无结构化查询能力。纯 MCP 接入的 Agent（无源码目录后门）无法回答"抽查/审计"类精确时序问题——"今早 9 点后第一个问题"实测 `not-found`（无时间语义）；"某工具调用了几次"实测命中解释文档而非计数（答非所问）。

**设计方向（2026-08-14 用户定，接口内聚 + 主动提醒，非接口膨胀）**：不新增 `query_events` 等一堆接口——**模型不该被指望自觉识别查询类型**。应：① **查询接口内部做路由/处理逻辑**——单一 `search` 入口内识别查询意图（时序/计数/审计类 → 结构化执行路径：时间过滤/排序/计数聚合；语义类 → BM25 路径），对外保持一个接口；② **状态卡注入提醒驱动触发**——状态卡按上下文注入合适的检索提醒（何时可用/该走哪条路径），由提醒触发查询而非模型自己判断。回归场景：抽查类精确时序问题必须有服务层路径，禁止绕过直查库。

### 3.4 StateCardBuilder

```ts
interface StateCard {
  goals: Goal[];
  decisions: Decision[];        // active 优先，superseded 折叠
  feedback: FeedbackRow[];      // 最近 N 条
  recent?: SessionEvent[];      // 最近事件摘要
}
// build(): O(1) 查询（按 project_key + scope 合并，分层优先级 会话内>项目>用户>全局）
// 预算约束：≤200 行 / 单轮注入 token 预算（借鉴 CLAUDE.md 200 行 + workbuddy 分层裁决）
// 序列化：XML 标签包裹 + 分级格式（critical 区 JSON / context 键值 / recent 摘要），
//   预算分层 critical 60% / context 25% / recent 15%（默认可配）——见 business-design §2.3
// 注入隔离：内容 = 数据非指令（XML 区域 + JSON 转义 + 物理隔离），防存储型提示注入（business-design §2.3）
```

### 3.5 StateMachine

现有转换规则（`state.ts` assertTransition）不变，扩展目标表生命周期：goal `active → completed | dropped`；decision `proposed → active → superseded | revoked`；所有转换必须经断言。

### 3.6 Provider 抽象

```ts
interface KnowledgeProvider {
  save(entry: { text: string; scope: "global" | "project"; projectKey?: string }): Promise<void>;
  query(q: string, opts: { limit?: number }): Promise<Array<{ text: string; ref?: string }>>;
  delete(id: string): Promise<void>;
}
// 实现：marm / codebase-memory-mcp（MCP client）/ 本地 BM25 兜底（core 自带）
// CompactionSource：各底座压缩事件 → compact_checkpoint（Qoder 已有；dsh 订阅 session/event）
```
**集成层约束（2026-08-14 用户定）**：Provider 为**可选注入**（接口存在、缺省降级），非强依赖——core 不 import 第三方实现；发布物只含集成推荐清单（文档），不打包第三方代码；BM25 兜底常驻，provider 缺失走降级不报错。

### 3.7 StorageGovernor / Archiver / Rebuilder（接口预留，实现延后）

```ts
interface Archiver {
  archive(projectKey: string, beforeTs: string): Promise<{ moved: number; dbPath: string }>;
  // VACUUM INTO + 摘要级二级索引；B⑤ 实测膨胀率后定阈值，再实现
}
interface Rebuilder {
  rebuild(sessionId?: string): Promise<{ events: number; episodes: number }>;
  // 从事件流水重建派生层（FTS/情节/结构化表/血缘）——事件流水是唯一真相源
}
```

**事件溯源可重建性**：结构化表 / FTS 索引 / 情节 / 血缘 = 派生数据，`events` 流水 = 唯一真相源；崩溃、DB 损坏、迁移事故的恢复路径 = `Rebuilder.rebuild()`；恢复演练入回归集（B⑦）。

## 4. 不变量（代码级约束）

1. **写时即建索引**：append 事务内完成 FTS + 血缘，失败回滚；不存在"后补索引"路径。
2. **确定性**：核心路径零 LLM；旁路（light-confirm / 语义抽取）可失败可重试，绝不阻塞主路径。
3. **无损语义**：任何截断必须带 `truncated` + `origin`/`spill`，原文可回拉；"无损"= 可检索回拉，非全文复制两份。
4. **引用不可断裂**：lineage_edges / spills.event_id 必须指向存在的 id；适配器写入时校验，违规拒绝。
5. **状态机合法转换**：所有状态变更经 `assertTransition`。
6. **幂等**：capture 按事件 `origin`（底座前缀 + 事件 uuid）去重（现有 assistant 去重扩展至全 kind）。
7. **预算**：状态卡 ≤200 行；FTS 只索引 indexable kind（存储治理源头控制）。
8. **底座无关**：core 零底座 import；适配器只做三弱能力映射（hook 事件 / 上下文注入 / MCP）。
9. **迁移无损**：B④ 迁移后 count + 抽样 hash 校验，失败回滚。
10. **事件溯源可重建**：events 流水 = 唯一真相源；派生层（结构化表/FTS/情节/血缘）可从流水重建；禁止只改派生层不落流水。
11. **主动权在 Thread（2026-08-14 用户定，顶层原则）**：模型不可控，**不把希望放在模型上**——Thread 与模型的交互口越少越好，模型不需要理解记忆系统的结构；状态卡主动注入提醒触发查询（§3.3 设计方向），模型只需记住一条行为契约：**"需要啥就来问，别自己瞎猜"**。任何新能力先问"能否收进现有接口 / 能否由状态卡提醒驱动"，禁止靠暴露更多接口让模型自觉识别。
    - **边界声明（2026-08-14 评估补充）**：本原则**降低而非根除模型元认知依赖**——"需要啥就来问"仍要求模型先意识到自己不确定；无意识盲区（模型以为自己知道）由状态卡提醒兜底，兜不住时接受失败可见（not-found 契约 + 漏召回日志），不得假装兜底完美。
    - **提醒治理（2026-08-14 评估补充）**：接口少 ≠ 提醒少——提醒过频导致"狼来了"脱敏；提醒内容不得泄露记忆系统内部结构（只说"需要就说"，不说"有哪些查询路径"）。频度/内容走 B⑤ 度量（injection_follow_rate + 脱敏信号）。
    - **词汇边界（2026-08-14 grill 定案）**：状态卡 = 用户可理解的事实 + 低频冲突询问（如"项目已有决策：用 pnpm（来自其他会话）。本会话沿用还是改用？"），**永不出现 session/project/scope 等机制词汇**；机制词汇只出现在工具描述契约段（主通道）。后来者选择提醒仅在冲突发生时出现（低频，非每轮），面向用户意图而非机制。
    - **契约载体分层（2026-08-14 grill 定案，替代"适配器系统侧固定段落"）**：行为契约独立于状态卡（状态卡保持纯数据），走"最强且不可修改"通道，不依赖注入采纳度——① **主通道 = 工具描述内置**（`query_session_memory` / dsh `ctx.tools` 的 description 写死契约段：需要历史/不确定时调用、不编造、结果带引用；工具描述模型每轮可见、用户不可改、不进事件流水，跨底座一致）；② **增强 = dsh `agent/pre-step` 每步校验/重注入**（旗舰专属）；③ **系统侧注入段** = 适配器常量文本（尽力而为，Qoder 弱）；④ **状态卡提醒 = 兜底触发**（只说"需要就说"）。

## 5. 适配器契约

| 底座 | 采集 | 注入 | 查询 | 幂等键 |
|---|---|---|---|---|
| Qoder | UserPromptSubmit/PreToolUse/PostToolUse/Stop/PostCompact hooks | UserPromptSubmit → status-card（additionalContext） | MCP server query_session_memory | transcript 事件 uuid |
| dsh | session/event 订阅（零正文复制） | agent.inject()（进下一条被采纳请求） | ctx.tools 注册 query 工具 | session 事件 id |
| Claude Code | hooks（UserPromptSubmit/Stop/PreCompact） | hookSpecificOutput.additionalContext | MCP | 事件 uuid |
| Codex | hooks / rules | hooks / MCP 注入 | MCP | 事件 uuid |

dsh 原生接缝补充（v2 战略章节已述）：`agent/pre-step` 瀑布可改写/拒绝模型所见（完全接管通道）；`ctx.goals` 仅同会话，跨会话由 Thread 结构化表承担。

### 5.1 幂等与多写者（2026-08-14 定案）

- **幂等键 = origin**：`origin` 含底座前缀（`qoder://` / `dsh://` / `claude://` / `codex://` + 事件 uuid），跨底座天然唯一；多底座同项目并发写同一库不冲突。
- **同项目单库多写者**（替代"单底座主写"方案）：SQLite WAL + busy_timeout（现有）+ 写失败重试队列（capture 异步，失败入队重试，不阻塞）；并发写可靠性列入 dsh spike 验证项（同项目双写压力实测）。**spike ⑤ 实证（2026-08-14）：`busy_timeout` 不排队**——多进程并发写 WAL 时立即抛 `SQLITE_BUSY`（"database is locked"），重试循环（catch `e.code==='SQLITE_BUSY'` → sleep → 重试）是成功保证（8 写者 × 500 全成功、70 次重试、零丢失、integrity ok）；**capture 必须实现 SQLITE_BUSY 重试**（100ms 间隔、上限 ≥20 次，实测单写者最多 14 次），超限仍失败则入持久化重试队列（如 `pending` 表）不丢弃。
- **结构化表多写者语义（2026-08-14 grill 定案：先到先得 + 后来者选择 + 建立者专属，替代"确认晋升制"）**：
  - **先到先得**：决策/目标/反馈同域无对立时，第一次提出默认 `project` 级（成为项目共有，B③ 跨会话继承有内容）——不需用户显式确认即可建立项目共有层
  - **后来者选择**：写入时经冲突域检测（实体共享，见下）发现同域已有 project 级 active → Thread 状态卡提醒（"项目级：pnpm；可跟随或会话级覆盖"），不自动写入对立决策，等用户当前会话表态——**跟随**（不入库）或 **session 级覆盖**（落 `scope=session`，不动 project）
  - **建立者专属**：project 级只有 `origin` 建立者可发起修改（仍须用户确认）；其他会话只读（状态卡标注"只读，改需回建立会话或显式授权"）或 session 级覆盖
  - **冲突域 = 实体共享（图谱，MVP 确定性，迭代通道预留）**：决策写时确定性抽取实体（包名/文件/命令/函数）→ `decision_entities` 边；新决策实体集 ∩ project active 决策实体集 ≠ ∅ → 冲突提醒。纯对话决策（抽不到共享实体）退回 text 匹配 + 用户确认兜底；语义实体（抽象主题）列 B⑥ 旁路增强；会话决策 ↔ code-review-graph 代码实体贯通为远期通道。误报可接受（宁可多提醒，后来者选择成本低），误报率入 B⑤ 度量
- **子代理**：MVP 不采集子代理内部事件——子代理结论经主会话 tool_result 回流（现有链路已覆盖，轻确认旁路可提取候选决策）；主会话 → 子代理会话血缘关联为**可选边**（底座暴露时记录，低成本）；子代理深度跟踪（决策归属 / 独立状态卡）列入 B⑥ 后评估。

## 6. 验证体系代码级

- `packages/evals` runner：`runScenario(name, script)`——脚本构造真实会话事件流 → 跑断言；CLI 入口 `pnpm eval`。
- 回归场景清单 + 断言 + 判据（B⑦ 具体化）：
  - decision-chain：决策链跨事件保留 → 断言：压缩后 active 决策仍可检索，判据 = 保留率 ≥90%
  - repeat-question：已答信息不重复提问 → 断言：检索命中原文，判据 = 命中率 ≥90%
  - goal-retention：目标跨压缩留存 → 断言：checkpoint 后状态卡含原目标，判据 = 100%
  - compact-fidelity（B⑦ 新增）：压缩掉细节可回拉 → 断言：expand 返回原文，判据 = 回拉成功率 ≥95%
  - injection-follow：状态卡 active 决策被遵循 → 判据 = 遵循率 ≥80%（轻确认旁路 + 人工抽查采样）
  - scope-filter：非当前项目硬过滤 → 判据 = 零泄漏
  - migration-lossless：迁移后 count + 抽样 hash → 判据 = 零差异
  - rebuild-recovery：删除派生层后 rebuild 恢复 → 判据 = 与重建前一致
  - **对比基准（2026-08-14 grill 定案，纳入 B⑦，护城河叙事证据）**：固定 3 场景（decision-chain / repeat-question / goal-retention）跑"外部底座对照"——Claude Code 或 dsh 原生（无 Thread）基线，结果入 metrics 不阻塞 CI 主链（需真实底座环境，CI 跑不了，手动脚本）；产出 = "场景级保真度量无人区"的对比证据，非全量对比（只 3 场景锚点）
- 度量埋点：metrics 表（recall_miss / repeat_question / correction / storage_growth / injection_follow_rate）；B⑤ 埋点后由 evals 汇总输出。
- CI 门禁：`pnpm eval` 纳入提交前验证链（AGENTS.md：typecheck && lint && test）；回归失败阻塞合入。

## 7. 存储治理代码级

- 源头控制（内嵌 B②）：SpillPolicy 默认阈值 4K；FTS 分层（indexable 集合）；项目分库（project_key 隔离）。
- 冷热归档（延后）：Archiver 接口预留；B⑤ 实测膨胀率（metrics.storage_growth）后定阈值（天数/GB）与实现（VACUUM INTO + zstd + 摘要级二级索引，参考 dsh spill 与 session-search 帧级解码）。
- 无损语义约束下归档：归档只迁移"索引影子 + 摘要"，原文仍留在底座日志/归档库，`expand()` 对归档库只读回拉。
