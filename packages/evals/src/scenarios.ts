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
}

export type ScenarioExpectation =
  | { kind: "goal"; contains: string }
  | { kind: "decision"; contains: string; status: DecisionStatus }
  | { kind: "recall"; query: string; mustContain: string }
  | { kind: "lineage"; file: string; minEdges: number }
  | { kind: "compact"; contains: string }
  | { kind: "status-card"; contains: string };

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
];
