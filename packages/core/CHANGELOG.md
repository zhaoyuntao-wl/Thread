# @thread-memory/core

## 1.0.2

### Patch Changes

- 发布卫生（构建层修复）：build 改用 tsconfig.build.json 排除测试产物（1.0.1 的 .npmignore 方案无效，1.0.2 起 dist 不含任何 _.test._）

## 1.0.1

### Patch Changes

- 发布卫生：dist 排除测试产物（1.0.0 包内曾混入 54 个 `*.test.*` 文件）

## 1.0.0

### Major Changes

- 94095a0: 决策/偏好结构通道化 + 目标判定粘贴守卫 + 资源治理 API（2026-08-21 碎片误报治理，发布前定案）

  - **停用决策/偏好自然语言判定**：USER_DECLARE_RE / DECLARE_RE / PREFERENCE_RE / SUPERSEDE_RE / REVOKE_RE / ACCEPT 全部移除——无锚定正则对粘贴/回显文本零防御（生产实证：9 条候选 5 条碎片误报）。决策与偏好只走显式通道（命令/模型工具），文本启发式误报归零
  - **目标判定保留 + 粘贴守卫**：GOAL_RE（句首祈使动词）保留；新增多行（含换行）与 >200 字符守卫——md 提示词粘贴/附件内联/文件直读均不误判（生产实证：真实目标单行 ≤~105 字符，误报目标为多行粘贴转写）
  - **显式决策通道 store API**：addDecision（命令/工具创建直接 active）/ promoteCandidate（候选转正，可带修正文本；修旧 confirm 只翻候选状态不落 decisions 行的死路）/ deleteDecision（硬删除 + 血缘边清理，事件流水保留原文）/ supersedeDecisionById（按 id 取代，replacement 继承项目/scope/隔离字段）；移除 confirmLatestProposed / revokeLatestActive / supersedeLatestActive / getLatestProposed 旧 latest 系 API
  - **资源治理 API（命令重构配套）**：deleteAsset（产出解除登记 + 双库血缘边清理）/ getGoals（全状态目标列表）/ listIsolatedRows 扩展 ast 产出 / unisolateRow 覆盖 knowledge_assets
  - **产出登记路径幂等 + 隐藏目录排除（2026-08-21 狗粮实证：thread-reg ast 重复与 changeset 噪音）**：registerAsset 同 path 可见范围内去重（只刷新标题，不再堆行——生产 README 同 path 12 行）；classifyWriteEvent 不识别隐藏目录（.changeset 等）下的 md
  - **完成判定窗口分级（2026-08-21 狗粮误报修复）**：英文 4 字符窗口可碰撞（北极星"Thread"被消息"thread-reg"命中"read"误 completed）→ 含非 ASCII 窗口 ≥4、纯 ASCII 窗口 ≥8 连字符；归一化去空白
  - 完成判定（短消息守卫 >100 字符）保持不变；事件流水无损 = 未显式记录内容仍可回拉（下限不丢）
  - 验证链：core 204 单测 + eval 15/15（decision-chain/isolation/rebuild 场景改走显式通道断言）

### Minor Changes

- de482ab: 检索质量升级：FTS5 中文分词（0-e 定案落地，development-priority 项 14）

  - **jieba 预分词 shadow 列**：events_fts 重建为 contentless `body_seg` 列（`@node-rs/jieba` 2.x `Jieba.withDict`，napi-rs 预编译无 build script），写时同步分词索引
  - **查询侧对称分词 + 全 OR**：替代原单字 AND（"登录方案" → `"登" AND "录" AND "方" AND "案"` 缺一字即 miss）；查询词 jieba 分词 + 停用词过滤 + 全 OR，召回精度交给 BM25
  - **BM25 时间衰减**：排序 `score ASC, ts DESC`（同分近期优先；深调留 B⑤ 度量）
  - **降级容错**：jieba 加载失败（平台无预编译二进制）→ 回退单字空格，检索降级不阻塞主路径
  - **SCHEMA_VERSION 4 → 5**：v4 FTS 表（body 单字）自动重建为 body_seg 并回填历史（幂等，origin 无关）
  - 新依赖：`@node-rs/jieba@^2.0.2`（含 win32/darwin/linux 预编译 optionalDependencies）
  - 测试 +12（segment 5 + 中文检索回归 4 + FTS 迁移 1 + 版本断言更新 2），eval 10/10 保持全绿

- a7fa7e8: 情境化记忆传达（§1.5 P0 情境 C+A + 机制 3 决策变更）：buildStatusCard 升级为情境路由器

  - 新增 `situation` 参数（normal/new-session/post-compact/decision-change）与 `detectSituation` 程序判定
  - 情境 A 新会话续接：首轮有历史 → 追加"会话接续块"（沿用目标/决策），用户无需显式提醒
  - 情境 C 压缩边界回归：最近事件含 compact_checkpoint → 追加"压缩回归块"（目标重述）
  - 情境 decision-change（§1.5.3c 机制 3）：项目最近决策 updated_at 晚于本会话最新事件 → 追加"最近决策块"（防模型基于旧状态行动，2026-08-18 误判复盘驱动）
  - 新增 `getRecentDecisionsMerged`（项目级最近决策，按 updated_at 倒序）
  - normal 情境不追加传达块（避免每轮塞指令）；隔离模式下不继承
  - 单测 +11（detectSituation 5 + 传达块 6）

- 023b04e: 检索质量补强：trigram 子串召回兜底（0-e 定案第 5 条落地，SCHEMA_VERSION 6）

  - 新增 `events_fts_tri` 独立 trigram FTS 表：主路径（jieba 词级 BM25）0 命中时，"用户只记得半句"（查询是正文 token 的连续子串）由 trigram 短语匹配兜底召回
  - 兜底表用纯时间衰减排序（trigram 打分区分度差），隔离/会话过滤语义与主路径一致
  - **实现修正（2026-08-18）**：初版尝试单表双列（body_seg + body_tri tokenize='trigram'）失败——better-sqlite3 内置 SQLite 3.53.2 不支持 FTS5 列级 tokenizer 覆盖（parse error），改为双表（主表 unicode61 + 独立 trigram 表），语义等价
  - 迁移：SCHEMA_VERSION 4→5→6 自动重建回填（按兜底表数据量判断，v5 库升级触发）
  - 测试 +4（v6 迁移、半句子串兜底、隔离语义、<3 字符边界）；query 降级路径测试适配新语义（trigram 优先于降级摘要）

## 0.1.0

### Minor Changes

- 80f86f8: add compact_checkpoint event kind; PostCompact hook payload ingested as lineage checkpoint (summary body + trigger/model meta)
- 7ade080: B② 作用域与命名空间：schema v2（events/goals/decisions/feedback 增 project_key/scope/origin 列；新增 spills/entities/decision_entities/metrics 表；幂等迁移 ensureSchema）；存储治理源头控制（SpillPolicy 4K 阈值、FTS 只索引 user/assistant/compact 三类、事件正文永不进全局库）；项目键推导（规范化 git 根，非 git 退化为 cwd）；结构化写路径支持 scope（session/project/global）+ project_key + origin（先到先得默认 project 级，origin 幂等跨会话去重）；作用域合并查询（当前会话 + 同项目 project 级 + global 级反馈，非当前项目硬过滤零泄漏）；检索接口内聚（queryEvents 结构化参数在单一工具内路由，不新增工具面）；引用回拉 expand（spill 原文恢复）；capture 多写者重试（SQLITE_BUSY 100ms 重试上限 20 次）；状态卡合并显示 + 预算分档（Qoder ≤100 行）+ 词汇边界（机制词汇不进状态卡）；回归集新增 scope-filter/幂等/spill 回拉场景（evals）。
- 9b0d6d3: B③ 跨会话自动继承（轻量版）：合并视图新增分层优先级裁决 `applyScopePriority`——同事实（归一化 text）跨层级出现时保留最高优先级（会话内 > 项目 > 全局），项目特例覆盖全局默认；状态卡继承展示接入裁决（同项目历史会话 active 决策 / 全局反馈开场即见，机制词汇不进状态卡）；回归集新增跨会话继承场景（新会话继承旧会话决策与反馈、优先级去重、默认 project 级成为后续会话继承源）。
- 28fbcf5: B④ 物理分库：用户级结构化库 + 项目事件库。schema 拆分（EVENTS_SCHEMA/STRUCTURED_SCHEMA，两库独立 schema_version/迁移链）；ThreadStore 双库构造（eventsPath/structuredPath/projectKey，方法按表域路由）；血缘分库路由（任一端 ∈ {goal,decision,feedback} → 结构化库，两端均 ∈ {event,file,tool} → 事件库，跨库引用无外键由写入时序保证）；THREAD_ROOT 取代 THREAD_DB；capture 双库写入 + compact_checkpoint body+ts 哈希 origin 兜底；迁移核心 migrate.ts（复制式迁移：旧库只读、project_key 回填、按域拆分、count+抽样 sha256+integrity 校验、增量重放 replayIncrement 零差异）+ scripts/migrate-split.mjs CLI 包装（--dry-run/--replay）；旧库备份 .bak-b4；设计专篇 docs/design/v2/b4-storage-split.md。
- 3e254f0: B⑥-② 反馈拦截（教训从提示升级为强制）：core 新增确定性匹配 `matchToolFeedback`/`extractBlockedTokens`——反馈行（correction/preference，合并视图）中提取"不要/别/禁止/never/don't use/avoid"后的目标工具名 token，与待执行工具名 case-insensitive 匹配，命中即拒绝并附教训原文。dsh 侧挂 `tools.guard()`（tools/pre-execute 后同步守卫，返回字符串即 deny）；Qoder 侧新增 `scripts/tool-guard.mjs`（PreToolUse 同步 hook，命中 exit 2 + stderr 教训原文）。同步修正 `scripts/capture.mjs` 隔离指令白名单（⑦ 对齐 dsh 侧）。附 9 例单测。
- 21de7c0: B⑥-② 反馈恢复通道（治理缺口补）：`ThreadStore.deleteFeedback(id)`（事件流水保留，真相源不变）+ `/feedback-del <id>` 命令（dsh 插件与 Qoder capture 双端解析执行）——教训可删即恢复，B⑥-② 拦截测试从此可逆。附单测（命令解析 + 删除后守卫不再命中）。
- f4a79fb: B⑧ 迭代三项（开放项 ⑦⑧⑨）：① 隔离指令判定收紧——由"任意位置含隔离/静默等词即触发"改为整条消息 trim 后精确匹配白名单（隔离：/isolate、隔离、开始隔离、进入隔离、临时隔离、静默、免打扰、别打扰；解除：/unisolate、解除隔离、退出隔离、恢复共享；沉淀：/thread-publish <kind> <id> 或自然语言整句），讨论性语句（如"隔离的判定规则是什么"）不再误触发，附回归单测；② 单命令行为契约——状态卡底部新增静态指示行"收到 隔离//unisolate//thread-publish 单命令时，只回一句状态确认，不展开思考"；③ query 工具隔离可观测——queryEvents 事件行输出补 `isolation` 字段，MCP 响应信封带 `session_isolation` 当前状态（消灭验证时直查生产库）。
- 2038b18: 外部借鉴 dsh-routing-suite（2026-08-15）：① 状态卡首轮加权——会话首请求即锚定轨迹（其 paper 路径承诺实证），`buildStatusCard` 新增 `firstTurn` 档（目标/决策 8 条、recent 5 条），dsh pre-step turn===1 传递，首轮给全量锚点、后续维持轻量 O(1)；② 工具契约段补 few-shot 示例（weak 窗口区分度实证）——两个 MCP server 的 `TOOL_DESCRIPTION` 加 1 条调用示例；③ 收束语绑定行动——状态卡尾行改为"查询并基于结果给出结论"，防纯开放引导（其 deep-think 0% 收敛实证）；④ 注入安全原则写入 technical-design 不变量 #11——注入一律追加 user message，禁止改写/替换底座 section（router amnesia 教训）。附 status-card.test 4 例。
- 84cdfdc: dsh 狗粮切换（2026-08-14）：路径解析与状态卡构建抽 core 复用（`defaultPaths`/`threadRoot`/`buildStatusCard`，qoder 与 dsh 共用防漂移）；新增 `@thread/adapter-dsh` 旗舰插件——订阅 `session/event` 采集（user/assistant/tool 四类事件写双库，SQLITE_BUSY 重试，自身注入过滤防自循环）+ `agent/pre-step` 每轮注入状态卡（预算 ≤200 行，词法边界）；headless profile 挂载（bundle + MCP overlay 持久化，手工复制 dist 到 profile node_modules，pnpm 跨盘 file/link 已知坑）；端到端验证通过（采集入库/注入入会话/`mcp__thread__query_session_memory` 查询可用），回归链全绿。
- 84cdfdc: 新增 `eventKindCounts(db)`：按 kind 统计 events 表中的事件计数（如 `{ user_message: 3, tool_call: 5 }`），供事件分布统计/审计路径使用。
- 8d9b454: 仓库分仓（2026-08-18）：dsh-thread 迁出为独立仓库 dsh-plugin-thread（私有，稳定后公开）。

  - 本仓库 = 通用内核（core）+ 薄适配器（qoder-cli）+ 回归集（evals）
  - 移除 packages/adapters/dsh 及 CI compat-dsh job（迁移至独立仓库 CI）
  - 清理 changeset 中 dsh-thread 引用（发布面收窄为 @thread-memory/core + @thread/adapter-qoder-cli）
  - 文档同步：AGENTS.md / CONTRIBUTING / MAINTAINING / README / 设计文档 v1+v2 修订记录
  - dsh-thread 开发期依赖 core 走 file: link，core 稳定后切 npm 版本

- e92bb10: 会话临时隔离（B⑧）：会话内可变开关（自然语言"隔离/静默/解除隔离" + `/isolate` `/unisolate` `/thread-publish <kind> <id>` 命令）——对话上下文（消息/决策/反馈）全链路仅自己可见（合并视图 / search / queryEvents / expand / 血缘过滤），项目事实（tool 事件）共享不断链；解除后历史仍隔离、按需沉淀转共享。core schema v3（isolation 列 + session_isolation 表）；dsh-thread 与 Qoder hooks 双端接入；evals 新增 isolation 场景（门禁 10/10）。
- 3df50fb: 结构化行治理可见性（B⑥-② 恢复通道配套 ①②）：① 状态卡目标/决策/偏好行尾显示行 id（`#12`）——写入即见、每轮常驻，`/feedback-del` `/thread-publish` 可定位；② MCP `query_session_memory` 的 `kind` 扩展 `goal/decision/feedback`，路由到新增 `queryStructured`（结构化表直查，隔离语义与事件一致）——忘掉 id 后的后置查询入口。附单测 5 例（queryStructured 3 + 行 id 1 + 恢复通道既有）。
- 51b1e5c: 接通生产链路：capture 内联确定性轻确认（applyAnalysis），用户消息/Agent 回复写入目标/决策/反馈表；Agent 回复正文从 transcript 尾部提取并按 uuid 去重。

  core 修复：append 事务化（seq 原子分配）；决策状态机去掉未使用的 confirmed 态（MVP 确认与生效合并，设计文档已同步）；情节闭合时写入确定性摘要，检索降级链 degraded 可达；轻确认正则防误判（"我不确定…"不再提议决策），偏好与决策动作可同条消息并存；目标正则收紧避免问句误入目标表；meta 截断返回一致性。

  adapter 修复：file_path 相对 cwd 归一化；路径推导改为向上查找 .git（server/scripts 共用）；MCP server 复用 THREAD_VERSION；status-card 异常防护（失败降级最小卡，绝不阻塞）、目标倒序展示、移除调试日志。

  测试：adapter ingest 单测（payload 形状/路径归一化/transcript 提取）、core 误判与分支回归、情节摘要与 degraded 降级、capture.mjs 端到端回归（spawn + THREAD_DB 临时库）。

### Patch Changes

- e0439f4: 修复轻确认决策提议误判（第二批，狗粮实测）：裸"决定/确定"必须带第一人称主语（我/我们）才视为决策声明——"产出直接决定 X""调研结论确定 X"这类陈述句不再误提议；"决定采用/方案定为/就采用"等固定模板保持免主语。回归测试覆盖新误判原句与正向声明。
- b7a6e70: 修复轻确认决策提议误判（狗粮实测）：排除技术词"确定性/决定性"、疑问句式（"怎么/如何确定"等，"确定/决定"前接疑问/否定词不匹配），以及以"吗/呢/吧"结尾的征询句（如"要我记下这个决策吗？"）。此前这类句子会被误提议为决策，并被后续"可以/同意"误确认；回归测试覆盖真实生产误判原句。
