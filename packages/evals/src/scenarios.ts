import type { DecisionStatus } from "@thread-memory/core";

export interface ScenarioTool {
  name: string;
  file_path?: string;
  input: Record<string, unknown>;
  output?: string;
}

export interface ScenarioTurn {
  user?: string;
  assistant?: string;
  tool?: ScenarioTool;
  compact?: string;
  // 双代理 delta 场景：true = 事件路由到兄弟会话（他代理），false/缺省 = 主会话
  other?: boolean;
  // 收尾沉淀场景：该轮用户消息为收尾词 → 触发 sedimentClosingTodos
  sediment?: boolean;
}

export type ScenarioExpectation =
  | { kind: "goal"; contains: string }
  | { kind: "decision"; contains: string; status: DecisionStatus }
  | { kind: "recall"; query: string; mustContain: string }
  | { kind: "lineage"; file: string; minEdges: number }
  | { kind: "compact"; contains: string }
  | { kind: "status-card"; contains: string }
  | { kind: "asset"; contains: string }
  | { kind: "asset-edge"; minEdges: number }
  | { kind: "todo"; contains: string }
  | { kind: "todo-count"; count: number }
  | { kind: "nav"; nav: "ls" | "cd" | "cat" | "grep"; target?: string; query?: string; contains: string }
  | { kind: "delta"; contains: string }
  | { kind: "card-situation"; situation: "new-session" | "post-compact"; contains: string };

export interface Scenario {
  id: string;
  title: string;
  turns: ScenarioTurn[];
  expectations: ScenarioExpectation[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "decision-chain",
    title: "长任务决策链：认证方案演进与撤销",
    turns: [
      { user: "帮我实现用户登录功能" },
      { assistant: "我记下了使用 JWT 做认证" },
      { user: "好的" },
      { tool: { name: "Write", file_path: "src/auth.ts", input: { file_path: "src/auth.ts", content: "jwt sign" }, output: "已创建 src/auth.ts（JWT 认证）" } },
      { user: "改用 Session 吧" },
      { tool: { name: "Edit", file_path: "src/auth.ts", input: { file_path: "src/auth.ts" }, output: "已改为 Session 认证" } },
      { user: "以后密码统一用 bcrypt 加密" },
    ],
    expectations: [
      { kind: "goal", contains: "登录" },
      { kind: "decision", contains: "JWT", status: "superseded" },
      { kind: "decision", contains: "Session", status: "active" },
      { kind: "recall", query: "Session 认证", mustContain: "Session" },
      { kind: "recall", query: "bcrypt 加密", mustContain: "bcrypt" },
      { kind: "lineage", file: "src/auth.ts", minEdges: 2 },
    ],
  },
  {
    id: "goal-retention",
    title: "目标保留：早期目标不被后续任务冲掉",
    turns: [
      { user: "帮我搭建项目脚手架" },
      { tool: { name: "Bash", input: { command: "pnpm init" }, output: "package.json 已创建" } },
      { user: "再帮我实现 CI 流水线" },
      { assistant: "我记下了 CI 用 GitHub Actions" },
      { user: "嗯" },
      { tool: { name: "Write", file_path: ".github/workflows/ci.yml", input: { file_path: ".github/workflows/ci.yml" }, output: "CI 已配置" } },
    ],
    expectations: [
      { kind: "goal", contains: "脚手架" },
      { kind: "goal", contains: "CI" },
      { kind: "decision", contains: "GitHub Actions", status: "active" },
      { kind: "recall", query: "GitHub Actions", mustContain: "GitHub Actions" },
    ],
  },
  {
    id: "repeat-question",
    title: "重复提问防护：已答信息可检索召回",
    turns: [
      { user: "数据库用 SQLite，用 better-sqlite3" },
      { assistant: "我记下了存储用 better-sqlite3" },
      { user: "好的" },
      { user: "帮我实现事件存储" },
      { tool: { name: "Write", file_path: "src/store.ts", input: { file_path: "src/store.ts" }, output: "事件存储已实现" } },
      { user: "存储层用什么库来着" },
    ],
    expectations: [
      { kind: "decision", contains: "better-sqlite3", status: "active" },
      { kind: "recall", query: "better-sqlite3", mustContain: "better-sqlite3" },
      { kind: "recall", query: "事件存储", mustContain: "事件存储" },
    ],
  },
  {
    id: "file-lineage",
    title: "文件血缘：同一文件多次改动可回溯",
    turns: [
      { user: "帮我重构 src/auth.ts 的登录逻辑" },
      { tool: { name: "Edit", file_path: "src/auth.ts", input: { file_path: "src/auth.ts" }, output: "登录逻辑已重构" } },
      { tool: { name: "Write", file_path: "src/auth.test.ts", input: { file_path: "src/auth.test.ts" }, output: "添加了登录测试" } },
      { user: "验证一下 auth 模块" },
    ],
    expectations: [
      { kind: "recall", query: "auth 重构", mustContain: "重构" },
      { kind: "lineage", file: "src/auth.ts", minEdges: 1 },
    ],
  },
  {
    id: "compact-fidelity",
    title: "跨压缩保真：压缩边界后决策/目标/细节可回拉",
    turns: [
      { user: "帮我实现用户登录功能" },
      { assistant: "我记下了使用 JWT 做认证" },
      { user: "好的" },
      { tool: { name: "Write", file_path: "src/auth.ts", input: { file_path: "src/auth.ts" }, output: "JWT 登录已实现" } },
      { user: "再帮我实现注册功能，密码统一用 bcrypt" },
      { assistant: "我记下了密码用 bcrypt 加密" },
      { user: "好的" },
      { compact: "摘要：已实现登录与注册。决策：JWT 认证 active、bcrypt 加密 active。目标：登录、注册。工具：src/auth.ts。" },
      { user: "改用 Session 吧" },
      { user: "好的" },
    ],
    expectations: [
      { kind: "decision", contains: "JWT", status: "active" },
      { kind: "decision", contains: "Session", status: "active" },
      { kind: "decision", contains: "bcrypt", status: "superseded" },
      { kind: "goal", contains: "注册" },
      { kind: "compact", contains: "bcrypt" },
      { kind: "recall", query: "bcrypt 加密", mustContain: "bcrypt" },
    ],
  },
  {
    id: "injection-follow",
    title: "注入遵循前置：状态卡覆盖 active 决策/目标/偏好（模型每轮可见）",
    turns: [
      { user: "帮我实现 API 网关" },
      { assistant: "我记下了网关用 Kong 实现" },
      { user: "好的" },
      { user: "以后测试都用 vitest 写" },
      { user: "嗯" },
    ],
    expectations: [
      { kind: "decision", contains: "Kong", status: "active" },
      { kind: "goal", contains: "网关" },
      { kind: "status-card", contains: "Kong" },
      { kind: "status-card", contains: "vitest" },
      { kind: "recall", query: "Kong 网关", mustContain: "Kong" },
    ],
  },
  {
    id: "asset-pipeline",
    title: "产出识别管线：write/edit .md → knowledge_assets + 写时建边（produces/references）",
    turns: [
      { user: "写一份 v3 设计文档" },
      { tool: { name: "write", file_path: "docs/local/design/v3.md", input: { file_path: "docs/local/design/v3.md", content: "# 设计 v3\n正文" }, output: "已写入" } },
    ],
    expectations: [
      { kind: "asset", contains: "设计 v3" },
      { kind: "asset-edge", minEdges: 2 },
    ],
  },
  {
    id: "closing-sediment",
    title: "收尾自动沉淀：收尾词 → 目标进 todos（幂等，重复收尾不重复）",
    turns: [
      { user: "帮我实现批 5 验证" },
      { assistant: "我记下了目标：完成批 5 验证" },
      { user: "先收了", sediment: true },
      { user: "先收了", sediment: true },
    ],
    expectations: [
      { kind: "todo", contains: "未完成" },
      { kind: "todo-count", count: 1 },
    ],
  },
  {
    id: "nav-primitives",
    title: "查询原语：ls/cat/grep 在关联结构上导航",
    turns: [
      { user: "整理研究笔记" },
      { tool: { name: "write", file_path: "docs/local/research/notes.md", input: { file_path: "docs/local/research/notes.md", content: "# 检索调研\nBM25 中文检索结论" }, output: "ok" } },
    ],
    expectations: [
      { kind: "nav", nav: "ls", contains: "检索调研" },
      { kind: "nav", nav: "grep", query: "研究笔记", contains: "研究笔记" },
      { kind: "nav", nav: "grep", query: "检索调研", contains: "notes.md" },
      { kind: "nav", nav: "cat", target: "docs/local/research/notes.md", contains: "BM25 中文检索" },
    ],
  },
  {
    id: "dual-agent-delta",
    title: "双代理 delta：他代理新决策 → 增量可见（G5，本代理行排除）",
    turns: [
      { user: "主代理开始工作" },
      { user: "我决定登录用 JWT", other: true },
      { assistant: "（他代理记下决策）", other: true },
    ],
    expectations: [
      { kind: "delta", contains: "JWT" },
    ],
  },
  {
    id: "new-session-continuation",
    title: "接续包/发现层：new-session 卡含最近产出/待办/活跃会话",
    turns: [
      { user: "我定了目标：重构核心" },
      { tool: { name: "write", file_path: "docs/local/design/v9.md", input: { file_path: "docs/local/design/v9.md", content: "# 重构方案\n" }, output: "ok" } },
      { user: "先收了", sediment: true },
      { user: "他代理产出调研笔记", other: true },
      { tool: { name: "write", file_path: "docs/local/research/other-notes.md", input: { file_path: "docs/local/research/other-notes.md", content: "# 他代理笔记\n" }, output: "ok" }, other: true },
    ],
    expectations: [
      { kind: "card-situation", situation: "new-session", contains: "最近产出" },
      { kind: "card-situation", situation: "new-session", contains: "待办" },
      { kind: "card-situation", situation: "new-session", contains: "活跃会话" },
    ],
  },
];
