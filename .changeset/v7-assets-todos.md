---
"@thread-memory/core": minor
"dsh-thread": patch
---

MAX 批 1-4（schema v7/v8 + 听话 + 送达 + 压缩治理）：knowledge_assets（产出登记 + produces/references 写时建边）+ todos（待办）+ thread_meta（跨会话 delta 送达水位）；确定性产出识别（write/edit 类 .md 文档 + report 类报告）；dsh 侧 tool/call 采集补 file_path（arguments 解析）；`/thread-asset` 显式登记命令；首轮锚定组合包（init 锚定 + 行为契约正文 + 状态卡）；收尾自动沉淀（收尾词 → 目标进 todos + 候选归集，幂等）；`/thread-pending` 命令（list/confirm/cancel/defer/cancel-all）；查询原语导航（ls/cd/cat/grep，core navigate() + 统一 runQueryTool，MCP 与 dsh 原生工具共用）；动态 SKILL（ctx.skills.register 注册 thread 行为契约进目录）；状态卡接续块扩展（产出/待办/查更多 + 活跃会话发现层）；跨会话状态 delta（G5：updated_at 补齐 + getStateDelta + 水位注入，dsh pre-step 与 Qoder status-card 双适配器）；三触发送达（首轮锚定 + 压缩后重锚定 + delta，非首轮不再每轮注入状态卡）；压缩后重锚定（compaction/summary → 事件驱动注入 post-compact 卡 + skill 正文）；dsh 主动压缩增强层（可选：THREAD_AUTO_COMPACT 拉活 + compactPressureTokens 阈值 → tokenMeter 监控 + compactNow 静默触发）。
