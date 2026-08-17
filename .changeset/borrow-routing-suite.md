---
"@thread/core": minor
"dsh-thread": minor
"@thread/adapter-qoder-cli": minor
---

外部借鉴 dsh-routing-suite（2026-08-15）：① 状态卡首轮加权——会话首请求即锚定轨迹（其 paper 路径承诺实证），`buildStatusCard` 新增 `firstTurn` 档（目标/决策 8 条、recent 5 条），dsh pre-step turn===1 传递，首轮给全量锚点、后续维持轻量 O(1)；② 工具契约段补 few-shot 示例（weak 窗口区分度实证）——两个 MCP server 的 `TOOL_DESCRIPTION` 加 1 条调用示例；③ 收束语绑定行动——状态卡尾行改为"查询并基于结果给出结论"，防纯开放引导（其 deep-think 0% 收敛实证）；④ 注入安全原则写入 technical-design 不变量 #11——注入一律追加 user message，禁止改写/替换底座 section（router amnesia 教训）。附 status-card.test 4 例。
