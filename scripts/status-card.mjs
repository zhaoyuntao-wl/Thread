import { ThreadStore } from "@thread/core";
import { defaultDbPath } from "@thread/adapter-qoder-cli";
import { readFileSync } from "node:fs";

const dbPath = defaultDbPath(import.meta.url);

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

let goals = [];
let decisions = [];
let feedback = [];
let recent = [];
try {
  const store = new ThreadStore({ path: dbPath });
  try {
    goals = store.getActiveGoals(sessionId);
    decisions = store.getActiveDecisions(sessionId);
    feedback = store.getFeedback(sessionId, 3);
    recent = store.getRecentEvents(sessionId, 3);
  } finally {
    store.close();
  }
} catch {
  // 状态卡是主路径增强，任何失败都降级为最小卡，绝不阻塞用户消息
}

const lines = [];
lines.push("[Thread 会话记忆状态卡]");
lines.push(`session: ${sessionId}`);
if (goals.length > 0) {
  lines.push("目标:");
  goals
    .slice()
    .reverse()
    .slice(0, 5)
    .forEach((g, i) => lines.push(`  ${i + 1}. ${g.text.slice(0, 120)}`));
}
if (decisions.length > 0) {
  lines.push("决策（生效中）:");
  decisions.slice(0, 5).forEach((d, i) => lines.push(`  ${i + 1}. ${d.text.slice(0, 120)}`));
}
if (feedback.length > 0) {
  lines.push("偏好:");
  feedback.forEach((f) => lines.push(`  - ${f.text.slice(0, 120)}`));
}
if (recent.length > 0) {
  lines.push("最近事件:");
  recent
    .slice()
    .reverse()
    .forEach((e) => lines.push(`  - ${e.kind}: ${e.body.slice(0, 60)}`));
}
lines.push("需要更早的历史细节时，调用 query_session_memory 工具（带上 session_id）。");

const card = lines.join("\n");
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: card } }),
);
