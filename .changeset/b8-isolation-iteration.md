---
"@thread/core": minor
"dsh-thread": minor
"@thread/adapter-qoder-cli": minor
---

B⑧ 迭代三项（开放项⑦⑧⑨）：① 隔离指令判定收紧——由"任意位置含隔离/静默等词即触发"改为整条消息 trim 后精确匹配白名单（隔离：/isolate、隔离、开始隔离、进入隔离、临时隔离、静默、免打扰、别打扰；解除：/unisolate、解除隔离、退出隔离、恢复共享；沉淀：/thread-publish <kind> <id> 或自然语言整句），讨论性语句（如"隔离的判定规则是什么"）不再误触发，附回归单测；② 单命令行为契约——状态卡底部新增静态指示行"收到 隔离//unisolate//thread-publish 单命令时，只回一句状态确认，不展开思考"；③ query 工具隔离可观测——queryEvents 事件行输出补 `isolation` 字段，MCP 响应信封带 `session_isolation` 当前状态（消灭验证时直查生产库）。
