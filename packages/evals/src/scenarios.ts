import type { DecisionStatus } from "@thread/core";

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
}

export type ScenarioExpectation =
  | { kind: "goal"; contains: string }
  | { kind: "decision"; contains: string; status: DecisionStatus }
  | { kind: "recall"; query: string; mustContain: string }
  | { kind: "lineage"; file: string; minEdges: number };

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
];
