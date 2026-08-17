import { ThreadStore, deriveProjectKey, defaultPaths, matchToolFeedback } from "@thread-memory/core";
import { readFileSync } from "node:fs";

// B⑥-② 反馈拦截（Qoder PreToolUse 同步 hook）：命中教训 → exit 2 阻断 + stderr 教训原文。
// 教训从提示升级为强制；任何失败（解析/查询）都放行——拦截是增强，绝不误伤主路径。
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

const toolName = typeof hookEvent?.tool_name === "string" ? hookEvent.tool_name : "";
const sessionId = typeof hookEvent?.session_id === "string" ? hookEvent.session_id : "";
if (!toolName || !sessionId) {
  process.exit(0);
}

const hookCwd = typeof hookEvent?.cwd === "string" ? hookEvent.cwd : process.cwd();
const projectKey = deriveProjectKey(hookCwd);
const paths = defaultPaths(hookCwd);

try {
  const store = new ThreadStore({ eventsPath: paths.eventsDbPath, structuredPath: paths.structuredDbPath, projectKey });
  try {
    const rows = store.getFeedbackMerged(sessionId, projectKey, 50);
    const hit = matchToolFeedback(rows, toolName);
    if (hit) {
      process.stderr.write(`[Thread 反馈拦截] 已拦截工具「${toolName}」——教训（反馈 #${hit.id}）：${hit.text}。请改用其他方式完成，或与用户确认后再执行。\n`);
      process.exit(2);
    }
  } finally {
    store.close();
  }
} catch {
  // 拦截失败放行（增强非门禁）
}
process.exit(0);
