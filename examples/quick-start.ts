// Thread minimal example: create a session, persist events, record a goal and a
// decision through the explicit channels, inject the status card, retrieve on
// demand. Uses a temp dir; nothing is written outside it (THREAD_ROOT override).
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

  // 2. Goal detection (deterministic): short imperative messages become goals.
  applyAnalysis(store, sessionId, { user_msg: "帮我实现登录功能" }, { projectKey });

  // 3. Explicit decision channel: decisions are recorded via commands or the
  // model's record_decision tool — no text heuristics (1.0 behavior).
  store.addDecision(sessionId, "使用 JWT 做认证", { projectKey, ts: now() });

  // 4. Per-turn status card (O(1) resident: goals + active decisions).
  const card = buildStatusCard(store, { sessionId, projectKey, budgetLines: 200 });
  console.log("--- status card ---\n" + card + "\n");

  // 5. Retrieval: semantic (BM25, message events) + structured (O(1) views).
  const hits = queryMemory(store, "登录", { sessionId });
  console.log("--- semantic recall ---");
  for (const h of hits.results) {
    console.log(`[${h.kind}] ${h.body.slice(0, 80)}`);
  }
  console.log("--- active goals / decisions ---");
  for (const g of store.getActiveGoals(sessionId)) {
    console.log(`goal: ${g.text}`);
  }
  for (const d of store.getActiveDecisions(sessionId)) {
    console.log(`decision: ${d.text}`);
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
