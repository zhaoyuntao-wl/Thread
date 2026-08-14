# Thread 业务设计（v2 流程 / 输入输出 / 操作约束）

## 0. 文档关系与范围

- [v1 设计](./session-memory-system-design.md)：需求与架构权威
- [v2 设计](./session-memory-system-design.md)：二期规划 / 战略 / 产品包络
- [技术设计](./technical-design.md)：代码级设计与约束
- **本文**：业务设计——端到端流程、输入输出契约、用户可见行为、操作约束、配置面。实现必须同时满足本文与技术设计；冲突时先改文档再改代码。

范围：产品包络"做 9 / 不做 4"在运行期的业务形态。

## 1. 端到端业务流程

### 1.1 会话内主流程（Qoder 狗粮基线，其他底座同构）

```
SessionStart（可无采集）
用户提交 UserPromptSubmit
  ├─ capture（异步）：用户消息落库（写时建索引 + 轻确认旁路）
  ├─ status-card（同步）：组装状态卡 → hookSpecificOutput.additionalContext 注入
  └─ 底座组装上下文 = 状态卡 + 底座自身历史
对话循环（每步）
  ├─ PreToolUse → capture（异步）：工具调用落库
  ├─ PostToolUse → capture（异步）：工具结果落库（大正文走 spill）
  └─ 每轮 Stop → capture（异步）：Agent 回复落库（按 uuid 去重）
压缩（manual / auto）
  ├─ PreCompact → 事件流水已是最新（采集持续进行，无需额外接线）
  ├─ 底座压缩 → PostCompact → capture：compact_checkpoint 落库（摘要全文 + trigger/model）
  └─ 压缩后下一条用户消息 → 状态卡自然回归（hookSpecificOutput 不被底座采纳，已实测）
```

### 1.2 压缩流程（保真关键路径）

1. 压缩触发（manual `/compact` / auto 阈值）——底座侧
2. PostCompact hook 载荷含 `compact_summary`（摘要全文）→ capture 写入 `compact_checkpoint` 事件（body=摘要全文，meta=trigger/model）
3. checkpoint 即压缩边界血缘标记：摘要可检索（FTS 分层含 compact_checkpoint）
4. 压缩后首条用户消息 → 状态卡回归（决策/目标/反馈常驻）
5. 细节回拉：用户/Agent 需要被压缩掉的细节 → query_session_memory → expand 回原文

### 1.3 跨会话流程

- **继承**（B③）：新会话开场 → 注入上一项目会话 active 决策 / 全局反馈（最近 N 条）——分层优先级 会话内 > 项目 > 用户 > 全局
- **检索**：query_session_memory(query, [project_key], [limit]) → 证据片段（带引用）
- **交接**（B⑥④）：Stop 时从结构化表拼"会话交接卡"写 `.thread/handoff.md`；新会话开场读取（同项目）

### 1.4 安装接入流程（每底座）

- Qoder：`.qoder/settings.json` 挂 hooks（capture 异步 + status-card 同步）+ `.qoder/settings.local.json` 配 MCP server；`/mcp reload` 或新会话生效
- dsh：`dsh plugin --profile web add dsh-thread`（bundle）或 `--patch thread.cordis.yml`（MCP overlay，零代码）；t-dsh profile 一键
- Claude Code / Codex：MCP 配置 + hooks（同构，批 A 已论证）

### 1.5 升级循环（狗粮）

迭代 Thread → `pnpm build` → 开新会话即用新版本（脚本路径固定，无需改配置）→ 新版本经回归集 + 狗粮验证后再升级基线。

## 2. 输入输出契约

### 2.1 底座 hook 载荷（Qoder 实测字段）

- 公共字段：`session_id` / `transcript_path` / `cwd` / `hook_event_name` / `model` / `trigger` / `custom_instructions`
- UserPromptSubmit：+ 用户消息
- PreToolUse / PostToolUse：+ 工具名 / 入参 / 结果
- Stop：+ transcript_path（Agent 回复正文从尾部提取，按 uuid 去重）
- PostCompact：+ `compact_summary`（摘要全文）/ `trigger ∈ manual|auto`
- 约束：capture 对不可解析载荷**静默失败**（不影响主路径）；字段缺失走默认

### 2.2 capture 写入契约

- 输入：底座事件 JSON（stdin）+ 环境（THREAD_DB 可选，默认项目 `.thread/sms.db`）
- 写入约束：幂等（sourceUuid 去重）/ 截断（SpillPolicy 4K）/ 写时建索引 / 血缘边 / 情节更新——技术设计 §3.1
- 产出：events / episodes / goals / decisions / feedback / lineage_edges / spills / metrics 增量

### 2.3 状态卡输出规范

- 格式：结构化文本（markdown），含 session / 目标（active）/ 决策（active 优先，superseded 折叠）/ 反馈（最近 N）/ 最近事件摘要
- 预算：≤200 行（单轮注入 token 预算）；超预算截断，保留高优先级层
- 注入时机：UserPromptSubmit（每轮）；压缩后自动回归

### 2.4 MCP 工具契约（query_session_memory）

- 输入：`query`（必填，关键词/短语）/ `limit`（默认 20，≤50）/ `token_budget`（默认 4000）/ `session_id`（可选，缺省最近活跃会话）/ `project_key`（可选，B② 后）
- 输出：带证据的片段（命中事件正文 + 引用 origin/spill + 时间戳）；未找到 → not-found 标记 + 追问建议
- 约束：检索不产生模型调用（零成本）；embedding 可选集成不改变契约

### 2.5 检索输出与引用格式

- 命中 = `{ eventId, kind, body, score, origin?, spill? }`
- 引用 = `origin`（`qoder://transcript#uuid` / `dsh://session/event`）或 `spill.ref`；expand 回原文，不可回拉时返回 body + 缺失标记（不静默）

## 3. 用户可见行为

- **状态卡**：每轮注入；用户可感知"Thread 记住了什么"；内容来自结构化表（确定性，非模型生成）
- **轻确认**：旁路发现状态变化 → 对话内自然语言确认（"我记下了方案 A"）→ 用户认可即写入决策清单；漏判不致命（事件流水无损，决策行只是加速器）
- **交接卡**：`.thread/handoff.md`——Stop 时生成，新会话读取；内容 = 目标 / active 决策 / 待办 / 最近反馈
- **错误与降级**：查询失败 → not-found + 建议；库缺失 → 首次运行自动建库；hook 载荷不可解析 → 静默跳过；MCP 不可用 → 状态卡仍注入（注入不依赖查询）
- **反馈通道**：`/feedback` 命令（产品级）

## 4. 操作约束

- **多项目隔离**（B②）：project_key 推导规则 = 仓库根目录 hash（`git rev-parse --show-toplevel` 的规范路径）；查询合并 project + global；非当前项目硬过滤；状态卡合并显示
- **隐私与安全**：全本地 SQLite（WAL）；结构化表无凭证明文；hook 载荷含路径等本地信息不出库；适配器不做任何云端同步（多机同步非 MVP，D 生态 backlog）
- **降级矩阵**：采集失败 → 主路径不受影响（异步）；索引失败 → append 回滚（不产生半索引）；底座注入不采纳（Qoder hookSpecificOutput）→ 状态卡经 UserPromptSubmit 兜底；压缩无 checkpoint → 摘要仅靠底座自身（记录缺漏到 metrics）
- **度量与反馈**：metrics 表埋点（recall_miss / repeat_question / correction / storage_growth）；漏召回/误判记录入回归集场景（狗粮纪律）

## 5. 配置面

| 配置 | 默认 | 位置 |
|---|---|---|
| 采集 hooks | 全挂（异步） | `.qoder/settings.json` |
| 状态卡注入 | 每轮 UserPromptSubmit | 同上 |
| MCP server | stdio | `.qoder/settings.local.json` |
| Spill 阈值 | 4K | core governor 配置 |
| 状态卡预算 | 200 行 | core state-card 配置 |
| 压缩触发 | 底座默认（manual + auto 阈值） | 底座侧配置 |
| THREAD_DB | 项目 `.thread/sms.db` | 环境变量（演练时指向临时库，严禁写生产库） |
