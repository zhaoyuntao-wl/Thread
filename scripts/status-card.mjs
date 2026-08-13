import { ThreadStore } from "@thread/core";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = process.env.THREAD_DB ?? join(root, ".thread", "sms.db");
const logPath = join(root, ".thread", "status-card.log");

mkdirSync(dirname(dbPath), { recursive: true });
appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), stage: "start" }) + "\n");

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

mkdirSync(dirname(dbPath), { recursive: true });
const store = new ThreadStore({ path: dbPath });
const goals = store.getActiveGoals(sessionId);
const decisions = store.getActiveDecisions(sessionId);
const feedback = store.getFeedback(sessionId, 3);
const recent = store.getRecentEvents(sessionId, 3);
store.close();

const lines = [];
lines.push("[Thread 会话记忆状态卡]");
lines.push(`session: ${sessionId}`);
if (goals.length > 0) {
  lines.push("目标:");
  goals.slice(0, 5).forEach((g, i) => lines.push(`  ${i + 1}. ${g.text.slice(0, 120)}`));
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
const hookEventName =
  typeof hookEvent?.hook_event_name === "string" ? hookEvent.hook_event_name : "UserPromptSubmit";
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: card } }),
);
