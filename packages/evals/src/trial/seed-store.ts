// 给 trial 的临时 THREAD_ROOT 播种：一条"前序会话"写入的决策 + 其源事件（spec §4-1）。
// 臂决定锚：old/new 带 sourceEvent（锚），noanchor 不带。
// 用法：node dist/trial/seed-store.js --root=<THREAD_ROOT> --arm=old|new|noanchor [--project=<key>] [--prior-session=<id>]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ThreadStore, deriveProjectKey, hashProjectKey } from "@thread-memory/core";
import { DECISION_TEXT, SESSION_ID } from "./freeze-card.js";

export interface SeedResult {
  root: string;
  projectKey: string;
  priorSessionId: string;
  eventId: number;
  decisionId: number;
  anchored: boolean;
}

export function seedStore(opts: {
  root: string;
  arm: "old" | "new" | "noanchor";
  project?: string;
  workspace?: string;
  priorSessionId?: string;
}): SeedResult {
  // 项目键必须与 trial 会话工作区一致：MCP 查询通道按进程 cwd 推默认桶，
  // 两边不一致时"查源"会落到空桶（2026-10-07 探针实证）。
  const projectKey = opts.project ?? deriveProjectKey(opts.workspace ?? opts.root);
  const priorSessionId = opts.priorSessionId ?? SESSION_ID;
  const eventsPath = join(opts.root, "projects", hashProjectKey(projectKey), "events.db");
  mkdirSync(join(opts.root, "projects", hashProjectKey(projectKey)), { recursive: true });
  const store = new ThreadStore({ eventsPath, structuredPath: join(opts.root, "structured.db"), projectKey });
  const event = store.append({
    session_id: priorSessionId,
    kind: "user_message",
    ts: new Date().toISOString(),
    body: `请按这条规则处理数据库写入失败：${DECISION_TEXT}`,
  });
  const anchored = opts.arm !== "noanchor";
  const decision = store.addDecision(priorSessionId, DECISION_TEXT, anchored ? { sourceEvent: event.id } : {});
  store.close();
  return { root: opts.root, projectKey, priorSessionId, eventId: event.id, decisionId: decision.id, anchored };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/seed-store.js");
if (isMain) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const root = arg("root");
  const arm = (arg("arm") ?? "new") as "old" | "new" | "noanchor";
  if (!root) throw new Error("--root=<THREAD_ROOT> is required");
  const result = seedStore({ root, arm, project: arg("project"), workspace: arg("workspace"), priorSessionId: arg("prior-session") });
  console.log(JSON.stringify(result, null, 2));
}
