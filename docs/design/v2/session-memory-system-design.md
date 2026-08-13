# 会话管理系统设计文档 v2（Session Memory System）

> 日期：2026-08-13 ｜ 状态：**规划中，未实现**——v1 基线（需求/架构/已实现部分）见 [v1 文档](../v1/session-memory-system-design.md)；本文件承载二期规划、开放问题与已确认的二期设计，实现前仍需在 v1 与本文档间保持一致，改动架构/接口时先改对应版本设计文档再改代码。

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
| 7 | **成本节省**：长会话上下文不再随历史线性膨胀，同任务总 token 下降（目标架构） | 每轮上下文 = 状态卡 + 按需检索片段，替代全量历史重放 | eval-compare.mjs 同任务前后 N 次中位数对比（待数据积累）。**成立条件（备注）**：① 检索频次受控时节省成立，高频检索会侵蚀节省；② 薄适配模式下状态卡本身是净增（每轮几百 token），但 Thread 兜底压缩失真后，用户可**放心调低压缩阈值**（contextWindow / 更频繁压缩）换来每轮输入 token 下降——净效果取决于阈值调低幅度，可能反超状态卡开销，**不预设结论，以度量为准**；③ 完全接管形态（t-pi/t-omp）下节省直接兑现 |

---

## 路线图（批次计划，2026-08-13 确认）

批次按依赖排序：**A（前置调研）→ B（记忆层能力）→ C（智能增强）**，里程碑 + 验收标准粒度，不排具体日期。

### 批 A：前置调研（约 0.5~1 天，**已完成 2026-08-14**，结论见 §2）

- 底座侧上下文裁剪能力调研：Qoder CLI 的 auto-compact 行为、能否触发/控制、历史截断 / resume 能力 → 已决：PreCompact/PostCompact hooks 可用，底座可控路径成立
- 本地旁路模型选型（桌面调研）：轻确认分类器、语义抽取小 LLM、embedding、reranker 的具体模型 + 内存/延迟预算 → 已决：选型表见 §2（实测下载放批 C 前）
- 验收：§2 两条开放问题从"待定"变为"已决" ✅

### 批 B：记忆层能力（约 3~5 天）

按序推进，① 优先级最高：

1. **上下文裁剪接入（O(1) 落地）**：方案已由批 A 定案（底座可控路径成立）——实现 = 挂 PreCompact/PostCompact hook：PreCompact 时状态卡落库防丢，PostCompact 后经 hookSpecificOutput 重新注入状态卡，细节靠检索拉回；辅以 `model.maxSessionTurns` / `contextWindow` 阈值定制。验收：① 长会话实测 ctx 有界——每轮上下文长度序列从 transcript 条目 + `compact_boundary` 的 compactMetadata 锚点重建（底座不落 per-turn usage，实测确认），确定性可量化；② 同任务 token 消耗对比——脚本化回归场景（固定任务）裁剪接入前后各跑 N 次取中位数对比总 token，模型输出非确定，故作为趋势性佐证而非精确值
   - **spike 实测 + 实机验证（2026-08-14，本机 `/compact`）**：PreCompact 载荷 = session_id/transcript_path/cwd/hook_event_name/model/trigger/custom_instructions（无摘要）；PostCompact 载荷 = 同上 + `compact_summary`（替换历史的摘要全文）、`trigger` ∈ manual/auto。**接线已落地**：① PostCompact → 新增 `compact_checkpoint` 事件入流水（body=摘要全文，meta=trigger/model）——摘要即压缩边界血缘标记，可检索（实机落库验证通过，trigger=manual）；② PreCompact 不需接线——事件流水已持续采集（UserPromptSubmit/PreToolUse/PostToolUse/Stop 全挂 capture），DB 先于压缩已是最新。**实机结论**：PostCompact 的 hookSpecificOutput 状态卡注入不被底座采纳（压缩边界后无状态卡），该接线已移除；PreCompact 同结论（批 B 第 6 项 ① spike，2026-08-14 实测）；状态卡回归由 UserPromptSubmit 每轮注入保证（手动压缩后下一条用户消息即恢复），auto-compact 续写首轮由压缩摘要的 Primary Request 段兜底——目标不漂移保障成立
   - **验收①（2026-08-14 落地）**：已建 `scripts/eval-ctx.mjs`（transcript 字符窗口 + 分段锚点校准重建每轮上下文曲线）与 `scripts/eval-compare.mjs`（同任务前后各 N 次取中位数对比）。本会话实测：3 次压缩锚点 249541→4785 / 74047→3673 / 63797→3614（降幅 94~98%），每轮上下文估算峰值 248927 ≤ 锚点峰值 249541，sawtooth 成立、谷值 ≤4785 → **ctx 有界 ✅**；auto-compact 未触发（阈值未配），其有界性待阈值配置后补测。**验收②**：harness 就绪，固定任务需在新鲜会话各跑 N 次积累数据（任务须长到触发 ≥1 次压缩，否则接入前后无差别）
2. §3 作用域与命名空间全量落地：用户级结构化库 + 按项目键分事件库、项目键推导、查询合并（project+global）、状态卡合并显示、非当前项目硬过滤
3. 跨会话自动继承（轻量版）：新会话开场注入上一项目会话的 active 决策 / 全局反馈（最近 N 条），复杂跨会话检索策略等线上度量数据后再调
4. 现网串库修复 + 一次性迁移脚本（现网 `.thread/sms.db` → 新结构，数据无损）
5. 线上度量埋点：漏召回率 / 重复提问率 / 纠正率轻量日志（设计 v1 §9）
6. **压缩派弱点低成本补强包**（2026-08-14 提出，复用现有 hook 位 + 结构化表）：① PreCompact 注入状态卡进摘要上下文——摘要天然含决策清单，直接提升底座压缩质量。**spike 已决（2026-08-14 实机）**：探针挂 PreCompact 的 hookSpecificOutput（标记 `THREAD-PRECOMPACT-MARKER-9472` + 状态卡文本）后跑 `/compact`，新摘要（checkpoint id 1129）中标记 4 处全部为对话历史引用（脚本代码块 / 任务描述），注入文本特征串零独立回显 → **PreCompact 的 hookSpecificOutput 亦不被 Qoder 底座采纳**（v1.1.21，与 PostCompact 一致），① 在 Qoder 上无 hook 路径、封板；兜底 = UserPromptSubmit 每轮状态卡 + query 工具检索；支持 hookSpecificOutput 语义的底座（如 Claude Code）上可再评估。② PreToolUse 查反馈表命中教训 → deny 或警告——教训从提示升级为强制；③ 状态卡检测上下文压力，超阈值附压缩建议；④ Stop 时从结构化表拼"会话交接卡"写 `.thread/handoff.md`，新会话开场读取。优先级：② 最高（纯确定性），③④ 随⑤实施
- 验收：新增回归场景（跨会话继承 / 作用域过滤 / 迁移脚本）+ 狗粮验证（新会话状态卡出现继承内容、跨项目不串库、迁移无损）

### 批 C：智能增强（批 B 完成后另估）

顺序：**血缘语义边 → 摘要模型 → 动态路由 → 评估面板**

- 血缘语义边：决策 ↔ 代码实体贯通（依赖批 A 模型选型）
- 摘要模型：**已瘦身**——摘要由底座 compaction 承担（Pi 迭代摘要 / Qoder compact_summary），Thread 只留情节归档的确定性降级链
- 动态模型路由：**已瘦身**——参考 OMP 角色路由模式（default/smol/slow/plan/commit），不自建，按需评估
- 评估面板：线上度量可视化（依赖数据积累）
- 验收：每子项各自回归 + 度量数据对比

> 批 C 前需完成批 A 模型选型的实测（下载 / 内存 / 延迟验证）。

### 底座战略与产品形态（2026-08-14 论证定案）

**背景链**：上下文膨胀治标不治本（压缩有信息密度下限，压无可压）→ 目标架构 = Thread 完全组织每轮上下文（状态卡 + 检索片段 + 近期工具历史，历史重放移除）→ Qoder 底座无此通道（`maxSessionTurns` spike 实测不截断重发）→ SDK wrapper 绕行（每轮新会话）可行但 Qoder 仅剩执行层价值。

**候选底座调研（源码/文档实证）**：

- **earendil-works/pi**（badlogic 出品，MIT，TS 单仓）：三包分离 `pi-ai`（40+ Provider 含 DeepSeek）/ `pi-agent-core`（模型无关运行时）/ `pi-coding-agent`（CLI + 扩展系统）。上下文管理：阈值压缩（窗口-16K 预留触发 → 回合边界切割 → 保留近期 20K → LLM 迭代摘要替换，compaction entry 含文件血缘元数据）；树形会话；**扩展位** = `convertToLlm` 钩子 + compaction 模块整体可替换 + Dynamic Context（官方 RAG/记忆注入位）。裸编码能力：核心循环及格（4 工具基本盘、edit 模糊匹配、截断防御、并行执行），但无 WebSearch/子代理/plan/权限弹窗默认——纯编码任务约中位偏下~中位，综合任务低于中位，靠 Extension 补课。
- **oh-my-pi**（can1357，从 Pi fork，Rust 引擎 ~55k LOC，周更）：电池全包路线——32 工具（LSP/DAP/Hashline/browser/web_search）、40+ provider 角色路由、sub-agent 编排。记忆相关：`mnemopi`（SQLite 知识记忆引擎 remember/recall，可选本地 ONNX embedding + 远程 LLM，确定性兜底——**知识记忆，与 Thread 会话保真不同向**）；`snapcompact`（丢弃历史渲染成 PNG 位图帧让视觉模型读回，确定性零 LLM 调用——**保细节，与 Thread 保结构互补**）；包列表含 `metaharness`（疑似 harness 接入点，待验证）。编码能力中位以上。
- **Qoder CLI**：第一参考适配器与现网狗粮（批 A/B① 已实证三弱能力 + 压缩边界 hook）。

**Thread 定位收敛——会话保真策略层，三条边界**：

- 不做知识记忆（mnemopi/Qoder auto-memory 的地盘，重复即浪费）
- 不做压缩保细节（底座 compaction / snapcompact 的地盘）
- 只做状态结构：目标/决策状态机 + 血缘 + O(1) 状态卡 + 压缩边界 checkpoint

**护城河判断**：不靠速度（can1357 周更产出下时间差无意义），靠**窄而深 + 验证体系**——漏召回/误判/漂移的度量与回归集是保真层命门，追功能的底座不会投入；生态位 = Pi 哲学不内置记忆、OMP 重心在工具链，会话保真是真空缺。

**交付形态——适配器矩阵（主）+ 参考发行版（旗）**：

- 主市场：Thread 适配器 × N 底座（三弱能力即可移植：hook 事件 / 上下文注入 / MCP）——Qoder 适配器已跑通，Claude Code hooks 同构（UserPromptSubmit/Stop/PreCompact + MCP）移植成本低。受众 = 全量长任务编码者，不押注任何底座。
- 旗舰示范：t-pi / t-omp 参考发行版——演示"完全接管"目标架构，做技术旗帜而非唯一产品。t-pi 需预打包补齐件（滑向 OMP 路线）；t-omp 地基现成。**"完全接管"不是保真价值的必要条件**——旁路观测+注入已交付 80% 价值。

**待验证点（批 B 后做双 spike）**：① Pi 扩展位能否不改上游接入（compaction 替换 + Dynamic Context + 事件采集）；② OMP 的 metaharness/snapcompact 可替换性与 Thread 接入点；③ 两底座同任务编码实测（地基打分）。

---

## 1. 二期规划

- 血缘语义边（模型抽取，需先解决质量与评估）
- 动态模型路由（任务分类 → 选模型，失败降级链，预算封顶）
- 会话图谱 ↔ code-review-graph 贯通
- 跨会话记忆检索（决策/反馈跨会话复用，命名空间隔离——事件流水已具备基础；完整作用域设计见 §3）
- 评估面板（线上度量可视化）
- 摘要模型正式化（情节归档、降级链末级）

> TencentDB Agent Memory 可选集成已移出二期（不依赖、不正面竞争，暂缓）。

> MVP 状态注记（跨会话继承）：数据无损——所有接入项目的会话都写入脚本所在仓库（Thread repo）的 `.thread/sms.db`（仅 `session_id` 隔离，项目级命名空间未实现，见 §2），旧会话内容在库中不丢；但**不自动继承**——状态卡按 session 隔离，新窗口开场为空，当前继承通道是模型主动调 `query_session_memory`（缺省查最近活跃会话）。二期实现"新会话自动注入跨会话 active 决策/反馈 + 按项目/会话命名空间隔离"。

## 2. 开放问题（实现前需定）

- 状态卡的确切内容与 token 预算
- 情节分组的规则细节（边界情况）
- 检索重排策略（打分公式）
- 写入管线的存储格式（SQLite / 嵌入式 KV / 文件 + 索引）
- 多会话（跨天/跨项目）的隔离与命名空间——作用域设计已确认（见 §3，二期实施）；当前实现 DB 路径由脚本所在仓库推导，所有项目串库、仅 `session_id` 区分；迁移路径（现网单库 → 用户级库 + 项目库）待定。

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
- **状态卡限额**：低风险软参数——正确性由检索层兜底（不够可 `query_session_memory` 查），限额只影响成本天平（prefill 开销 vs 查询频率）；沿用每区 3~5 条小数值，正式调优由 v1 §9 线上度量驱动，按预算原则而非条数定死。
- **冲突**：项目级覆盖全局级（"这个项目用 yarn" 是全局"都用 pnpm"的例外）；冲突**并列展示 + 标注作用域**，不静默（v1 §6"被标记的冲突"原则）。
- **反馈生命周期**（撤销/覆盖）：与本地模型分类同批实现；MVP 靠冲突展示兜底（改口的两条偏好都显示且带时间戳）。
- **迁移**：现网单一 `.thread/sms.db` → 用户级库 + 项目库的迁移路径待定（见 §2）。
