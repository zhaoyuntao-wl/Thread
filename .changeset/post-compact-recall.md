---
"@thread-memory/core": patch
"@thread/adapter-qoder-cli": patch
---

压缩后记忆有损治理：post-compact 状态卡升级为"先 query_session_memory 回查"硬规则并附库存行（待办/生效决策计数/事件总数）；行为契约默认规则升级（涉及本会话历史/本项目状态默认先查）；query_session_memory 无 target ls 返回目录视图（活跃会话完整 id + 本会话库存）；qoder-cli 工具描述同步。
