# Thread 技术设计（v2 代码级设计与约束）

## 0. 文档关系

- [v1 设计](./session-memory-system-design.md)：需求与架构权威基线
- [v2 设计](./session-memory-system-design.md)：二期规划、底座战略、产品包络
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
  blob TEXT NOT NULL,          -- 截断掉的原文（或为空，ref 指向底座日志）
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
ALTER TABLE goals     ADD COLUMN scope TEXT DEFAULT 'project';
ALTER TABLE decisions ADD COLUMN scope TEXT DEFAULT 'project';
ALTER TABLE feedback  ADD COLUMN scope TEXT DEFAULT 'project';
```

### 2.3 索引分层

FTS5 只对 `indexable` 事件建索引。indexable 集合：`user_message`、`assistant_message`、`compact_checkpoint`、结构化表正文（目标/决策/反馈，以独立 FTS 或 events 派生）。`tool_call` / `tool_result` 大块**不建全文索引**，检索命中轻量事件后经 `origin`/`spill` 回拉原文。

### 2.4 迁移（B④）

迁移脚本对现网 `.thread/sms.db`：加列（默认值回填）+ 新建表；迁移后校验 = 行数对比 + 抽样 body sha256 对比，校验失败回滚（copy 备份）。

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
  origin?: string;          // 底座事件引用
  sourceUuid?: string;      // 幂等键（底座事件 uuid）
}
```

单事务内顺序：① 幂等检查（sourceUuid 已存在 → 返回已有，不重复落库）② 截断决策（`SpillPolicy.evaluate(body)`）③ 落 events ④ 若 spill：摘要入 body + spills 表写入 + `spilled=1` ⑤ FTS 分层索引（仅 indexable）⑥ 血缘边（file/tool 元数据，现有）⑦ 情节更新。任一步抛错 → 整体回滚，调用方视为未写入。

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

### 3.7 StorageGovernor / Archiver（接口预留，实现延后）

```ts
interface Archiver {
  archive(projectKey: string, beforeTs: string): Promise<{ moved: number; dbPath: string }>;
  // VACUUM INTO + 摘要级二级索引；B⑤ 实测膨胀率后定阈值，再实现
}
```

## 4. 不变量（代码级约束）

1. **写时即建索引**：append 事务内完成 FTS + 血缘，失败回滚；不存在"后补索引"路径。
2. **确定性**：核心路径零 LLM；旁路（light-confirm / 语义抽取）可失败可重试，绝不阻塞主路径。
3. **无损语义**：任何截断必须带 `truncated` + `origin`/`spill`，原文可回拉；"无损"= 可检索回拉，非全文复制两份。
4. **引用不可断裂**：lineage_edges / spills.event_id 必须指向存在的 id；适配器写入时校验，违规拒绝。
5. **状态机合法转换**：所有状态变更经 `assertTransition`。
6. **幂等**：capture 按底座事件 uuid 去重（现有 assistant 去重扩展至全 kind）。
7. **预算**：状态卡 ≤200 行；FTS 只索引 indexable kind（存储治理源头控制）。
8. **底座无关**：core 零底座 import；适配器只做三弱能力映射（hook 事件 / 上下文注入 / MCP）。
9. **迁移无损**：B④ 迁移后 count + 抽样 hash 校验，失败回滚。

## 5. 适配器契约

| 底座 | 采集 | 注入 | 查询 | 幂等键 |
|---|---|---|---|---|
| Qoder | UserPromptSubmit/PreToolUse/PostToolUse/Stop/PostCompact hooks | UserPromptSubmit → status-card（additionalContext） | MCP server query_session_memory | transcript 事件 uuid |
| dsh | session/event 订阅（零正文复制） | agent.inject()（进下一条被采纳请求） | ctx.tools 注册 query 工具 | session 事件 id |
| Claude Code | hooks（UserPromptSubmit/Stop/PreCompact） | hookSpecificOutput.additionalContext | MCP | 事件 uuid |
| Codex | hooks / rules | hooks / MCP 注入 | MCP | 事件 uuid |

dsh 原生接缝补充（v2 战略章节已述）：`agent/pre-step` 瀑布可改写/拒绝模型所见（完全接管通道）；`ctx.goals` 仅同会话，跨会话由 Thread 结构化表承担。

## 6. 验证体系代码级

- `packages/evals` runner：`runScenario(name, script)`——脚本构造真实会话事件流 → 跑断言（决策链保留 / 重复提问不重发 / 跨压缩保真 / goal 留存）。
- 回归场景清单：decision-chain、repeat-question、goal-retention、**compact-fidelity（跨压缩保真，B⑦ 新增）**、scope-filter、migration-lossless。
- 度量埋点：metrics 表（recall_miss / repeat_question / correction / storage_growth）；B⑤ 埋点后由 evals 汇总输出。

## 7. 存储治理代码级

- 源头控制（内嵌 B②）：SpillPolicy 默认阈值 4K；FTS 分层（indexable 集合）；项目分库（project_key 隔离）。
- 冷热归档（延后）：Archiver 接口预留；B⑤ 实测膨胀率（metrics.storage_growth）后定阈值（天数/GB）与实现（VACUUM INTO + zstd + 摘要级二级索引，参考 dsh spill 与 session-search 帧级解码）。
- 无损语义约束下归档：归档只迁移"索引影子 + 摘要"，原文仍留在底座日志/归档库，`expand()` 对归档库只读回拉。
