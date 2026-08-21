// 0-f 对照实验共享场景定义（三组脚本同一来源，避免漂移）：
// control-baseline-dsh（无 Thread）/ control-baseline-claude（无 Thread）/ control-thread-dsh（有 Thread）
// 行为型设计：会话1 建立决策/目标/答案（模型主动产出），会话2 无任何记忆提示地"继续干活"，
// 判据 = 会话2 输出中的行为事实保留（沿用前序方案 / 不重复提问 / 记得早期目标）。
export interface ControlScenario {
  id: string;
  title: string;
  session1: string;
  session2: string;
  checks: Array<{ label: string; expect: string[]; forbid?: string[] }>;
}

export const CONTROL_SCENARIOS: ControlScenario[] = [
  {
    id: "decision-chain",
    title: "决策链：认证方案选定后继续实现",
    session1: "实现用户登录功能。先做技术决策：认证方案用 JWT 还是 Session？直接选定一个并说明理由，然后开始实现。",
    session2: "继续实现登录功能。请直接动手写代码，不要重新讨论方案。",
    checks: [
      { label: "沿用前序认证方案（不换方案不重问）", expect: ["jwt", "session"], forbid: ["重新选择", "重新决策", "再选一次", "确认一下"] },
      { label: "继续实现（产出实现行为而非提问）", expect: ["实现", "创建", "编写", "添加", "写", "function", "class"], forbid: ["请问", "你觉得呢", "要不要"] },
    ],
  },
  {
    id: "repeat-question",
    title: "重复提问：存储方案已答后不重复问",
    session1: "实现事件存储功能。数据库选型：用 better-sqlite3，理由是与 Node 集成好。直接开始。",
    session2: "继续做事件存储。开始动手，不要重复确认技术选型。",
    checks: [
      { label: "沿用 better-sqlite3（不换库不重问）", expect: ["better-sqlite3", "sqlite"], forbid: ["用哪个库", "什么数据库", "重新选", "你决定"] },
      { label: "继续实现（产出实现行为）", expect: ["实现", "创建", "编写", "添加", "表", "insert", "database"], forbid: ["请确认", "确认一下", "可以吗"] },
    ],
  },
  {
    id: "goal-retention",
    title: "目标保留：早期目标不被后续任务冲掉",
    session1: "两个任务：1) 搭建项目脚手架（pnpm init + tsconfig）；2) 实现 CI 流水线。都开始做。",
    session2: "实现 CI 流水线。开始动手。",
    checks: [
      { label: "推进 CI（当前任务照做）", expect: ["ci", "流水线", "workflow", "actions", "yaml"], forbid: [] },
      { label: "记得早期脚手架目标（不丢目标）", expect: ["脚手架", "pnpm", "tsconfig", "已经", "完成", "之前"], forbid: [] },
    ],
  },
];

export function pickScenarios(id: string | undefined): ControlScenario[] {
  return id && id !== "all" ? CONTROL_SCENARIOS.filter((s) => s.id === id) : CONTROL_SCENARIOS;
}
