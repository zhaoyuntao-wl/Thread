import { ThreadStore, buildStatusCard, deriveProjectKey, defaultPaths } from "@thread-memory/core";
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
const paths = defaultPaths(hookCwd);

let card = "[Thread 会话记忆状态卡]";
try {
  const store = new ThreadStore({ eventsPath: paths.eventsDbPath, structuredPath: paths.structuredDbPath });
  try {
    card = buildStatusCard(store, { sessionId, projectKey, budgetLines: 100, isolated: store.getSessionIsolation(sessionId) });
  } finally {
    store.close();
  }
} catch {
  // 状态卡是主路径增强，任何失败都降级为最小卡，绝不阻塞用户消息
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: card } }),
);
