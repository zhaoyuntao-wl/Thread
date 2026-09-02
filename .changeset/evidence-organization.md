---
"@thread-memory/core": patch
---

检索结果组织（迭代 A，北极星强化）：query_session_memory 返回的证据经确定性组织——近重复去重 + MMR 多样性 top-K + 最新态标注 + 行级截断；chrono 时序加权（近分平局近期优先）；查询命中结构化行时带状态语义置顶（生效/已被取代/已废弃）。queryMemory 默认关闭，产品通道（runQueryTool）默认开启。
