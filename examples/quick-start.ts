// Thread minimal example: create a session, persist events, confirm goals/decisions,
// inject the status card, retrieve on demand. Uses a temp dir; nothing is written
// outside it (THREAD_ROOT override).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThreadStore,
  applyAnalysis,
  buildStatusCard,
  queryMemory,
} from "@thread-memory/core";

const dir = mkdtempSync(join(tmpdir(), "thread-example-"));
const projectKey = "demo-project";

const store = new ThreadStore({
  eventsPath: join(dir, "projects", "demo", "events.db"),
  structuredPath: join(dir, "structured.db"),
  projectKey,
});

try {
  const sessionId = "demo-session";
  const now = () => new Date().toISOString();

  // 1. Append events (origin = idempotency key; re-appending the same origin is a no-op).
  store.append(
    { session_id: sessionId, kind: "user_message", ts: now(), body: "帮我实现登录功能" },
    { origin: "demo://msg#1", projectKey },
  );

  // 2. Deterministic lightweight confirmation: user message -> goal (zero LLM).
  applyAnalysis(store, sessionId, { user_msg: "帮我实现登录功能" }, { projectKey });

  store.append(
    { session_id: sessionId, kind: "assistant_message", ts: now(), body: "我记下了使用 JWT 做认证" },
    { origin: "demo://msg#2", projectKey },
  );
  applyAnalysis(store, sessionId, { assistant_msg: "我记下了使用 JWT 做认证" }, { projectKey });

  // 3. Per-turn status card (O(1) resident: goals + active decisions).
  const card = buildStatusCard(store, { sessionId, projectKey, budgetLines: 200 });
  console.log("--- status card ---\n" + card + "\n");

  // 4. Retrieval: semantic (BM25) + structured (O(1) views).
  const hits = queryMemory(store, "JWT 认证", { sessionId });
  console.log("--- semantic recall ---");
  for (const h of hits.results) {
    console.log(`[${h.kind}] ${h.body.slice(0, 80)}`);
  }
  console.log("--- active goals ---");
  for (const g of store.getActiveGoals(sessionId)) {
    console.log(`- ${g.text}`);
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
