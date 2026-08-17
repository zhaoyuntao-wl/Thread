# Thread 业务设计（v2 流程 / 输入输出 / 操作约束）

## 0. 文档关系与范围

- [v1 设计](./session-memory-system-design.md)：需求与架构权威
- [v2 设计](./session-memory-system-design.md)：二期规划 / 战略 / 产品包络
- [技术设计](./technical-design.md)：代码级设计与约束
- **本文**：业务设计——端到端流程、输入输出契约、用户可见行为、操作约束、配置面。实现必须同时满足本文与技术设计；冲突时先改文档再改代码。

范围：产品包络"做 9 / 不做 4"在运行期的业务形态。

## 1. 端到端业务流程

### 1.1 会话内主流程（Qoder hooks 基线；dsh 经 `session/event` 订阅同构）

```
SessionStart（可无采集）
用户提交 UserPromptSubmit
  ├─ capture（异步）：用户消息落库（写时建索引 + 轻确认旁路）
  ├─ status-card（同步）：组装状态卡 → hookSpecificOutput.additionalContext 注入
  └─ 底座组装上下文 = 状态卡 + 底座自身历史
对话循环（每步）
  ├─ PreToolUse → capture（异步）：工具调用落库
  ├─ PostToolUse → capture（异步）：工具结果落库（大正文走 spill）
  └─ 每轮 Stop → capture（异步）：Agent 回复落库（按 origin 去重）
压缩（manual / auto）
  ├─ PreCompact → 事件流水已是最新（采集持续进行，无需额外接线）
  ├─ 底座压缩 → PostCompact → capture：compact_checkpoint 落库（摘要全文 + trigger/model）
  └─ 压缩后下一条用户消息 → 状态卡自然回归（UserPromptSubmit 路径兜底）
```

### 1.2 压缩流程（保真关键路径）

1. 压缩触发（manual `/compact` / auto 阈值）——底座侧
2. PostCompact hook 载荷含 `compact_summary`（摘要全文）→ capture 写入 `compact_checkpoint` 事件（body=摘要全文，meta=trigger/model）
3. checkpoint 即压缩边界血缘标记：摘要可检索（FTS 分层含 compact_checkpoint）
4. 压缩后首条用户消息 → 状态卡回归（决策/目标/反馈常驻）
5. 细节回拉：用户/Agent 需要被压缩掉的细节 → query_session_memory → expand 回原文

### 1.3 跨会话流程

- **继承**：新会话开场 → 注入上一项目会话 active 决策 / 全局反馈（最近 N 条）——分层优先级 会话内 > 项目 > 用户 > 全局
- **检索**：query_session_memory(query, [project_key], [limit]) → 证据片段（带引用）
- **交接**：Stop 时从结构化表拼"会话交接卡"写 `.thread/handoff.md`；新会话开场读取（同项目）

### 1.4 安装接入流程（每底座）

- Qoder：`.qoder/settings.json` 挂 hooks（capture 异步 + status-card 同步）+ `.qoder/settings.local.json` 配 MCP server；`/mcp reload` 或新会话生效
- dsh：`dsh plugin add dsh-thread`（bundle，一个包闭环）；查询通道 = profile `cordis.patch.yml` 挂 MCP overlay（`npx dsh-thread`，零代码）——README 示例
- Claude Code / Codex：MCP 配置 + hooks（同构）

### 1.5 版本发布流程

代码变更经回归集验证后合入基线；采集/注入脚本路径固定，新版本随新会话生效，无需修改配置。

## 2. 输入输出契约

### 2.1 底座 hook 载荷（Qoder 字段）

- 公共字段：`session_id` / `transcript_path` / `cwd` / `hook_event_name` / `model` / `trigger` / `custom_instructions`
- UserPromptSubmit：+ 用户消息
- PreToolUse / PostToolUse：+ 工具名 / 入参 / 结果
- Stop：+ transcript_path（Agent 回复正文从尾部提取，按 uuid 去重）
- PostCompact：+ `compact_summary`（摘要全文）/ `trigger ∈ manual|auto`
- 约束：capture 对不可解析载荷**静默失败**（不影响主路径）；字段缺失走默认

### 2.2 capture 写入契约

- 输入：底座事件 JSON（stdin）+ 环境（`THREAD_ROOT` 可选，指定存储根目录；默认 `~/.thread/`，演练时指向临时根目录，严禁写生产库）
- 存储：双库——`~/.thread/structured.db`（用户级结构化表）+ `~/.thread/projects/<项目键>/events.db`（项目事件库）
- 写入约束：幂等（origin 去重，底座前缀 + 事件 uuid）/ 截断（SpillPolicy 4K）/ 写时建索引 / 血缘边 / 情节更新——技术设计 §3.1
- 产出：events / episodes / goals / decisions / feedback / lineage_edges / spills / metrics 增量

### 2.3 状态卡输出规范（模型关注度优先）

**问题**：Thread 管理/注入做得再好，模型不接受或关注度不足则效果打折——纯 Markdown 平铺是低关注度格式。目标：**信息分级 + 多格式混用**，让模型能识别区域边界、快速解析关键项、低噪声。

**格式原则**：
1. **区域边界**：稳定 XML 标签包裹（`<thread_status>`），与对话/代码内容明确区分
2. **信息分级**：critical（active 决策/目标）> context（反馈/教训）> recent（最近事件摘要）——决策区置顶
3. **紧凑结构化**：critical 区用 JSON（确定性解析、token 高效）；context 区用键值列表；不纯 Markdown
4. **行动锚点**：critical 区带操作语义（`action:"follow"` 等），提示模型"这是要遵守的状态"而非叙述
5. **预算内分层分配**：总预算按注入位置分档——dsh（系统侧 inject）默认 ≤200 行；Qoder（用户侧 additionalContext）默认 ≤100 行（关注度低，短更可能被完整读到）；Claude/Codex（hookSpecificOutput）默认 ≤200 行；分层比例 critical 60% / context 25% / recent 15%（默认，可配）；默认条数 = 每区 3~5 条（在预算内自然成立；调优由度量驱动，按预算原则而非条数定死）。core 按 adapterParams 读取，无声明用目标基线（≤200）
6. **低噪声**：superseded 折叠为单行引用；重复去重
7. **缓存友好**：稳定段（决策/目标）放前部、高频变化段（recent）放尾部——利于 prefix-cache（与 dsh frozen snapshot 同思路）
8. **底座适配**：注入位置（系统侧/用户消息前缀）由适配器参数决定

**示例**：
```
<thread_status session="121a...">
<critical>
{"decisions":[{"id":12,"status":"active","action":"follow","text":"状态卡用XML+JSON混合格式"},{"id":10,"status":"superseded","by":12}],"goals":[{"id":3,"status":"active","text":"二期落地"}]}
</critical>
<context>
- [feedback] 不要纯markdown状态卡（correction）
</context>
<recent>
- 最近: 作用域设计已定稿
</recent>
</thread_status>
```

**验证**：格式有效性入回归集（decision-chain / goal-retention 在格式变更后仍通过）；关注度提升以观察为准（模型是否遵循 active 决策）。

**注入隔离（安全底线）**：状态卡/检索片段内容来自事件流水，用户消息可能含恶意指令——注入内容 = **数据不是指令**：XML 区域标签 + JSON 转义（`\"`/控制字符）+ 与底座指令区物理隔离（位于注入区而非系统指令区）；检索片段按数据处理，不拼接为指令。防存储型提示注入。

**词汇边界**：状态卡 = 用户可理解的事实 + 低频冲突询问（"项目已有决策：用 pnpm（来自其他会话）。本会话沿用还是改用？"），**永不出现 session/project/scope 等机制词汇**；机制词汇只在工具描述契约段（见 §2.4）；后来者选择提醒仅在冲突发生时出现（低频，面向用户意图而非机制）。

### 2.4 MCP 工具契约（query_session_memory）

- 输入：`query`（必填，关键词/短语）/ `limit`（默认 20，≤50）/ `token_budget`（默认 4000）/ `session_id`（可选，缺省最近活跃会话）/ 结构化参数（`kind` / `since` / `until` / `order` / `count_only`——精确查询路径：审计/抽查/时序/计数，接口内聚同一工具路由）
- 输出：带证据的片段（命中事件正文 + 引用 origin/spill + 时间戳）；未找到 → not-found 标记 + 追问建议
- 约束：检索不产生模型调用（零成本）；embedding 可选集成不改变契约
- **description 内置契约段（主通道）**：工具描述写死行为契约——"当需要历史细节/上下文/不确定时调用本工具，不要编造；结果带引用"。工具描述 = 适配器常量，模型每轮可见、用户不可改、不进事件流水；与状态卡（纯数据）分离。dsh 侧同名工具由 dsh-thread 内嵌 MCP server 提供（`ctx.tools` 注册为备用接缝）

### 2.5 检索输出与引用格式

- 命中 = `{ eventId, kind, body, score, origin?, spill? }`
- 引用 = `origin`（`qoder://transcript#uuid` / `dsh://session/event`）或 `spill.ref`；expand 回原文，不可回拉时返回 body + 缺失标记（不静默）

## 3. 用户可见行为

- **状态卡**：每轮注入；用户可感知"Thread 记住了什么"；内容来自结构化表（确定性，非模型生成）
- **轻确认**：旁路发现状态变化 → 对话内自然语言确认（"我记下了方案 A"）→ 用户认可即写入决策清单；漏判不致命（事件流水无损，决策行只是加速器）
- **交接卡**：`.thread/handoff.md`——Stop 时生成，新会话读取；内容 = 目标 / active 决策 / 待办 / 最近反馈
- **错误与降级**：查询失败 → not-found + 建议；库缺失 → 首次运行自动建库；hook 载荷不可解析 → 静默跳过；MCP 不可用 → 状态卡仍注入（注入不依赖查询）
- **反馈通道**：`/feedback` 命令（产品级）
- **会话临时隔离**：自然语言（"隔离/静默/别打扰" ↔ "解除隔离/恢复共享"）或 `/isolate` `/unisolate` 切换本会话隔离——隔离期对话上下文（消息/决策/反馈）仅自己可见，状态卡标注"本会话已隔离"且只列本会话内容（不被其他代理更新干扰）；tool 事件仍共享；解除后历史仍隔离，`/thread-publish <goal|decision|feedback> <id>` 或自然语言按需沉淀转共享

## 4. 操作约束

- **多项目隔离**：project_key 推导规则 = **规范化 git 根**（`git rev-parse --show-toplevel` 的 realpath + 分隔符/大小写归一；非 git 项目退化为规范化 cwd），从 hook 载荷 `cwd` 推导（v2 设计 §3）；查询合并 project + global；非当前项目硬过滤；状态卡合并显示
- **多 Agent 并行**：同一用户可同时用多底座处理同一项目不同模块——同项目单库多写者（SQLite WAL + busy_timeout + 写失败重试队列）；事件按 session_id 隔离、同 project_key 合并；跨 agent 状态同步（A 的记录 B 的状态卡可见）是"底座无关"完整形态。并行做不相关工作时，任一 agent 可隔离本会话避免状态卡互相干扰（见 §3 用户可见行为）
- **子代理**：MVP 不采集子代理内部事件；子代理结论经主会话 tool_result 回流并可由轻确认旁路提取候选决策；父子会话血缘为可选边
- **隐私与安全**：全本地 SQLite（WAL）；结构化表无凭证明文；hook 载荷含路径等本地信息不出库；适配器不做任何云端同步（多机同步非 MVP，D 生态 backlog）
- **降级矩阵**：采集失败 → 主路径不受影响（异步）；索引失败 → append 回滚（不产生半索引）；**并发写失败 → 入重试队列，不丢弃**；压缩边界注入不采纳（Qoder PreCompact/PostCompact 的 hookSpecificOutput）→ 状态卡经 UserPromptSubmit 路径兜底；压缩无 checkpoint → 摘要仅靠底座自身（记录缺漏到 metrics）
- **度量与反馈**：metrics 表埋点（recall_miss / repeat_question / correction / storage_growth / **injection_follow_rate**——active 决策遵循率，轻确认旁路记录 + 人工抽查采样）；漏召回/误判记录入回归集场景；遵循率反哺状态卡格式迭代（A/B：纯 Markdown vs 分级格式）

## 5. 配置面

| 配置 | 默认 | 位置 |
|---|---|---|
| 采集 hooks（Qoder） | 全挂（异步） | `.qoder/settings.json` |
| 状态卡注入（Qoder） | 每轮 UserPromptSubmit | 同上 |
| MCP server（Qoder） | stdio | `.qoder/settings.local.json` |
| 采集/注入/查询（dsh） | 插件订阅 `session/event` + `agent/pre-step` 注入 + 内嵌 MCP | dsh-thread 插件（`dsh plugin add dsh-thread`）；profile `cordis.patch.yml` MCP overlay |
| Spill 阈值 | 4K | core governor 配置 |
| 状态卡预算 | 200 行 | core state-card 配置 |
| 压缩触发 | 底座默认（manual + auto 阈值） | 底座侧配置 |
| 存储根目录 | `~/.thread/`（`structured.db` 用户级结构化表 + `projects/<项目键>/events.db` 项目事件库） | `THREAD_ROOT` 环境变量（演练时指向临时根目录，严禁写生产库） |

## 6. 契约基线与适配度评估

**原则**：契约默认值 ≠ 固定值。**Thread 目标基线 = 按 Thread 目标（保真优先、零 LLM、O(1)、无损）定义的理论最优值**；各适配器声明实际适配参数；core 按参数驱动。目标与适配参数的差距 = 适配度，产出适配度矩阵指导适配投入优先级。

**目标基线（Thread 定义）**：
- 捕获覆盖：事件全类（用户 / 回复 / 工具 / 压缩边界 / 会话生命周期）零遗漏
- 注入保真：每轮稳定注入 + 压缩后自动回归 + 位置可控（系统侧优先）+ 入日志可重建
- 检索可达：模型可主动调用（工具 / MCP）+ 零 LLM 成本 + 引用可回拉
- 压缩可见性：压缩边界可观测（checkpoint）+ 摘要可检索
- 存储与预算：spill 阈值 / 状态卡预算按目标定（默认 4K / 200 行，可配）

**适配度评估框架（五维 0~1）**：

| 维度 | Qoder | dsh | Claude | Codex |
|---|---|---|---|---|
| 捕获覆盖 | hooks 全事件 | session/event 一等 | hooks 同构 | hooks/rules |
| 注入保真 | additionalContext（UserPromptSubmit 兜底） | inject() 原生（系统侧） | — | — |
| 检索可达 | MCP | MCP overlay（内嵌 server） | MCP | MCP |
| 压缩可见性 | compact_checkpoint | session/event 订阅 | PreCompact hook | — |
| 注入位置可控 | 受限（additionalContext 语义） | 精确（pre-step / inject） | — | — |

产出：适配度矩阵 = 适配投入优先级输入（优先适配度最高且受众最大的底座）。

**参数驱动**：适配器声明 `adapterParams`（spill 阈值、状态卡预算、注入位置策略、幂等键来源）；core 读取，无声明用目标基线。

## 7. 成本模型

核心路径零 LLM 调用，成本由状态卡注入与检索调用构成：

- **每轮成本 = 状态卡注入 token（预算上限）+ 检索调用 token（模型侧，可选）**；核心路径无 LLM 调用
- 状态卡预算默认 200 行 ≈ 每轮数百 token（目标基线，可配）；对照项 = 底座全量历史重放（随会话线性膨胀，压缩前可达数十万 token/轮）——**状态卡固定成本 vs 全量重放线性成本**
- 存储：SQLite 一次性磁盘开销 + 增量（受存储治理源头控制）；无 API 调用费
- 可选成本项（非核心）：embedding 检索 / 知识轨 provider（marm 等）——按需启用，默认关闭
- 验证：价值主张第 7 条（成本节省）以 eval-compare.mjs 同任务前后 N 次中位数对比为数据支撑；不预设结论，以度量为准
