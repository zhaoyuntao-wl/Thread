# 会话管理系统设计文档 v2（Session Memory System）

> 日期：2026-08-13 ｜ 状态：**规划中，批 B 主体已实现（B②~B⑧ 落地，2026-08-15）**——v1 基线（需求/架构/已实现部分）见 [v1 文档](../v1/session-memory-system-design.md)；本文件承载二期规划、开放问题与已确认的二期设计，实现前仍需在 v1 与本文档间保持一致，改动架构/接口时先改对应版本设计文档再改代码。

---

## Thread 价值主张（对外公告与佐证）

> 开源仓库对外公告的核心声明清单；每条声明对应**可复现的佐证**（回归场景 / 实机记录 / 工具输出）。公告时声明与佐证必须成对出现。

| # | 声明（解决的问题） | 机制 | 佐证方式 |
|---|---|---|---|
| 1 | **决策不丢**：长任务中所有决策（含被撤销/替代）无损留存、演化可回溯 | 事件流水无损落库 + 决策状态机（active/superseded）+ 写时建索引 | 回归集 decision-chain（JWT→Session 撤销链断言）+ 血缘查询 |
| 2 | **目标不漂移**：上下文压缩/新会话后关键目标仍常驻 | 状态卡每轮注入（O(1)）+ 压缩边界 checkpoint + 压缩后状态卡自动回归 | 2026-08-14 实机（3 次 /compact：状态卡下一轮回归、摘要全文可检索） |
| 3 | **不重复提问**：已答信息按需召回 | FTS5 BM25 检索 + MCP query 工具 | 回归集 repeat-question、goal-retention 场景 |
| 4 | **压缩无损失**：压缩掉的细节可找回 | compact_checkpoint 事件（摘要全文入流水）+ 事件流水全量留存 | sms.db 实测（checkpoint id 854、trigger=manual） |
| 5 | **上下文有界**：长会话上下文规模可控、可量化 | 压缩边界挂钩 + 每轮上下文曲线重建 | scripts/eval-ctx.mjs 实测（sawtooth：峰值 248,927 ≤ 锚点 249,541、谷值 ≤4,785） |
| 6 | **底座无关**：三弱能力即可接入 | 适配器层（hook 事件 / 上下文注入 / MCP） | Qoder 适配器现网狗粮 + Claude Code hooks 同构分析（待移植验证） |
| 7 | **成本节省**：长会话上下文不再随历史线性膨胀，同任务总 token 下降（目标架构） | 每轮上下文 = 状态卡 + 按需检索片段，替代全量历史重放 | eval-compare.mjs 同任务前后 N 次中位数对比（待数据积累）。**成立条件（备注）**：① 检索频次受控时节省成立，高频检索会侵蚀节省；② 薄适配模式下状态卡本身是净增（每轮几百 token），但 Thread 兜底压缩失真后，用户可**放心调低压缩阈值**（contextWindow / 更频繁压缩）换来每轮输入 token 下降——净效果取决于阈值调低幅度，可能反超状态卡开销，**不预设结论，以度量为准**；③ 完全接管形态（`dsh-thread-max`，规划，替代原 t-dsh）下节省直接兑现 |

---

## 路线图（批次计划，2026-08-13 确认）

批次按依赖排序：**A（前置调研）→ B（记忆层能力）→ C（智能增强）**，里程碑 + 验收标准粒度，不排具体日期。

### 批 A：前置调研（约 0.5~1 天，**已完成 2026-08-14**，结论见 §2）

- 底座侧上下文裁剪能力调研：Qoder CLI 的 auto-compact 行为、能否触发/控制、历史截断 / resume 能力 → 已决：PreCompact/PostCompact hooks 可用，底座可控路径成立
- 本地旁路模型选型（桌面调研）：轻确认分类器、语义抽取小 LLM、embedding、reranker 的具体模型 + 内存/延迟预算 → 已决：选型表见 §2（实测下载放批 C 前）
- 验收：§2 两条开放问题从"待定"变为"已决" ✅

### 批 B：记忆层能力（约 3~5 天）

> 编号已重排（见「产品包络定稿」章节批 B 重排）：原 2~6 项 + 新增 B⑦ 场景级保真回归集；存储治理源头控制内嵌 B②；原第 1 项"上下文裁剪接入（O(1)）"已在批 A 落地（见下）。下列各条按重排后顺序推进。

0. **上下文裁剪接入（O(1) 落地，批 A 内完成，不再单独占项）**：方案已由批 A 定案（底座可控路径成立）——实现 = 挂 PreCompact/PostCompact hook：PreCompact 时状态卡落库防丢，PostCompact 后经 hookSpecificOutput 重新注入状态卡，细节靠检索拉回；辅以 `model.maxSessionTurns` / `contextWindow` 阈值定制。验收：① 长会话实测 ctx 有界——每轮上下文长度序列从 transcript 条目 + `compact_boundary` 的 compactMetadata 锚点重建（底座不落 per-turn usage，实测确认），确定性可量化；② 成本对比（**2026-08-14 grill 定案：推迟到 B⑥ 后**）——依赖"用户调低压缩阈值"前提，前提未就绪时跑对比会得出误导性负结论；批 B 0 只建基线曲线，同任务前后 N 次总 token 对比移到 B⑥ 压力导航上线后（见下验收②）
   - **spike 实测 + 实机验证（2026-08-14，本机 `/compact`）**：PreCompact 载荷 = session_id/transcript_path/cwd/hook_event_name/model/trigger/custom_instructions（无摘要）；PostCompact 载荷 = 同上 + `compact_summary`（替换历史的摘要全文）、`trigger` ∈ manual/auto。**接线已落地**：① PostCompact → 新增 `compact_checkpoint` 事件入流水（body=摘要全文，meta=trigger/model）——摘要即压缩边界血缘标记，可检索（实机落库验证通过，trigger=manual）；② PreCompact 不需接线——事件流水已持续采集（UserPromptSubmit/PreToolUse/PostToolUse/Stop 全挂 capture），DB 先于压缩已是最新。**实机结论**：PostCompact 的 hookSpecificOutput 状态卡注入不被底座采纳（压缩边界后无状态卡），该接线已移除；PreCompact 同结论（批 B 第 6 项 ① spike，2026-08-14 实测）；状态卡回归由 UserPromptSubmit 每轮注入保证（手动压缩后下一条用户消息即恢复），auto-compact 续写首轮由压缩摘要的 Primary Request 段兜底——目标不漂移保障成立
   - **验收①（2026-08-14 落地）**：已建 `scripts/eval-ctx.mjs`（transcript 字符窗口 + 分段锚点校准重建每轮上下文曲线）与 `scripts/eval-compare.mjs`（同任务前后各 N 次取中位数对比）。本会话实测：3 次压缩锚点 249541→4785 / 74047→3673 / 63797→3614（降幅 94~98%），每轮上下文估算峰值 248927 ≤ 锚点峰值 249541，sawtooth 成立、谷值 ≤4785 → **ctx 有界 ✅**；auto-compact 未触发（阈值未配），其有界性待阈值配置后补测。**验收②（2026-08-14 grill 定案：降级为"基线建立"，成本结论推迟到 B⑥ 后）**：成本节省依赖"用户调低压缩阈值"前提，而引导该动作的压力导航在 B⑥——在前提未就绪时跑对比会得出误导性负结论（状态卡净增 + 阈值未调）。故批 B 0 只建立基线曲线（harness 就绪），同任务前后 N 次总 token 对比移到 B⑥ 压力导航上线后执行；价值主张 #7 措辞保持"不预设结论，以度量为准"
1. **B② 作用域与命名空间全量落地**（含存储治理源头控制内嵌）：用户级结构化库 + 按项目键分事件库、项目键推导、查询合并（project+global）、状态卡合并显示、非当前项目硬过滤
2. **B③ 跨会话自动继承（轻量版）**：新会话开场注入上一项目会话的 active 决策 / 全局反馈（最近 N 条），复杂跨会话检索策略等线上度量数据后再调
3. **B④ 现网串库修复 + 一次性迁移脚本**（现网 `.thread/sms.db` → 新结构，数据无损）——**狗粮实证（2026-08-14，B②-5）**：B② 上线前的旧结构化行 `project_key` 为 NULL（写路径当时未带键），跨会话合并视图不认领这些行（仅本会话可见）；B④ 迁移需做 project_key 回填（按行 session 归属推导项目键，或按事件流水血缘回填），回填判据 = 零泄漏 + 跨会话可见性恢复
4. **B⑤ 线上度量埋点**：漏召回率 / 重复提问率 / 纠正率轻量日志（设计 v1 §9）+ 检索提醒治理度量（injection_follow_rate / 脱敏信号）
5. **B⑥ 压缩派弱点低成本补强包**（2026-08-14 提出，复用现有 hook 位 + 结构化表）：① PreCompact 注入状态卡进摘要上下文——摘要天然含决策清单，直接提升底座压缩质量。**spike 已决（2026-08-14 实机）**：探针挂 PreCompact 的 hookSpecificOutput（标记 `THREAD-PRECOMPACT-MARKER-9472` + 状态卡文本）后跑 `/compact`，新摘要（checkpoint id 1129）中标记 4 处全部为对话历史引用（脚本代码块 / 任务描述），注入文本特征串零独立回显 → **PreCompact 的 hookSpecificOutput 亦不被 Qoder 底座采纳**（v1.1.21，与 PostCompact 一致），① 在 Qoder 上无 hook 路径、封板；兜底 = UserPromptSubmit 每轮状态卡 + query 工具检索；支持 hookSpecificOutput 语义的底座（如 Claude Code）上可再评估。② PreToolUse 查反馈表命中教训 → deny 或警告——教训从提示升级为强制；③ 状态卡检测上下文压力，超阈值附压缩建议；④ Stop 时从结构化表拼"会话交接卡"写 `.thread/handoff.md`，新会话开场读取。优先级：② 最高（纯确定性），③④ 随⑤实施。**B⑥-② 定案（2026-08-15 实施）**：确定性匹配 = 反馈行（correction/preference，合并视图 project+global+session）文本中提取"禁用指令"目标工具名（正则：`不要/别/禁止/禁用/never/don't use/avoid` + 工具名 token）→ 与待执行工具名 case-insensitive 匹配（token ≥3 字符且工具名包含 token 或相等）→ 命中即 deny，拒绝原因 = 教训原文（模型收到原因后转向，教训从提示升级为强制）。接缝：dsh = `ctx.tools.guard()`（`tools/pre-execute` 后同步守卫，返回字符串即拒绝，dsh-tool-cordis 实证）；Qoder = `PreToolUse` 同步 hook（scripts/tool-guard.mjs，命中 exit 2 + stderr 教训原文）。零 LLM、同步、命中即拒绝；误报可接受（阻断成本低，且原因可见可纠偏）。**恢复通道（2026-08-17 治理缺口补）**：`ThreadStore.deleteFeedback(id)` + `/feedback-del <id>` 命令（dsh/Qoder 双端）——教训可删即恢复，拦截测试可逆；覆盖（override）语义留待治理迭代。**治理可见性配套（同日 ①②）**：状态卡目标/决策/偏好行尾显示行 id（`#12`，写入即见、每轮常驻）；MCP `kind` 扩展 `goal/decision/feedback` → `queryStructured` 直查结构化表（隔离语义与事件一致）——忘掉 id 后的后置查询入口。
6. **B⑦ 场景级保真回归集**（新）：跨压缩保真场景入回归（decision-chain / repeat-question / goal-retention / file-lineage / compact-fidelity / injection-follow / scope-filter / migration-lossless / rebuild-recovery），`pnpm eval` 入 CI 门禁 → **✅ 已实现（2026-08-15）**：6 个 turns 场景（新增 compact-fidelity / injection-follow，harness 新增 compact/status-card 检查）+ 3 个专项（scope-filter / migration-lossless / rebuild-recovery，删结构化库后事件流水重放恢复），`pnpm eval` 聚合 9/9 通过、非零退出码，CI 门禁已加；**B⑧ 后并入 isolation 专项（见「会话临时隔离」节），门禁升至 10/10**
7. **dsh spike（并行，不阻塞主线）**：MCP overlay 零代码挂载 + 原生插件三接缝 + 多写者并发写验证（详见「待验证点」节）
- 验收（**2026-08-14 grill 定案：双层验收 = Qoder 验逻辑、dsh 验效果**）：功能正确性（跨会话继承 / 作用域过滤 / 迁移脚本等存储与检索逻辑）在 Qoder 上验收（底座无关部分，充分）；**注入效果（状态卡遵循率）推迟到 dsh 狗粮后验收**——Qoder 注入保真 0.4（用户侧、关注度低）上"注入发生"≠"模型遵循"，dsh inject() 系统侧遵循率需在 dsh 上补验（新会话继承内容 + 模型遵循）

### 批 C：智能增强（批 B 完成后另估）

顺序：**血缘语义边 → 摘要模型 → 动态路由 → 评估面板**

- 血缘语义边：决策 ↔ 代码实体贯通（依赖批 A 模型选型）
- 摘要模型：**已瘦身**——摘要由底座 compaction 承担（dsh pressure/overflow / Pi 迭代摘要 / Qoder compact_summary），Thread 只留情节归档的确定性降级链（见下）
- 动态模型路由：**已瘦身**——参考 OMP 角色路由模式（default/smol/slow/plan/commit），不自建，按需评估
- 评估面板：线上度量可视化（依赖数据积累）
- 验收：每子项各自回归 + 度量数据对比

> 批 C 前需完成批 A 模型选型的实测（下载 / 内存 / 延迟验证）。
> 摘要模型已瘦身（2026-08-14）：摘要由底座 compaction 承担，Thread 只留情节归档的确定性降级链——摘要生成不再列入批 C；批 C 摘要项 = 情节归档降级链的本地化兜底（可选）。

### 底座战略与产品形态（2026-08-14 论证定案；当晚 dsh 发布后修订为首选）

**背景链**：上下文膨胀治标不治本（压缩有信息密度下限，压无可压）→ 目标架构 = Thread 完全组织每轮上下文（状态卡 + 检索片段 + 近期工具历史，历史重放移除）→ Qoder 底座无此通道（`maxSessionTurns` spike 实测不截断重发）→ SDK wrapper 绕行（每轮新会话）可行但 Qoder 仅剩执行层价值。→ 2026-08-13 DeepSeek 官方发布 dsh：目标架构在其上**原生可达**（`agent/pre-step` 瀑布可改写/拒绝模型所见，`agent.inject()` 原生注入），wrapper 不再必要，dsh 定为 Thread 首选底座。

**候选底座调研（源码/文档实证）**：

- **deepseek-ai/deepseek-harness（dsh，首选）**：DeepSeek 官方 agent harness，TS + MIT，2026-08-13 发布、首发日 66.7k stars，当前 developer preview（明确会有破坏性变更）。架构 = "Everything is a Plugin"（Cordis 微内核）：模型适配器 / 工具注册表 / 会话日志 / agent 循环全部是插件，可从配置整体替换，无特权内核。关键接缝（对 Thread 逐条对应）：**会话日志 = append-only 事件溯源**，运行时强制 "Model-visible means logged" 重建不变量——Thread 的"无损流水"是 dsh 内置基建，采集从解析 transcript 退化为订阅 `session/event`；`agent.inject()` 原生上下文注入（落地于下一条被采纳的请求，且入日志）；`agent/pre-step` 瀑布可改写/拒绝模型所见（完全接管通道）；`ctx.tools` 注册即进 prompt 组装（查询工具无需 MCP 中转）；压缩成熟——压力阈值 0.8 + 保留比 0.16 + 溢出恢复 + 统一 `ctx.tokenMeter` + `summarize()` 子类化 hook，unit/real-loop 测试齐全；会话 fork/resume 血缘内置。重叠面：`goal`（**仅同会话**目标）、`feedback`（仅记录、不进模型）、`examples/mcp-memory`（第三方记忆 via MCP，默认关闭——官方姿态 = 记忆交给第三方）→ **dsh 管会话内，Thread 管跨会话/跨压缩**，边界不冲突反而互证。
- **earendil-works/pi**（badlogic 出品，MIT，TS 单仓，89.9k stars，2026-08-14 仍活跃）：三包分离 `pi-ai`（40+ Provider 含 DeepSeek）/ `pi-agent-core`（模型无关运行时）/ `pi-coding-agent`（CLI + 扩展系统）。上下文管理：阈值压缩（窗口-16K 预留触发 → 回合边界切割 → 保留近期 20K → LLM 迭代摘要替换，compaction entry 含文件血缘元数据）；树形会话；**扩展位** = `convertToLlm` 钩子 + compaction 模块整体可替换 + Dynamic Context（官方 RAG/记忆注入位）。裸编码能力：核心循环及格（4 工具基本盘、edit 模糊匹配、截断防御、并行执行），但无 WebSearch/子代理/plan/权限弹窗默认——纯编码任务约中位偏下~中位，综合任务低于中位，靠 Extension 补课。
- **oh-my-pi**（can1357，从 Pi fork，Rust 引擎 ~55k LOC，周更）：电池全包路线——32 工具（LSP/DAP/Hashline/browser/web_search）、40+ provider 角色路由、sub-agent 编排。记忆相关：`mnemopi`（SQLite 知识记忆引擎 remember/recall，可选本地 ONNX embedding + 远程 LLM，确定性兜底——**知识记忆，与 Thread 会话保真不同向**）；`snapcompact`（丢弃历史渲染成 PNG 位图帧让视觉模型读回，确定性零 LLM 调用——**保细节，与 Thread 保结构互补**）；包列表含 `metaharness`（疑似 harness 接入点，待验证）。编码能力中位以上。
- **Qoder CLI**：第一参考适配器与现网狗粮（批 A/B① 已实证三弱能力 + 压缩边界 hook）。**2026-08-14 grill 定案（狗粮切换）**：dsh spike 完成后，若三接缝可行——**切换到 dsh 狗粮**（旗舰优先验证，注入效果在 dsh 上验收），Qoder 降为适配器矩阵一员（不升级基线，保留 hooks 适配器代码与回归）。**开发顺序 = 先 MCP、后旗舰**：先做 MCP 查询通道（overlay，全底座通用、工作量小），再做 dsh 原生插件 bundle（订阅/注入/工具三接缝旗舰能力）。**✅ 已执行（2026-08-14）**：spike ①③⑤ + ② 全达标 → D-1/D-2/D-3 完成——`defaultPaths`/`buildStatusCard` 抽 core（qoder 与 dsh 共用，防两处漂移）；`dsh-thread` 插件（原 `@thread/adapter-dsh`，订阅 `session/event` 采集四类事件 + `agent/pre-step` 每轮注入状态卡，SQLITE_BUSY 重试、自身注入过滤防自循环）；headless profile 挂载（bundle + MCP overlay 持久化）；端到端验证通过（采集入库双库增长、注入入 session log 且零回流、`mcp__thread__query_session_memory` 可查询 dsh 会话事件）；回归链全绿。**日常开发狗粮已切换 dsh**，Qoder 降为适配器矩阵一员。**（2026-08-15 修订：独立 thread-mcp 包取消，MCP server 内嵌进 dsh-thread，见「开源发布路径」节）**

**Thread 定位收敛——会话保真策略层，边界（2026-08-14 晚修订为"两条半"）**：

- 知识记忆**集成不重造**（原"不做"修订）：知识轨 = **core 自带本地 BM25 确定性兜底**（借鉴 mnemopi 成熟模式：SQLite + 可选 embedding）**+ 可选 provider 集成**（marm / codebase-memory-mcp，发布物只含集成推荐清单不打包）——不自研 LLM 蒸馏；"全面"指痛点链覆盖而非功能堆叠
- 不做压缩保细节（底座 compaction / snapcompact 的地盘）
- 核心仍是状态结构：目标/决策状态机 + 血缘 + O(1) 状态卡 + 压缩边界 checkpoint + 全链路引用（摘要是索引、原文是真相）

**护城河判断**：不靠速度（can1357 周更产出下时间差无意义），靠**窄而深 + 验证体系**——漏召回/误判/漂移的度量与回归集是保真层命门，追功能的底座不会投入；生态位 = Pi 哲学不内置记忆、OMP 重心在工具链，会话保真是真空缺。**dsh 风险注**：官方未来可能自建跨会话记忆（goal 目前仅同会话、mcp-memory 默认关闭是窗口期信号）——应对 = 窄而深 + 验证体系 + 快速交付 dsh-thread，在官方填坑前成为该位事实标准。

**交付形态——适配器矩阵（主）+ dsh 双形态（旗，2026-08-15 修正）**：

- 主市场：Thread 适配器 × N 底座（三弱能力即可移植：hook 事件 / 上下文注入 / MCP）——Qoder 适配器已跑通，Claude Code hooks 同构（UserPromptSubmit/Stop/PreCompact + MCP）移植成本低。受众 = 全量长任务编码者，不押注任何底座。
- dsh 双形态（新旗舰，替代 t-pi/t-omp；2026-08-15 grill 修正：原三形态收敛）：① **day-0 MCP overlay**——查询通道零代码挂载（官方 examples/mcp-memory 同款模式），MCP server 现为 dsh-thread 内嵌（`bin=dsh-thread`）；② **`dsh-thread` 原生插件 bundle**——订阅 `session/event` 建结构化表 + BM25（采集）、`agent.inject()` 状态卡（注入）、内嵌 MCP server 查询（spike 实证 `ctx.tools` 注册同样可行，备用接缝）、可选 `agent/pre-step` 压缩边界保护（booster ① 在 Qoder 死路，在 dsh 原生）。~~③ t-dsh 参考发行版~~已取消——profile 配置是 dsh 所有插件的通用启用流程，README 示例即可；完全接管形态列为后发独立包 `dsh-thread-max`（见「开源发布路径」节）。**"完全接管"不是保真价值的必要条件**——旁路观测 + 注入已交付 80% 价值，dsh 原生接缝可到 90%+ 而不接管。
- pi / OMP：降级为适配器矩阵 backlog，不再作为旗舰。

**开源发布路径与社区策略（2026-08-14 定案）**：

- **双身份发布**：社区内身份 = `dsh-thread` 插件（`dsh-plugin` topic + npm bundle + Discord 入场，发现漏斗 = dsh 用户 → topic/Discord → 装插件 → 效果立现）；独立身份 = Thread 仓库（权威源：设计文档 / 回归集 / 7 条价值主张佐证 + 适配器矩阵证据）——**不做"dsh 的一个插件"**，适配器矩阵是官方自建记忆风险下的退路。
- **交付形态（npm，2026-08-15 grill 修正：三件套 → 两件 + 路线图）**：`@thread/core`（依赖库，dsh-thread 装得上）+ `dsh-thread`（旗舰插件，**一个包闭环**：采集 `session/event` + 注入 `pre-step` + 内嵌 MCP server `bin=dsh-thread`；better-sqlite3 随包解决 bindings）。~~thread-mcp / t-dsh~~ 不再独立发布——MCP 查询通道内嵌进 dsh-thread（无适配器写入则查询无数据，单独发查询通道是半成品；profile 配置是 dsh 所有插件的通用启用流程，README 示例即可）。**后发路线图**：`dsh-thread-max`（完全接管 dsh 上下文形态，独立包，npm 占位防抢注、功能随标准版验证后推进）。qoder-cli / evals 随仓库公开不发布（适配器矩阵证据 + 护城河回归集）。命名遵守 dsh 惯例（对齐 dsh-goal / dsh-compaction-basic）。
- **发布节奏**：跟随 dsh release train——preview 破坏性变更下版本钉定 + compat 矩阵（CI 对 dsh 多版本回归），只锚定核心不变量（session 日志 / inject / tools / pre-step——有运行时 "Model-visible means logged" 保护，最稳）。
- **社区目标分层**：M1 上 `dsh-plugin` topic + Discord 亮相 → M2 稳定后争取官方互链（examples/mcp-memory 第四行——官方定位"互操作示例、非背书"，先以稳定版本入场）→ 佐证体系新增 dsh 实测数据（跨压缩保真、inject 进摘要上下文）。
- **发布时机判定（2026-08-14 用户问询后补充：成熟度门槛，非日历时间）**：发布 ≠ 挑日子，是四个门槛**全部满足**才动；缺一不发。① **证据齐**——B⑦ 场景级保真回归集（**已实现 2026-08-15：10/10 PASS + CI 门禁，B⑧ isolation 并入**）+ 外部底座对照数据（"无人区"实证，**待补**；竞品无法自证、Thread 能，这是受欢迎的最大差异化基础）；② **一键可装**——`dsh-thread` 一条命令装完（`dsh plugin add dsh-thread`）、零配置、core + better-sqlite3 依赖随包解决（2026-08-14 狗粮实测 bindings 缺失坑，安装体验直接决定口碑；**2026-08-15 grill 修正**：thread-mcp/t-dsh 不再独立发布，查询通道内嵌 dsh-thread，profile 配置按 dsh 通用流程 README 示例）；③ **稳定窗口**——跟随 dsh release train，等 preview 转稳定后再发旗舰插件，避免破坏性变更期上线（**2026-08-15 Qoder 保留意见落地为可控风险窗口**：钉 0.1.0-rc.6 + CI compat 矩阵已加）；④ **命名占位**——`dsh-thread` npm/GitHub 未占用已确认，**现在即可占位**（占位 ≠ 发布，零成本；**2026-08-15 仍待执行**——需 npm/GitHub 账号操作）。**顺序建议（2026-08-15 修正）**：`@thread/core` 先发（依赖库）→ `dsh-thread` 旗舰 → `dsh-thread-max` 后发（完全接管，占位先行）。**受欢迎度预判**：需求侧真空缺（官方"记忆交给第三方"姿态 + 社区 30 个记忆插件全急就章）、上限高；供给侧受安装复杂度与认知门槛拖累，转化率取决于"一键可装 + 证据"两个前提——现在发会叫好不叫座。
- **发布时机判定的评审保留意见（2026-08-14 Qoder 侧，针对 ③ 稳定窗口）**：认同 ①②④；对 ③ **建议改为"可控风险窗口"而非干等稳定版**——dsh preview 转稳定时间不可控（刚发布），社区真空缺以小时计（上文自查"窗口比预想紧"），干等稳定版可能把窗口等没（竞品质量差但官方互链位/用户习惯会被占）。替代：**钉版本 + compat 矩阵**（§"发布节奏"已有此思路）——旗舰插件 peer 依赖钉 `0.1.0-rc.6` 先发，跟随 dsh release train 持续适配；核心接缝（session 日志 / inject / tools / pre-step）受运行时 "Model-visible means logged" 保护，破坏性变更主要在边缘，锚定核心不变量即可控。**分层执行（2026-08-15 grill 修正）**：`@thread/core` + `dsh-thread`（钉版本先发 + compat 矩阵）一次发布；`dsh-thread-max` 完全接管形态后发；稳定版是加分项非硬门槛。
- **不变**：monorepo、设计文档权威、evals 回归集、Qoder 狗粮循环、适配器矩阵主线。

**dsh 插件社区现状与竞争格局（2026-08-14 调研）**：

- **活跃度**：dsh 发布 ~16 小时即 67.2k stars / 5,674 forks；无 releases（preview 直推 master）、open_issues=0（走 discussions）。生态基建已成型：`dsh plugin add` 安装命令、`create-dsh-plugin` 脚手架（npm 周下载 135）、dsh-find-plugin 发现工具、两个 awesome 列表（精选 145 插件、入场门票 = `dsh.bundle` manifest）、社区发行版 oh-dsh。topic `dsh-plugin` 下 1004 仓库，头部插件 919★（web-ui）/ 854★（modlens 视觉），全部近几小时发布。
- **直接竞品（记忆 ~30 个 / 会话类 64 个）**：① **Jesse-njx/dsh-memory（1★）——理念最接近**："cited memory over lossless session log"、"summaries are an index into ground truth, never the truth"——无损日志 + 引用回拉与 Thread 同源；但后置 LLM 蒸馏（非确定性）、markdown 文件存储（无 BM25/状态机）、无压缩边界整合、无验证体系。② PerryLink/dsh-memento（1★）：bounded/layered/approval-gated/auditable 跨会话记忆。③ csyangwen/dsh-memory-evolve（24★，记忆类最高星）：跨会话长期记忆 + 自进化（偏知识记忆）。④ ben7am1n/dsh-memory（1★，跨会话 SQLite）；Tieboyh/dsh-session-search（2★，检索方向）；modusensus/dsh-mneme（2★，唯一带测试：106 个）。官方三例（Memorix/Reference Memory/Engram）= 知识记忆，不冲突。
- **战略含义**：① 窗口比预想紧——真空缺以小时计，16 小时 30 个记忆插件；但竞品全部 1~24★、无保真度量、无验证体系，Thread 的"窄而深 + 验证体系"仍是差异化，"第一个做"的红利在缩水。② **命名占位**：`dsh-thread` 在 npm / GitHub 均未占用（调研当日确认）——占位 ≠ 发布，待产品包络定稿后再动，随时可做。③ ~~发布提速：spike 与社区亮相并行~~（**同日被推翻**：真正的竞争力不是先发，谋定而后动——社区 30 个记忆插件全是急就章，恰证先发不构成竞争力；改走痛点矩阵 → 产品包络 → 再动工，见下节）。④ **持续跟踪 Jesse-njx/dsh-memory**——若补上验证体系即成正面对手；Thread 的确定性 MVP（零 LLM 蒸馏）+ 结构化状态机 + 跨底座适配器仍是差异。

**痛点全景与产品包络（2026-08-14 定案：谋定而后动）**：

- **原则**：真正的竞争力不是先发，是**痛点链全覆盖 + 成熟度**——发布方着急发布、用户为一个痛点装一个新插件，远不如一个相对成熟全面的产品让用户卸载掉多个而只用其一。产品验收标准 = "**卸载好几个，只用这一个**"。
- **痛点全景 × 已有解 × 残缺口（四维度）**：
  - A 会话内：压缩失真 → 已有解 = 全底座 compaction，残缺口 = **跨压缩状态保真**（状态卡 + checkpoint + 检索回拉，Thread 实机已验证）；上下文成本 → 已有解 = 阈值压缩，残缺口 = 状态卡替代历史重放的目标架构；压缩时机焦虑 → 残缺口 = 上下文压力导航。
  - B 会话间：新会话失忆 → 散装解 = CLAUDE.md 静态 / dsh-goal 仅同会话 / 蒸馏插件，残缺口 = **结构化跨会话继承**（决策状态机）；交接断档 → 散装 = powercontext handoff / agent-messaging，残缺口 = 确定性交接卡；换底座记忆作废 → 散装 = 一次性迁移（claude-bridge），残缺口 = **底座无关记忆层**（适配器矩阵）。
  - C 记忆本体：知识记忆 → Memorix / Engram / mnemopi / Mem0 **已解决较好 = 红海，取长对象**；可信度（蒸馏幻觉 / 不可溯源）→ 散装 = dsh-memory 引用 / memento 审计 / mneme 可编辑，各不相通，残缺口 = **确定性抽取 + 全链路引用 + 验证体系**；治理（过期/冲突/删除）→ 残缺口 = 状态机 superseded + 治理工具；检索质量 → 残缺口 = 带引用检索（摘要是索引、原文是真相）。
  - D 生态：碎片化（一个痛点一个插件，多库多词汇）→ **无人解决 = 一体化机会**；配置成本（embedding/密钥/后台任务）→ 残缺口 = 确定性零配置。
- **取长（集成不重造）**：知识记忆轨采纳 mnemopi 模式（SQLite + 可选 embedding，BM25 确定性兜底）；引用回拉吸收 dsh-memory 理念；可编辑性吸收 mneme；交接吸收 powercontext 概念。
- **补短（自研核心）**：跨压缩保真、跨会话状态机、确定性抽取、验证体系、多底座适配、一体化治理。
- **"卸载好几个"对应表**：装 Thread 一个 → 卸 dsh-memory（引用回拉）+ memento（审计）+ session-search（检索）+ memory-evolve 知识轨 + agent-messaging（交接）——五套存储与工具词汇收敛为一。
- **边界修订**：三条边界改"两条半"——知识记忆"不做"→"集成成熟模式、不自研蒸馏"；压缩保细节仍不做；核心仍是状态结构 + 保真。**"全面"= 痛点链覆盖，不是功能堆叠——每条轨都过验证体系**，否则重蹈竞品覆辙。
- **规划影响**：批 B 主线不变；booster 包扩为"一体化记忆轨"（原 ②③④ + 知识轨 + 引用回拉）；发布节奏 = 痛点矩阵定稿 → 产品包络定稿 → 再动工；npm 占位随时可做，不急。

**竞品深度校验（2026-08-14，深读 6 家竞品 README）**：

- **核对结果**：① 知识记忆=红海 ✅（mneme 向量搜索+Markdown 镜像 / evolve 五轨 / Engram/Memorix / powercontext 全套 memory API）。② 可信度=散装 ✅ 但升级——memento 已实现"协议+审批门+审计回放"（66 测试、ARCHITECTURE.md/AGENTS.md 纪律，"Model-visible ⟺ logged" 与 Thread 同哲学）；散装仍成立（各家各搞）。③ 检索残缺口 ⚠️ 被部分占据——session-search 已支持 dsh/codex/claude/pi/opencode 只读扫描（无索引、纯子串、无引用、无状态）。④ 交接散装 ✅（powercontext 完整 handoff API：activate/prepare/finalize/commit/continue）。⑤ ~~竞品无验证体系~~ ❌ 修正——mneme 140 测试（此前 106，在涨）、memento 66 测试、CI 都在；但都停在单元测试层，无场景级保真回归/度量。⑥ ~~真空缺~~ ❌ 修正——五个流派全有占位者：seam 派（memento）/ 聚合器派（evolve）/ 主权派（mneme）/ 引用派（dsh-memory）/ 只读检索派（session-search）。
- **新增洞察**：① Thread 差异化收窄为六项——跨压缩保真、跨会话状态机、确定性抽取、场景级验证体系、一体化治理、跨底座；其余维度都有占位者。② 流派分化 → 可共存：memento 卖 seam 不卖仓库（其 `ctx.memory` 可成为 Thread 知识轨宿主）；Thread 的保真策略层在它们之上，不与仓库派正面冲突。③ 两处可借鉴：memento 借 dsh 原生日志做审计（dsh 适配器直接消费 session 日志即可，省自建）；evolve 的 git-branch 跨设备同步 = "多机记忆"痛点，Thread 未覆盖（记入 D 生态维度 backlog）。
- **结论**：矩阵主体成立，两处修正、一处升级。护城河从"竞品没有"变为"竞品没有的层级"——**场景级保真度量仍是无人区**。

**主流底座生态补足调研（2026-08-14，底座不能只看自身，须查各自社区）**：

- **全景**：① Claude Code / Codex / Cursor / Gemini 共享 MCP 生态——已出现跨底座记忆层：codebase-memory-mcp（38.9k★，代码图谱）、marm-memory（329★，跨 claude/codex/gemini/qwen 的 3-in-1：会话记忆+代码图谱+概念图谱，60 秒安装）、krusch-context-mcp（71★，episodic memory + steering nudges + ACM 压缩/淘汰/token 审计）、Mem0 / Agentic Memory Extension / ECC（知识记忆）——⚠️ 部分触达残缺口；② Qoder 生态较小、无对等记忆补足；③ workbuddy 办公侧、无开放插件 SDK；④ dsh 前文已述（~30 插件、无保真度量）。
- **三个跨底座对手事实**：marm-memory = 模型驱动存储（会话摘要/合并）+ 图谱，非确定性无损捕获、无压缩边界挂接（仅库内 compaction candidates）、无状态机；krusch-context-mcp = steering nudges 即状态卡雏形，但向量检索 + 时间衰减（非状态机）、PostgreSQL+pgvector 重依赖、无验证体系；codebase-memory-mcp = 代码知识红海（38.9k★）。
- **修正后的真空白**：差异化六项收窄为**四项核心**——确定性无损捕获、跨压缩边界保真、决策/目标状态机、场景级验证体系（主流生态含 dsh 全部无人区）。两项调整：① 跨底座主张从"记忆层"改述为"**会话保真层**"（marm 已占记忆层话语）；② 知识轨定位更明确 = **集成 marm / codebase-memory-mcp 为 provider，绝不自建**（38.9k★ 红海）。
- **战略含义**：Thread 与 marm 类产品**共存甚至集成**（保真层在上、知识图谱在下，marm 的 `ctx.memory` / MCP 均可作知识轨宿主）；主流底座接驳优先走 MCP 通用通道（marm 已验证 60 秒可达）+ 各底座原生 hook 增强（Claude/Codex hooks、dsh inject）。

### 产品包络定稿（2026-08-14 定案）

**定位**：跨底座会话保真层——确定性无损捕获 + 跨压缩边界保真 + 决策/目标状态机 + 场景级验证体系；知识记忆集成第三方 provider。**（2026-08-14 晚升级：不隔离，正面竞争——"会话记忆的架构优胜者"，见竞品架构与技术调研节）**

**顶层设计原则（2026-08-14 用户定）**：**主动权在 Thread，不把希望放在模型上**——模型不可控，Thread 与模型的交互口越少越好；状态卡主动注入提醒驱动查询，模型只需记住一条行为契约：**"需要啥就来问，别自己瞎猜"**（代码级约束见 technical-design 不变量 #11，检索接口内聚见 §3.3 设计方向）。

**分层架构**：适配器矩阵（接驳层：dsh 原生插件=旗舰+现网狗粮（2026-08-14 切换）；Claude·Codex=MCP+hooks；Qoder=hooks 降为矩阵一员）→ 保真核心（底座无关：事件流水=无损写时建索引 → 结构化表=目标/决策状态机+反馈表+血缘 → BM25 检索=带引用回拉 → 状态卡注入=O(1) 分层优先级）→ 集成层（provider 抽象：知识记忆=marm/codebase-memory-mcp 集成；压缩=底座 compaction checkpoint 订阅；语义检索=可选 embedding，BM25 确定性兜底）。

**集成层边界（2026-08-14 用户定，与"主动权在 Thread"同构）**：集成层**只是增强和补足，不是强依赖**——Thread 核心不 import、不等待、不阻塞于任何第三方集成；不做执着适配验证（不为集成而集成）。**发布物只含"集成推荐清单"（文档级：推荐哪些 provider、怎么接、取舍），不集成打包**（第三方代码不进 npm 包）。MVP 默认本地 BM25 兜底（core 自带），provider 缺失时功能降级而非报错。

**功能边界（做 9 / 不做 4）**：做 ① 确定性无损捕获 ② 跨压缩 checkpoint + 状态卡回归 + 引用回拉 ③ 决策/目标状态机 ④ 场景级验证体系（回归集+度量+eval 工具链）⑤ 状态卡注入（预算约束：CLAUDE.md 200 行 + workbuddy 分层裁决）⑥ 跨会话继承（会话内>项目>用户>全局）⑦ 一体化治理（superseded/冲突裁决/审计溯源）⑧ 确定性交接卡 ⑨ 存储治理（源头控制）。不做：压缩本身 / 知识图谱·代码图谱自建 / LLM 蒸馏 / 语义检索自建。

**存储治理（2026-08-14 补充定案，用户提"存储快速膨胀"）**：
- 源头控制（写时即控，内嵌 B②）：① **大正文 spill**——事件只存元数据+摘要+引用，大块原文 spill 文件或直接引用底座日志（dsh 订阅原生日志**零正文复制**；Qoder transcript 为底座资产，capture 存结构化影子）；② **索引分层**——FTS5 只索引轻量文本（用户消息/agent 文本/决策/反馈），工具结果大块不建全文索引，检索按引用回拉原文；③ 项目分库天然隔离。
- 冷热归档（**延后**）：B⑤ 度量后用实测膨胀率定阈值（天数/GB），再设计冷分区（VACUUM INTO / zstd 归档 + 摘要级二级索引，参考 dsh spill 机制 + session-search 帧级解码）。MVP 单项目体积可管理，不预建。
- 无损语义："无损"= 细节可检索回拉，非全文复制两份；原文留底座日志，Thread 存索引影子 + 引用。

**批 B 重排（7 项，替代原编号）**：1️⃣ B② 作用域与命名空间全量落地（含存储治理源头控制内嵌）→ 2️⃣ B③ 跨会话继承（轻量版）→ 3️⃣ B④ 串库迁移 → 4️⃣ B⑤ 度量埋点（产出膨胀率数据 → 触发冷热归档决策；**另含检索提醒治理度量**——提醒频度/内容走 `injection_follow_rate` + 脱敏信号，防"狼来了"脱敏，见 technical-design 不变量 #11 提醒治理）→ 5️⃣ B⑥ 一体化记忆轨（反馈拦截 → 压力导航 → 交接卡 → 知识轨 provider 集成 → 引用回拉）→ 6️⃣ **B⑦（新）场景级保真回归集**（跨压缩保真场景入回归——护城河本体）→ 7️⃣ dsh spike 并行（MCP overlay + 原生插件三接缝）→ 8️⃣ **B⑧ 会话临时隔离**（✅ 已落地 2026-08-15，见下节）。

> 代码级设计与约束（模块边界 / 数据模型 v2 / 核心接口契约 / 不变量 11 条 / 适配器契约 / 验证体系 / 存储治理）见 [technical-design.md](./technical-design.md)。业务设计（端到端流程 / 输入输出契约 / 用户可见行为 / 操作约束 / 配置面 / 成本模型刷新）见 [business-design.md](./business-design.md)。

**会话临时隔离（B⑧，2026-08-15 落地）**：同项目双代理并行做不相关工作时的状态卡互相干扰问题（用户实机发现）→ 会话级可变隔离开关。语义：对话上下文（消息/决策/反馈）**全链路仅自己可见**（合并视图 / search / queryEvents / expand / 血缘全部过滤）；项目事实（tool 事件）**共享不断链**（"谁在什么时间干了什么"可溯源，代价是事实的对话溯源丢失——已接受）；解除后历史仍隔离、后续共享、按需沉淀（`/thread-publish` 或自然语言指定转共享）。触发 = 自然语言（"隔离/静默/别打扰" ↔ "解除隔离/恢复共享"）+ 显式命令（`/isolate` `/unisolate`），双通道不强制。状态卡隔离模式标注"本会话已隔离"且只列本会话内容。schema v3（isolation 列 + session_isolation 表）；dsh-thread 与 Qoder hooks 双端接入；evals isolation 场景（门禁 10/10）。

**开放项（待拍板）**：① 知识轨 provider 首选——建议两者皆可配、MVP 默认本地 BM25 兜底；**2026-08-14 已由「集成层边界」吸收**（本地 BM25 兜底常驻 + 可选 provider 只进推荐清单不打包，无独立待决项）→ 状态：**已决**；② 语义检索是否可选集成——**2026-08-14 grill 定案：确认延后**——与 B② 结构化路由（时间过滤/排序/计数，确定性 SQL 路径）不同层：结构化路径进 B②，语义检索不进 MVP，待 B⑤ 度量显示 BM25 漏召回率高再评估；按集成层边界走"可选 embedding + 推荐清单不打包"→ 状态：**已决**；③ 交接卡落盘——**2026-08-14 grill 定案：项目目录 `.thread/handoff.md`**（模型可经底座文件读取直接访问；独立于 DB 存储位置——B④ 后 DB 在用户目录，交接卡是产品文件非存储库，项目目录 .thread 下不冲突）→ 状态：**已决**。④ **服务层结构化查询（2026-08-14 狗粮实测新增，B② 检索能力范围）**：`query_session_memory` 仅语义检索，无时间范围/排序/kind 过滤/计数聚合——纯 MCP 接入的 Agent 无法回答"抽查/审计"类精确时序问题（今早 9 点后第一个问题 → `not-found`；调用了几次某工具 → 命中解释文档而非计数）。**设计方向已定（2026-08-14）：接口内聚 + 主动提醒，非接口膨胀**——不新增一堆查询接口，模型不该被指望自觉识别查询类型；在现有查询接口内部做路由/处理逻辑（时序/计数/审计类 → 结构化执行路径，语义类 → BM25），并由状态卡按上下文注入合适的检索提醒来触发查询（详见 technical-design §3.3 已知缺口）。~~⑤ 单底座主写约束~~ **已推翻（2026-08-14）**：改为**同项目单库多写者**（SQLite WAL + busy_timeout + 写失败重试队列）——多底座并行是真实场景（同项目不同模块），跨 agent 状态同步是"底座无关"完整形态；并发写可靠性列入 dsh spike 验证项（详见 technical-design §5.1 / business-design §4）。子代理结论：MVP 不采集内部事件，结论经 tool_result 回流，父子血缘为可选边。⑥ **协作便捷封装（2026-08-14 Qoder 提出，dsh 确认，待规划）**：结构化查询路径本体已实现（`queryEvents` + MCP 结构化参数，见 technical-design §3.3 更正注记），但**协作场景**缺便捷封装——"对方（另一底座/会话）最近做了什么"需按 `session_id` 定向 + 最近 N 条事件 + 简单摘要，目前要手工拼 `session_id + order + limit` 参数。规划方向：状态卡内"协作互见"区块（展示另一活跃代理最近 N 条事件摘要）或 MCP 工具侧加"最近活跃会话/最近进展"便捷参数，不新增独立工具（遵守接口内聚）。验收：双代理各读对方进展 ≤1 次查询、无需知道对方 session_id。→ 状态：**待规划（随 B⑤ 度量埋点后评估）**。⑦ **会话隔离自然语言判定收紧（2026-08-15 用户问询 + 现网误触发实证）**：现规则 = 消息任意位置含"隔离/静默/免打扰/别打扰/屏蔽"即触发（可选"进入/开启/启用/先/临时"前缀），过宽——用户询问"隔离的判定规则是什么"的消息被误触发（events id 5124 实证，isolation=1）。方向：行首锚定 + 命令式短白名单（"开始隔离/进入隔离/保持安静"等），讨论性语句不触发；误触发入回归场景（isolation 场景扩展：讨论规则的消息不得改变开关）。**定案（2026-08-15）**：整条消息 trim 后精确匹配白名单——隔离：`/isolate`、`隔离`、`开始隔离`、`进入隔离`、`临时隔离`、`静默`、`免打扰`、`别打扰`；解除：`/unisolate`、`解除隔离`、`退出隔离`、`恢复共享`；沉淀：`/thread-publish <kind> <id>`（整条）。→ 状态：**已实施并现网复测通过（2026-08-15：讨论句"试试看这样会不会隔离"未触发，events id 5345 isolation=0）**。⑧ **单命令行为契约（2026-08-15 用户提）**：用户单发 隔离//unisolate//thread-publish 是插件状态开关、非模型任务——模型应一句话确认状态、不展开思考。载体：状态卡底部静态指示行（同"需要历史时调用 query_session_memory"款）或 dsh `system-prompt/assemble` 瀑布（spike 已发现接缝）；状态卡同轮有一轮滞后（pre-step 先于消息解析，已实机观察），模型答后靠下一轮卡片标记复核。**定案（2026-08-15）**：载体 = 状态卡底部静态行（core buildStatusCard 常量，Qoder/dsh 共用）。→ 状态：**已实施并现网复测通过（2026-08-15：19:00 重启后状态卡底部指示行实测出现）**。⑨ **query 工具隔离字段可观测（2026-08-15 狗粮发现）**：`query_session_memory` 返回的事件不含 `isolation` 列、无 `session_isolation` 状态查询路径——B⑧ 隔离验证（开关状态/历史行标记）走标准信道查不到，狗粮中被迫直查生产库（只读演练）。方向：queryEvents 输出补 `isolation` 字段 + 响应信封带 `session_isolation`（现有工具内聚，不新增工具面）。→ 状态：**已实施并现网复测通过（2026-08-15：语义/结构化两次实测，信封含 session_isolation、事件行含 isolation 字段）**。⑩ **注入卡片独立成轮自循环（2026-08-15 用户提，机制已源码实证）**：`agent.inject()` 的状态卡被 dsh agent-loop 当新 turn 输入再驱动一轮（inbox `hasPending` → `wakeDriver()` → claim 为 turn 输入，dsh-agent-loop lib/index.js preStep/claim），用户无新问题时模型被迫对"纯卡片消息"再答一轮，该轮 pre-step 又注入新卡。修复 = 双通道：① **插件侧守卫**——pre-step 检测本轮 claimed `messages` 全部为本插件注入（source.kind=plugin + source.plugin=dsh-thread）时跳过注入，切断 卡→答→卡 循环；② **模型侧行为契约**——纯卡片消息当系统内容读、一句话以内或零输出（AGENTS.md 轮次纪律）。→ 状态：**已实施并现网复测通过（2026-08-15：18:52 重启加载守卫构建，真实轮后不再出现自动卡片轮，checklist I4 ✅）**。

### 竞品架构与技术调研（2026-08-14：不隔离，正面竞争）

**触发**：业务/功能层调研后，补竞品**架构与技术**层调研——即使竞品已有某功能，若架构可提升、功能比它好、能解决原功能痛点（场景覆盖/性能/成本），Thread 不必隔离出去。

**捕获机制（最致命维度，实测查证）**：
- marm / krusch / mneme / evolve / Claude Auto Memory / workbuddy = **模型驱动**（agent 调工具存、LLM 笔记、夜间批量抽取）——靠模型自觉 + 用户记得说"存一下"，漏存/错存/延迟
- memento = 模型驱动写入 + 审批门——同上 + 每写一次打断用户
- dsh-memory = 会话结束事后蒸馏（ctx.jobs）——延迟、只蒸馏摘要
- **Thread = 确定性订阅**（dsh session/event / 各底座 hooks）——零依赖、实时、无损

**技术维度对照**：检索（竞品：子串/向量+pgvector/FTS+语义重排；Thread：FTS5 BM25 + 引用回拉，embedding 可选）｜部署（竞品：Python daemon+Docker / PostgreSQL；Thread：内嵌 SQLite + hook 脚本 / dsh 插件，无常驻）｜成本（竞品：每次存取过 LLM/embedding；Thread：**核心零 LLM**）｜压缩交互（竞品：全部无视底座压缩边界；Thread：checkpoint + 状态卡回归，独有）｜治理（竞品：审批门/时间衰减/autoDream；Thread：superseded 状态机确定性裁决）｜验证（竞品：单元测试；Thread：场景级保真回归集 + 度量，独有）。

**结论：不隔离，正面竞争**。"找无人区挤进去"定位太弱；正确框架 = **与竞品同场竞争会话记忆功能集，靠架构全面占优**：① 场景覆盖——模型忘了存也不丢（确定性捕获）、压缩后细节可回拉（独有）、跨底座同一份记忆；② 性能——内嵌零常驻、捕获近零延迟、BM25 确定性检索无网络依赖；③ 成本——零 LLM 核心，竞品每次存取烧 token/embedding；④ 信任——引用可溯源 + 状态机 + 回归集自证不失真（竞品无法自证）。

**仍不做**：代码图谱/知识图谱（集成 codebase-memory-mcp 38.9k★）——那才是真隔离；会话记忆功能集正面打。

**对包络影响**：定位升级为"**会话记忆的架构优胜者**"——四项核心 = 技术优势引擎，不是避风港。

### 外部借鉴（dsh-routing-suite，2026-08-15 评审）

[套件](https://github.com/yjh051108/dsh-routing-suite)（injector 免重启手术台 + [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 思维模式路由 + mode-boost）以 [paper](https://github.com/yjh051108/dsh-router-standard/blob/main/docs/paper.md) 实证了 V4 Pro 的"双吸引子行为策略"：人格轴存在相变（spec/react 两稳定带 + 高熵过渡带）、**会话首请求即锚定轨迹（路径承诺）**、模型无法自路由。定位差异：它是**行为条件化层**（首轮选人格 + 工具过滤），Thread 是**记忆保真层**；哲学同源（都不信任模型自管理，其实证结论 = 不变量 #11 的外部佐证）。借鉴清单（直接落地 ①②③④，方法论文档化 ⑤⑥⑦，明确不学 ⑧⑨）：

| # | 借鉴点 | 落点 | 状态 |
|---|---|---|---|
| ① | 首轮杠杆：首条消息即锚定轨迹 → 状态卡首轮加权（全量档），后续维持轻量 O(1) | buildStatusCard `firstTurn` 档；dsh pre-step turn===1 传递 | ✅ 已实施 |
| ② | few-shot 示例强化工具契约段（weak 窗口区分度 +3.3/+2.3 实证） | 两 server.ts 的 TOOL_DESCRIPTION 加 1 条调用示例 | ✅ 已实施 |
| ③ | 绑定式收束语（纯"再想想"是陷阱，预算耗尽 0% 收敛；带行动收束 100%） | 状态卡尾行 → "…查询并基于结果给出结论" | ✅ 已实施 |
| ④ | 注入安全原则（router amnesia 教训：整段替换丢 plan 边界 → 重复探索） | 不变量 #11：注入=追加 user message，禁止改写/替换底座 section | ✅ 已实施 |
| ⑤ | 实证方法论：固定微任务 + 定量分类器 + n 次区分度，把条件化效果量化 | B⑤ 度量协议：注入遵循率从断言升级为带实验的区分度数字 | 📝 记入 B⑤ 设计 |
| ⑥ | 前缀缓存友好性实证（切 persona 击穿缓存；尾部注入无效） | business-design §2.3"稳定段在前"获外部背书；cache-hit 进 B⑤ 度量 | 📝 记入 B⑤ 设计 |
| ⑦ | 诚实量化哲学：连续旋钮是幻觉，行为层有相变，量化到稳定带 | 提醒治理显式化稳定带（每轮/低频/仅冲突时），不连续微调 | 📝 记入提醒治理 |
| ⑧ | ~~模型/关键词自分类路由~~ 不学：关键词分类是权宜且绑定具体模型版本，与底座无关 + 确定性内核冲突 | — | ❌ 反向 |
| ⑨ | ~~运行时手术台式免重启注入~~ 不学：接缝脆弱源（#13 实证），保持锚定核心不变量 + 重启生效 | — | ❌ 反向 |

**待验证点（dsh spike，2026-08-14 评审定案：②⑤ 提前为 B② 开工前置，其余与批 B 并行；③ 有条件推进）**：① **✅（2026-08-14 实测完成，B④ 后补验）**——MCP overlay 零代码挂载：`--patch` 覆盖层 `insert` cordis 条目（`@deepseek-ai/dsh-mcp-client`，stdio 指向 Thread MCP server——现为 dsh-thread 内嵌 server，`bin=dsh-thread`）即挂载成功，headless 模型实测调用 `mcp__thread__query_session_memory` 工具（返回 not-found 为检索词问题，非挂载问题）；**零代码可行，MCP 通用层先于旗舰插件（2026-08-15 起并入 dsh-thread 单包）**；② **前置 ✅（2026-08-14 实测完成）**——原生插件 spike 三接缝全部实证：`session/event` 订阅（事件流实时到达）；`agent.inject()`（UserMessage 级排队：`agent/inbox/spliced` → `request/header` → **`user/message` surfaceOp:append 入 session log**，模型实测遵循注入标记）；`ctx.tools` 注册（`defineTool` 注册后模型实测调用 `thread_query`）；**inject 进压缩摘要 = 成立**——inject 的 user/message append 进流水，compaction summarize 输入 = 重放对话前缀（system+tools+leading messages），必然包含注入内容（Qoder 死路，dsh 成立）；另发现新接缝 **`system-prompt/assemble` waterfall**（系统提示词组装注册，比 inject 更系统的注入通道，dsh-thread 可双通道）；③ **✅（2026-08-14 实测完成，达中位）**——dsh 同任务编码实测：独立 TS 任务（LRUCache+TTL+vitest，strict）自主完成全流程（install→实现→测试→typecheck+test），实现质量高（泛型/参数校验/懒过期/注释），测试 20/21 首过（1 个断言笔误可快速定位修复，修正后 21/21）；**判据达成 → 狗粮切换可执行**；④ 钉版本策略——**已记风险（2026-08-14 切换落地）**：dsh preview 破坏性变更下锚定核心不变量 = session 日志 / 事件 / inject / pre-step（有运行时 "Model-visible means logged" 保护，最稳）；`dsh-thread` peer 依赖钉 `0.1.0-rc.6`；挂载 = `dsh plugin add dsh-thread`（本地开发可用手工复制 dist + package.json + cordis.patch.yml 到 profile node_modules，pnpm 跨盘 `link:`/`file:` 绝对路径解析失败，Windows 已知坑）→ dsh 升级或插件 API 变更时需重验；⑤ **前置 ✅（2026-08-14 实测完成）**——**多写者并发写验证**：临时库压测（8 写者 × 500 = 4000/4000 全成功，70 次 busy 重试，零丢失、`integrity_check=ok`）。**关键发现：`busy_timeout` 未让并发写者排队**——better-sqlite3 多进程并发写 WAL 时立即抛 `SQLITE_BUSY`（"database is locked"），**重试队列（catch `e.code==='SQLITE_BUSY'` → sleep → 重试）是成功保证，必需而非可选项**；Thread 设计已含重试队列，实证必要性成立。实现约束：`ThreadStore.append` 无内置重试，capture 侧必须捕获 SQLITE_BUSY 并重试（100ms 间隔、上限 ≥20 次，实测 8×500 下单写者最多 14 次）。**理由**：②⑤ 直接影响 B② schema（origin/spill/scope）与 B③ 继承验收（inject 路径是否同效），翻车则存储模型返工；spike 为低成本只读验证，先钉死接缝事实再动 B②，返工面最小（2026-08-14 grill 评审定案）。原 Pi/OMP spike 降级为可选。

---

## 1. 二期规划

- 血缘语义边（模型抽取，需先解决质量与评估）
- 动态模型路由（任务分类 → 选模型，失败降级链，预算封顶）
- 会话图谱 ↔ code-review-graph 贯通
- 跨会话记忆检索（决策/反馈跨会话复用，命名空间隔离——事件流水已具备基础；完整作用域设计见 §3）
- 评估面板（线上度量可视化）
- 摘要模型：**已瘦身**——摘要由底座 compaction 承担（dsh pressure/overflow / Pi 迭代摘要 / Qoder compact_summary），Thread 只留情节归档的确定性降级链（见批 C）

> TencentDB Agent Memory 可选集成已移出二期（不依赖、不正面竞争，暂缓）。

> MVP 状态注记（跨会话继承）：数据无损——所有接入项目的会话都写入脚本所在仓库（Thread repo）的 `.thread/sms.db`（仅 `session_id` 隔离，项目级命名空间未实现，见 §2），旧会话内容在库中不丢；但**不自动继承**——状态卡按 session 隔离，新窗口开场为空，当前继承通道是模型主动调 `query_session_memory`（缺省查最近活跃会话）。二期实现"新会话自动注入跨会话 active 决策/反馈 + 按项目/会话命名空间隔离"。

## 2. 开放问题（实现前需定）

> 2026-08-14 清理：以下条目与后续章节定案重叠，标注状态。真正未决项见「产品包络定稿」节开放项（①~⑤）。

- 状态卡的确切内容与 token 预算 —— **已决**（预算 ≤200 行、分层 60/25/15，见 business-design §2.3）
- 情节分组的规则细节（边界情况）—— **已决**（现有规则：user_message 开启新情节，其余更新 seq_end；MVP 保留，精调待 B⑤ 度量）
- 检索重排策略（打分公式）—— **已决**（FTS5 BM25 现有实现；embedding/reranker 为可选集成，见批 A 选型表）
- 写入管线的存储格式（SQLite / 嵌入式 KV / 文件 + 索引）—— **已决**（SQLite + FTS5，v1 已实现；v2 增量见 technical-design §2.2）
- 多会话（跨天/跨项目）的隔离与命名空间 —— **已决**（双作用域 + 用户级库/项目事件库，见 §3；现网单库 → 新结构迁移路径 = B④）

### 批 A 调研结论（已决，2026-08-14）

**底座上下文裁剪（Qoder CLI）**——证据：官方文档 hooks-reference / settings-reference / slash-reference / sessions + 本机 `.qoder-cn` 配置：

- Auto-compact：原生支持，接近上下文窗口上限自动触发；无独立开关，经 `model.contextWindow` 间接控制（本机已配 400000）。
- **PreCompact / PostCompact hooks 存在**（28 个事件之二）→ O(1) 裁剪接入点 = 挂这两个 hook：PreCompact 前状态卡已每轮常驻，PostCompact 后重新注入状态卡，细节靠检索拉回。
- 命令级手段：`/compact` 手动触发、`/clear` 只清对话上下文（AGENTS.md 与长期记忆独立保留）、`/new`、`/rewind`、`/branch`。
- 会话恢复：`-r/--resume`、`-c/--continue`；转录 `.jsonl` 全量落盘 + state.json 记压缩边界，恢复重放压缩后历史。
- **结论：底座可控路径成立，批 B① 不需自己实现裁剪**——实现 = PreCompact/PostCompact hook 接线 + 状态卡重注入 + `model.maxSessionTurns` / `contextWindow` 阈值定制。
- **Spike（2026-08-14，`_ctx-spike` 隔离目录）**：`model.maxSessionTurns=2` 实测**不改变历史重发**——hook 探针验证项目级配置正常加载；金丝雀（轮 1 写 canary-8472，轮 5 询问）+ 轮 6 让模型列举全部用户消息，模型完整复现全部 6 条。底座上下文只有三条路径：全量重发 / `/clear` / 压缩（手动 + auto），**无"只重发最近 N 轮"机制**。**完全接管 prompt 组装无底座通道**：hook 只能注入（加法）或阻塞（exit 2），不能替换历史；实现路径仅剩 wrapper（SDK 驱动自有会话，v1 §149 替代路径）或底座新能力。当前"旁路观测 + 增量注入"即底座能力边界内最优解。

**旁路模型选型**——全部本地化（零 provider 成本），磁盘大小为按参数量化公式估算，落地下载时二次确认：

| 组件 | 模型 | 量化 | 磁盘 | 内存 | 延迟 | 运行时 |
|---|---|---|---|---|---|---|
| 轻确认分类器 | MiniLM-L6 多语微调 | ONNX int8 | ~90MB | ~150MB | 5-30ms | onnxruntime-node |
| 语义抽取 | Qwen3-4B（省内存备选 Qwen2.5-3B） | GGUF Q4_K_M | ~2.5GB / ~1.9GB | ~2.8GB / ~2GB | 15-30 tok/s | node-llama-cpp |
| Embedding 基准 | bge-m3 | fp16/int8 | 1.1/0.6GB | ≈磁盘 | 30-80ms | onnxruntime-node |
| Embedding 默认 | bge-small-zh-v1.5 | int8 | ~25MB | ~100MB | <10ms | onnxruntime-node |
| Reranker 基准 | bge-reranker-v2-m3 | int8 | ~0.6GB | ≈磁盘 | 50-150ms | onnxruntime-node |
| Reranker 瘦身 | bge-reranker-base | int8 | ~280MB | ~300MB | 30-80ms | onnxruntime-node |

安装包策略：**默认随包 MiniLM + bge-small-zh-v1.5（合计 <200MB，保分类与中文检索主路径）；bge-m3 / reranker / Qwen3-4B 首次使用时按需后台下载，失败静默回退确定性路径**。运行时定案：node-llama-cpp（GGUF，预编译二进制随 npm 分发、Windows 原生）+ onnxruntime-node（ONNX，embedding/reranker 用）；ollama sidecar 需用户另装，弃用。

## 3. 作用域与命名空间（二期设计）

> 状态：设计已确认（grill 共享理解），未实现。动机：按项目隔离不应"全部隔离"——项目相关记忆（任务决策、事件）要隔离防污染，用户偏好与项目无关，应全局共享；用户可通过对话自然表达选择作用域。

- **双作用域**：`global`（用户级，跨项目）与 `project`（项目级）。
- **启用范围**：反馈/偏好表启用双作用域（v1 §4 已定位"跨会话复用"）；目标/决策默认 project，表内预留 `scope` 字段不启用；事件流水按项目隔离，正文绝不进全局库（防污染）。
- **默认分类**：反馈**默认 global**（污染方向更安全）；确定性规则预过滤——项目限定词（"这个项目/仅此项目/这里"）→ project，全局声明（"全局/所有项目/以后都"）→ global。用户显式声明常缺失 → **由本地小模型分类兜底**（v1 §7 旁路模型，输入=回合+状态卡），确定性规则只做预过滤。
- **显式选择**：只走对话内自然语言（如"记住，全局都用 pnpm"、"仅这个项目别用 ORM"），不引入面板/命令（v1 §8 用户不接触记忆系统）。
- **存储模型**：结构化表进用户级单库 `~/.thread/structured.db`（行级 `project` 字段 + 反馈 `scope` 字段）；事件流水进 `~/.thread/projects/<规范化项目键>/events.db`——项目目录零污染（DB 不写入用户项目，git/打包不受影响）。**项目身份键** = 规范化 git 根（realpath + 分隔符/大小写归一；非 git 退化为规范化 cwd），从 hook 载荷 `cwd` 推导——避免同一项目因路径写法不同分裂命名空间。
- **检索与注入**：查询合并"当前项目（project+global）+ 全局"行，按分数混排；非当前项目的 project 行硬性过滤。状态卡反馈区 = 项目内 + 全局（标注「全局」）；目标/决策区仍只显示当前项目。
- **状态卡限额**：低风险软参数——正确性由检索层兜底（不够可 `query_session_memory` 查），限额只影响成本天平（prefill 开销 vs 查询频率）；总预算按注入位置分档（dsh 系统侧 ≤200 行 / Qoder 用户侧 ≤100 行 / Claude·Codex 待实测）、分层 60/25/15、默认每区 3~5 条（口径见 business-design §2.3 格式原则 5），正式调优由 v1 §9 线上度量驱动，按预算原则而非条数定死。
- **冲突**：① 分层覆盖——项目级覆盖全局级（"这个项目用 yarn" 是全局"都用 pnpm"的例外），覆盖关系**并列展示 + 标注作用域**，不静默（v1 §6"被标记的冲突"原则）；② 同层多写者冲突（同一 project 内两个会话的对立决策）——走**先到先得 + 后来者选择**（technical-design §5.1）：Thread 状态卡提醒 → 用户当前会话表态跟随或 session 级覆盖，project 级仅建立者可改。
- **反馈生命周期**（撤销/覆盖）：与本地模型分类同批实现；MVP 靠冲突展示兜底（改口的两条偏好都显示且带时间戳）。
- **迁移**：现网单一 `.thread/sms.db` → 用户级库 + 项目库的迁移路径待定（见 §2）。
