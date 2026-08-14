import { ThreadStore, applyScopePriority, deriveProjectKey } from "@thread/core";
import { defaultPaths } from "@thread/adapter-qoder-cli";
import { readFileSync } from "node:fs";

let raw;
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}
let hookEvent;
try {
  hookEvent = JSON.parse(raw);
} catch {
  process.exit(0);
}
const sessionId = hookEvent?.session_id;
if (typeof sessionId !== "string" || sessionId.length === 0) {
  process.exit(0);
}

const hookEventName =
  typeof hookEvent?.hook_event_name === "string" ? hookEvent.hook_event_name : "UserPromptSubmit";

const hookCwd = typeof hookEvent?.cwd === "string" ? hookEvent.cwd : process.cwd();
const projectKey = deriveProjectKey(hookCwd);
const paths = defaultPaths(import.meta.url, hookCwd);

let goals = [];
let decisions = [];
let feedback = [];
let recent = [];
try {
  const store = new ThreadStore({ eventsPath: paths.eventsDbPath, structuredPath: paths.structuredDbPath });
  try {
    goals = applyScopePriority(store.getActiveGoalsMerged(sessionId, projectKey));
    decisions = applyScopePriority(store.getActiveDecisionsMerged(sessionId, projectKey));
    feedback = applyScopePriority(store.getFeedbackMerged(sessionId, projectKey, 5));
    recent = store.getRecentEvents(sessionId, 3);
  } finally {
    store.close();
  }
} catch {
  // 状态卡是主路径增强，任何失败都降级为最小卡，绝不阻塞用户消息
}

// 预算分档（adapterParams：Qoder 用户侧注入默认 ≤100 行）；词汇边界：不出现 session/project/scope 等机制词
const BUDGET_LINES = 100;
const shareMark = (row) => (row.scope === "global" ? "（全局）" : row.session_id !== sessionId ? "（来自其他会话）" : "");
const lines = [];
lines.push("[Thread 会话记忆状态卡]");
if (goals.length > 0) {
  lines.push("目标:");
  goals
    .slice()
    .reverse()
    .slice(0, 5)
    .forEach((g, i) => lines.push(`  ${i + 1}. ${g.text.slice(0, 120)}${shareMark(g)}`));
}
if (decisions.length > 0) {
  lines.push("决策（生效中）:");
  decisions.slice(0, 5).forEach((d, i) => lines.push(`  ${i + 1}. ${d.text.slice(0, 120)}${shareMark(d)}`));
}
if (feedback.length > 0) {
  lines.push("偏好:");
  feedback.forEach((f) => {
    const mark = f.scope === "global" ? "（全局）" : f.session_id !== sessionId ? "（来自其他会话）" : "";
    lines.push(`  - ${f.text.slice(0, 120)}${mark}`);
  });
}
if (recent.length > 0) {
  lines.push("最近事件:");
  recent
    .slice()
    .reverse()
    .forEach((e) => lines.push(`  - ${e.kind}: ${e.body.slice(0, 60)}`));
}
lines.push("需要更早的历史细节时，调用 query_session_memory 工具查询。");

const card = lines.slice(0, BUDGET_LINES).join("\n");
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: card } }),
);
