// 行为契约（MAX 设计 2.1 SOP 正文）——单一来源：批 2 首轮锚定组合包注入 + 批 3 动态 SKILL 注册共用，
// 防两处漂移。per-model 适配（2.1）：初版 default 变体，适配表按狗粮观察增量。
export const THREAD_NORTH_STAR = "Thread 定位北极星：让模型工作质量更高（可靠性向），不是让用户更舒服（体验向）";

export const THREAD_BEHAVIOR_CONTRACT = `# thread（Thread 会话记忆行为契约）
- 需要历史细节/其他会话进展时：调用 query_session_memory 工具查询（ls/cd/cat/grep 导航），不要直查库文件、不要编造
- 收尾时：确认进行中目标沉淀为待办（待确认候选用 /thread-pending 管理）
- 收到只有状态卡无真实提问的消息：一句话确认状态，不当提问作答`;
