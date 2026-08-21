# @thread/adapter-qoder-cli

## 0.1.3

### Patch Changes

- Updated dependencies
  - @thread-memory/core@1.0.2

## 0.1.2

### Patch Changes

- Updated dependencies
  - @thread-memory/core@1.0.1

## 0.1.1

### Patch Changes

- Updated dependencies [de482ab]
- Updated dependencies [94095a0]
- Updated dependencies [a7fa7e8]
- Updated dependencies [023b04e]
  - @thread-memory/core@1.0.0

## 0.1.0

### Minor Changes

- 80f86f8: add compact_checkpoint event kind; PostCompact hook payload ingested as lineage checkpoint (summary body + trigger/model meta)
- 7ade080: B② 作用域与命名空间：schema v2（events/goals/decisions/feedback 增 project_key/scope/origin 列；新增 spills/entities/decision_entities/metrics 表；幂等迁移 ensureSchema）；存储治理源头控制（SpillPolicy 4K 阈值、FTS 只索引 user/assistant/compact 三类、事件正文永不进全局库）；项目键推导（规范化 git 根，非 git 退化为 cwd）；结构化写路径支持 scope（session/project/global）+ project_key + origin（先到先得默认 project 级，origin 幂等跨会话去重）；作用域合并查询（当前会话 + 同项目 project 级 + global 级反馈，非当前项目硬过滤零泄漏）；检索接口内聚（queryEvents 结构化参数在单一工具内路由，不新增工具面）；引用回拉 expand（spill 原文恢复）；capture 多写者重试（SQLITE_BUSY 100ms 重试上限 20 次）；状态卡合并显示 + 预算分档（Qoder ≤100 行）+ 词汇边界（机制词汇不进状态卡）；回归集新增 scope-filter/幂等/spill 回拉场景（evals）。
- 9b0d6d3: B③ 跨会话自动继承（轻量版）：合并视图新增分层优先级裁决 `applyScopePriority`——同事实（归一化 text）跨层级出现时保留最高优先级（会话内 > 项目 > 全局），项目特例覆盖全局默认；状态卡继承展示接入裁决（同项目历史会话 active 决策 / 全局反馈开场即见，机制词汇不进状态卡）；回归集新增跨会话继承场景（新会话继承旧会话决策与反馈、优先级去重、默认 project 级成为后续会话继承源）。
- 28fbcf5: B④ 物理分库：用户级结构化库 + 项目事件库。schema 拆分（EVENTS_SCHEMA/STRUCTURED_SCHEMA，两库独立 schema_version/迁移链）；ThreadStore 双库构造（eventsPath/structuredPath/projectKey，方法按表域路由）；血缘分库路由（任一端 ∈ {goal,decision,feedback} → 结构化库，两端均 ∈ {event,file,tool} → 事件库，跨库引用无外键由写入时序保证）；THREAD_ROOT 取代 THREAD_DB；capture 双库写入 + compact_checkpoint body+ts 哈希 origin 兜底；迁移核心 migrate.ts（复制式迁移：旧库只读、project_key 回填、按域拆分、count+抽样 sha256+integrity 校验、增量重放 replayIncrement 零差异）+ scripts/migrate-split.mjs CLI 包装（--dry-run/--replay）；旧库备份 .bak-b4；设计专篇 docs/design/v2/b4-storage-split.md。
- f4a79fb: B⑧ 迭代三项（开放项 ⑦⑧⑨）：① 隔离指令判定收紧——由"任意位置含隔离/静默等词即触发"改为整条消息 trim 后精确匹配白名单（隔离：/isolate、隔离、开始隔离、进入隔离、临时隔离、静默、免打扰、别打扰；解除：/unisolate、解除隔离、退出隔离、恢复共享；沉淀：/thread-publish <kind> <id> 或自然语言整句），讨论性语句（如"隔离的判定规则是什么"）不再误触发，附回归单测；② 单命令行为契约——状态卡底部新增静态指示行"收到 隔离//unisolate//thread-publish 单命令时，只回一句状态确认，不展开思考"；③ query 工具隔离可观测——queryEvents 事件行输出补 `isolation` 字段，MCP 响应信封带 `session_isolation` 当前状态（消灭验证时直查生产库）。
- 2038b18: 外部借鉴 dsh-routing-suite（2026-08-15）：① 状态卡首轮加权——会话首请求即锚定轨迹（其 paper 路径承诺实证），`buildStatusCard` 新增 `firstTurn` 档（目标/决策 8 条、recent 5 条），dsh pre-step turn===1 传递，首轮给全量锚点、后续维持轻量 O(1)；② 工具契约段补 few-shot 示例（weak 窗口区分度实证）——两个 MCP server 的 `TOOL_DESCRIPTION` 加 1 条调用示例；③ 收束语绑定行动——状态卡尾行改为"查询并基于结果给出结论"，防纯开放引导（其 deep-think 0% 收敛实证）；④ 注入安全原则写入 technical-design 不变量 #11——注入一律追加 user message，禁止改写/替换底座 section（router amnesia 教训）。附 status-card.test 4 例。
- 84cdfdc: dsh 狗粮切换（2026-08-14）：路径解析与状态卡构建抽 core 复用（`defaultPaths`/`threadRoot`/`buildStatusCard`，qoder 与 dsh 共用防漂移）；新增 `@thread/adapter-dsh` 旗舰插件——订阅 `session/event` 采集（user/assistant/tool 四类事件写双库，SQLITE_BUSY 重试，自身注入过滤防自循环）+ `agent/pre-step` 每轮注入状态卡（预算 ≤200 行，词法边界）；headless profile 挂载（bundle + MCP overlay 持久化，手工复制 dist 到 profile node_modules，pnpm 跨盘 file/link 已知坑）；端到端验证通过（采集入库/注入入会话/`mcp__thread__query_session_memory` 查询可用），回归链全绿。
- 3df50fb: 结构化行治理可见性（B⑥-② 恢复通道配套 ①②）：① 状态卡目标/决策/偏好行尾显示行 id（`#12`）——写入即见、每轮常驻，`/feedback-del` `/thread-publish` 可定位；② MCP `query_session_memory` 的 `kind` 扩展 `goal/decision/feedback`，路由到新增 `queryStructured`（结构化表直查，隔离语义与事件一致）——忘掉 id 后的后置查询入口。附单测 5 例（queryStructured 3 + 行 id 1 + 恢复通道既有）。
- 51b1e5c: 接通生产链路：capture 内联确定性轻确认（applyAnalysis），用户消息/Agent 回复写入目标/决策/反馈表；Agent 回复正文从 transcript 尾部提取并按 uuid 去重。

  core 修复：append 事务化（seq 原子分配）；决策状态机去掉未使用的 confirmed 态（MVP 确认与生效合并，设计文档已同步）；情节闭合时写入确定性摘要，检索降级链 degraded 可达；轻确认正则防误判（"我不确定…"不再提议决策），偏好与决策动作可同条消息并存；目标正则收紧避免问句误入目标表；meta 截断返回一致性。

  adapter 修复：file_path 相对 cwd 归一化；路径推导改为向上查找 .git（server/scripts 共用）；MCP server 复用 THREAD_VERSION；status-card 异常防护（失败降级最小卡，绝不阻塞）、目标倒序展示、移除调试日志。

  测试：adapter ingest 单测（payload 形状/路径归一化/transcript 提取）、core 误判与分支回归、情节摘要与 degraded 降级、capture.mjs 端到端回归（spawn + THREAD_DB 临时库）。

### Patch Changes

- 74a5a5e: A3 历史回填：新增 scripts/backfill-origin.mjs 为存量 origin IS NULL 事件补齐幂等键（规则与 capture.mjs 一致：tool_call 哈希兜底、tool_result 用 tool_use_id、消息/压缩摘要 body+ts 哈希）；已对生产库执行回填 2541 条，NULL 归零、零重复、integrity ok。
- 51b1e5c: 修复 thread-sms MCP server 的数据库路径解析：从 dist 目录到仓库根需要 5 层 dirname，原实现少了两层，启动时直接崩溃（Cannot open database because the directory does not exist）。
- 9e1a1b6: 修复 tool_call 事件 origin 缺失：PreToolUse 解析补传 `tool_use_id`，capture 侧 tool_call 使用独立前缀 `qoder://toolcall#`（与 tool_result 共用 tool_use_id 前缀会触发 append 全局 origin 去重、互相覆盖），无 tool_use_id 时哈希兜底；回归：重复 capture 同一 tool_call 只落库一条。
- Updated dependencies [80f86f8]
- Updated dependencies [7ade080]
- Updated dependencies [9b0d6d3]
- Updated dependencies [28fbcf5]
- Updated dependencies [3e254f0]
- Updated dependencies [21de7c0]
- Updated dependencies [f4a79fb]
- Updated dependencies [2038b18]
- Updated dependencies [84cdfdc]
- Updated dependencies [84cdfdc]
- Updated dependencies [e0439f4]
- Updated dependencies [b7a6e70]
- Updated dependencies [8d9b454]
- Updated dependencies [e92bb10]
- Updated dependencies [3df50fb]
- Updated dependencies [51b1e5c]
  - @thread-memory/core@0.1.0
