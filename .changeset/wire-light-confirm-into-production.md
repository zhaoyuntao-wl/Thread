---
"@thread/core": minor
"@thread/adapter-qoder-cli": minor
---

接通生产链路：capture 内联确定性轻确认（applyAnalysis），用户消息/Agent 回复写入目标/决策/反馈表；Agent 回复正文从 transcript 尾部提取并按 uuid 去重。

core 修复：append 事务化（seq 原子分配）；决策状态机去掉未使用的 confirmed 态（MVP 确认与生效合并，设计文档已同步）；情节闭合时写入确定性摘要，检索降级链 degraded 可达；轻确认正则防误判（"我不确定…"不再提议决策），偏好与决策动作可同条消息并存；目标正则收紧避免问句误入目标表；meta 截断返回一致性。

adapter 修复：file_path 相对 cwd 归一化；路径推导改为向上查找 .git（server/scripts 共用）；MCP server 复用 THREAD_VERSION；status-card 异常防护（失败降级最小卡，绝不阻塞）、目标倒序展示、移除调试日志。

测试：adapter ingest 单测（payload 形状/路径归一化/transcript 提取）、core 误判与分支回归、情节摘要与 degraded 降级、capture.mjs 端到端回归（spawn + THREAD_DB 临时库）。
