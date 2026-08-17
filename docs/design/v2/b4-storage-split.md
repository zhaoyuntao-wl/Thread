# 物理分库设计专篇：用户级结构化库 + 项目事件库

> 关联：v2 设计 §3 存储模型、technical-design §2 数据模型 v2。

## 1. 背景与动机

存储模型确定如下：结构化表进用户级单库 `~/.thread/structured.db`，事件流水进 `~/.thread/projects/<项目键>/events.db`。动机：

1. **防污染**：DB 文件不进用户项目目录（git/打包不受影响）。
2. **多项目形态**：global 级反馈/偏好跨项目共享（用户级库是天然归属）；事件按项目隔离（项目 A 的事件绝不出现于项目 B）。

物理分库取代单库逻辑隔离：单库方案以 `project_key` 列实现逻辑隔离（合并视图、硬过滤、状态卡合并），物理分库将两类数据落到独立库文件；迁移时一并回填历史结构化行 `project_key=NULL` 的归属。

## 2. 目标结构

```
~/.thread/structured.db                     用户级库（跨项目共享）
  goals / decisions / feedback / entities / decision_entities / metrics
  lineage_edges（结构化域边）                schema_version
~/.thread/projects/<项目键 hash>/events.db  项目库（按项目隔离）
  events / events_fts / episodes / spills
  lineage_edges（事件域边）                  schema_version
```

- **键的双重表示**：
  - `project_key` **列值** = 规范化路径（`deriveProjectKey(cwd)`，如 `d:/Agent-work/workspace/Thread`）——迁移回填必须沿用此格式，写 hash 会导致同项目分裂成两个键、合并视图/硬过滤失效。
  - 事件库**目录名** = `deriveProjectKeyHash(cwd)`（31 哈希 → base36，简短确定）——仅用于文件系统目录。
  - 覆盖关系：v2 主设计 §3 的"`~/.thread/projects/<规范化项目键>/events.db`"中"规范化项目键"即此目录名 hash，与列值（规范化路径）是同一键的两种表示，不可混用。
- 根目录：默认 `os.homedir()/.thread`；演练/测试用环境变量 `THREAD_ROOT` 覆盖（取代单库语义的 `THREAD_DB`）。
- 两库各自 `schema_version`，共用 `SCHEMA_VERSION = 2`，各自迁移链（ensureSchema 按库类型建表/迁移）。

## 3. 库与表归属

| 表 | 库 | 说明 |
|---|---|---|
| events / events_fts | 事件库 | FTS5 content='events' 必须在同库 |
| episodes | 事件库 | 情节按会话归属项目 |
| spills | 事件库 | event_id 引用 events.id |
| goals / decisions / feedback | 结构化库 | 行级 project_key/scope/origin |
| entities / decision_entities | 结构化库 | 冲突域图谱 |
| metrics | 结构化库 | event_id 引用事件库 events.id（无 DB 外键，应用层保证） |
| lineage_edges | **分库** | 事件域边 → 事件库；结构化域边 → 结构化库（见 §4） |
| schema_version | 两库各一 | 各自版本链 |

## 4. 血缘分库路由

**路由规则**：任一端 ∈ {goal, decision, feedback} → 结构化库；两端均 ∈ {event, file, tool} → 事件库。

| 边类型 | 示例 | 库 |
|---|---|---|
| event ↔ file / tool | touches_file / uses_tool | 事件库 |
| event ↔ event | 无（预留） | 事件库 |
| goal ↔ event | derived_from（goal 侧） | 结构化库 |
| decision ↔ event | derived_from（decision 侧） | 结构化库 |
| decision ↔ decision | supersedes | 结构化库 |

**跨库引用**（goal→event 的 derived_from，dst_id 指向事件库 events.id）：**不设 DB 外键**，应用层保证——写入时序为"事件先于结构化写"（applyAnalysis 先 append 事件再 addGoal/proposeDecision，sourceEvent 是刚插入的 event id）；不变量 #4（引用不可断裂）在写入层校验（校验事件存在）。

**查询路由**：`getRelatedEdges(sessionId, type, id)` 按 type 路由（event/file/tool → 事件库，goal/decision → 结构化库）；`getEventsForFile` 只查事件库；`getRelatedEvents`（type=event）只查事件库。结构化域边的 dst_id 可能指向事件库 events.id——查询侧如需按事件回查，由应用层跨库 join（当前无此查询路径，预留）。

## 5. ThreadStore 双库接口

```ts
interface ThreadStoreOptions {
  eventsPath: string;      // ~/.thread/projects/<hash>/events.db
  structuredPath: string;  // ~/.thread/structured.db
  projectKey?: string;     // append 事件行 project_key 列；缺省不写
}

class ThreadStore {
  readonly eventsDb: Database;      // 事件库连接（WAL + busy_timeout）
  readonly structuredDb: Database;  // 结构化库连接（WAL + busy_timeout）
  // 方法按表域路由（内部），公开 API 签名不变
}
```

- 单库构造 `{ path }` 已移除（不留兼容 shim）；所有调用方/测试使用双库构造。
- **跨库无原子事务**：append（事件）单库事务；applyAnalysis（结构化）单库事务。两步之间无原子性，由幂等兜底（origin 去重）。
- 方法域划分：
  - 事件库：append、expand、hasAssistantTurn、getRecentSessionId、search、getActiveEpisode、getLatestEpisodeWithSummary、getRecentEvents、getEventsForFile、getRelatedEvents
  - 结构化库：addGoal、getActiveGoals、updateGoalStatus、addFeedback、proposeDecision、confirmLatestProposed、revokeLatestActive、supersedeLatestActive、getActiveDecisions、getActiveDecisionsMerged、getActiveGoalsMerged、getFeedbackMerged、getLatestProposed、getDecisions
  - 路由：addLineageEdge 按 §4 路由；getRelatedEdges 按 type 路由；transact 保留（结构化库事务）
  - 注：expand（spill 回拉）实现于 store.ts（引用回拉基础版）；retrieve 模块的 origin → 底座日志回拉扩展为后续迭代项。

## 6. 路径解析与适配器

`packages/adapters/qoder-cli/src/index.ts`：`defaultDbPath` → `defaultPaths(fromUrl): { structuredDbPath, eventsDbPath }`。

```
root = process.env.THREAD_ROOT ?? join(os.homedir(), ".thread")
structuredDbPath = join(root, "structured.db")
eventsDbPath     = join(root, "projects", deriveProjectKeyHash(cwd), "events.db")  // cwd 从 hook 载荷取，缺省 process.cwd()
```

- capture.mjs / status-card.mjs / MCP server.ts 全部使用双库构造。
- `THREAD_DB` 环境变量废弃（e2e-capture 测试改用 THREAD_ROOT 指向临时根目录）。
- 脚本目录创建：capture 建两库父目录。

## 7. 迁移（逻辑入 core，脚本仅 CLI 包装）

**模块归属**：迁移核心逻辑在 `packages/core/src/migrate.ts`（纯函数、可被 core 测试 import）；CLI 包装脚本为本地运维工具（一次性迁移用途，不随公开仓库分发）。

**用法（core API）**：`import { migrateSplit, replayIncrement } from "@thread/core"`（脚本用法见 migrate.test.ts 用例）

**流程**（migrate.ts）：
1. 只读打开旧库；读全表数据。
2. 确定项目键：旧库 events 多数 project_key（列值 = 规范化路径，§2），空则 `deriveProjectKey(cwd)`。
3. **回填（前提：历史单库为单项目形态；NULL 行无法分辨项目归属，多项目历史库需人工指定键）**：
   - 事件行 `project_key=NULL` → 项目键（列值 = 规范化路径，**绝不写 hash**，见 §2）。
   - 结构化行 `project_key=NULL` 且 `scope='project'` → 沿 `source_event` 追溯事件行键，失败退化项目键。
   - `scope='global'` 行 project_key 留 NULL。
4. 建新库（§2 结构）；按表域复制；lineage_edges 按 §4 拆分。
5. **校验**：逐表 count 对比 + 抽样 50 行 body sha256 对比 + 双库 `PRAGMA integrity_check`；失败退出非零。
6. 非 dry-run：旧库 copy 为 `<old>.bak`；输出迁移报告（各表行数、回填数、校验结果）。

**写者暂停协议不适用**：原"禁止无暂停协议下在线迁移"针对**原地结构变更 + 并发写**的组合风险（SQLite DDL + 并发写）。本方案采用**复制式迁移**——旧库只读、不改旧库 DDL，新库独立写入，组合风险解除，故不需要写者暂停协议；capture 的 `thread_migrating` 暂停标志不用于本迁移（该机制如仍需要，仅用于 ensureSchema 类原地迁移）。

**零差异保证（增量重放）**：为满足 migration-lossless"零差异"验收，复制后执行增量补拉：
1. 快照时记录 `events.max(id)`（snapshot_id）。
2. 新库就绪、capture 切换后，从旧库读取 `id > snapshot_id` 的新事件（含新结构化行/血缘增量），按 origin 幂等重放至新库。
3. 重放完成后再跑一次 count + hash 校验，直至零差异（旧库不再写入时收敛）。
- 实现位置：`migrate.ts` 提供 `snapshotOld()` 与 `replayIncrement(oldDb, newStore)`；切换后由运维（或脚本 `--replay` 参数）触发补拉。
- 迁移窗口内旧库新增的事件通过重放补回，不丢失；窗口期间 capture 持续写旧库（未切换）或新库（已切换），幂等兜底防重复。

## 8. 验证

- 迁移测试（`packages/core/src/migrate.test.ts`）：临时旧单库（含 NULL project_key 行、事件/结构化行、跨域血缘边）→ 迁移 → 断言双库数据（count + 抽样 hash + 回填正确 + 血缘分库正确 + integrity_check）。
- 现有全部测试改双库构造后通过（typecheck / lint / test 全绿）。
- e2e-capture 测试：THREAD_DB → THREAD_ROOT。
- 手动演练：THREAD_ROOT 临时目录 + 旧库副本跑迁移（--dry-run → 实跑）→ 新库核对 → status-card/capture 双库验证。
- 真实迁移（备份确认）→ 新会话验证 hooks 写新库。
- 回归：migration-lossless（count + 抽样 hash 零差异）为长任务场景回归提供基础。

## 9. 风险与注意

- WAL 双库各自独立；跨库无原子事务（幂等兜底）。
- 跨库血缘引用无 DB 外键——写入时序保证 + 写入层校验（不变量 #4）。
- 迁移零差异由增量重放保证（§7）；复制式迁移不改旧库 DDL，写者暂停协议不再需要。
- `metrics.event_id` 跨库引用同处理（应用层保证，不设外键）。
- `project_key` 列值 = 规范化路径、目录名 = hash（§2），两者不可混用。
