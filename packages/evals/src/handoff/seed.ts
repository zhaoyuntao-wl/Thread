import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore, deriveProjectKey, proposeHandoff } from "@thread-memory/core";
import type { arm } from "./score.js";

export interface SeedResult {
  projectKey: string;
  workspace: string;
}

export const TASK_ID = "T-hs";
export const HANDOFF_TASK =
  "你接手一个已在进行中的项目。请只回答两个问题，不要解释、不要执行命令：" +
  "Q1 本项目已定的检索实现方案是什么？（只输出技术名）" +
  "Q2 上一个会话决定你接手后第一步做什么？（一句话）";

export function seedArm(root: string, a: arm): SeedResult {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  // 工作区必须在 git 仓库之外：项目键按"规范化 git 根"解析，放在仓库内会塌成仓库桶，
  // 三臂共用同一桶 → 隔离失效（2026-11-13 实测）。
  const workspace = join(tmpdir(), `thread-handoff-ws-${a}`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const projectKey = deriveProjectKey(workspace);
  if (a === "none") return { projectKey, workspace };

  const store = new ThreadStore({
    eventsPath: join(root, "events.db"),
    structuredPath: join(root, "structured.db"),
    projectKey,
  });
  store.addGoal("analysis-1", "为离线检索选型并交付开发");
  store.addDecision("analysis-1", "条件：本项目必须离线可跑；检索层用 BM25 + FTS5 实现，不引入向量库");
  store.addTodo({ sessionId: "analysis-1", text: "重构检索层（旧计划，尚未确认）", projectKey });
  store.registerAsset({ sessionId: "analysis-1", path: "docs/design/retrieval.md", title: "检索设计" });
  // push 臂：生产者策展「下一步」——记忆里只有旧计划，交接里才有真实决断
  if (a === "push") proposeHandoff(store, "analysis-1", { toRole: "dev", next: ["先跑回归再动检索层"] }, { projectKey, taskId: TASK_ID });
  store.close();
  return { projectKey, workspace };
}
