import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStateDelta, renderStateDelta } from "./delta.js";
import { ThreadStore } from "./store.js";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "thread-delta-"));
  const store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "demo" });
  return { store, dir };
}

describe("getStateDelta (G5 cross-session state delta)", () => {
  it("other-session decisions/goals/feedback/candidates hit; own rows excluded", () => {
    const { store, dir } = makeStore();
    try {
      store.proposeDecision("s-a", "decision A", { projectKey: "demo" });
      store.addGoal("s-b", "goal B", { projectKey: "demo" });
      store.addFeedback("s-b", "pref B", "preference", { projectKey: "demo" });
      store.addPendingCandidate({ sessionId: "s-a", text: "candidate C", kind: "decision", projectKey: "demo" });
      store.addGoal("s-me", "my own goal", { projectKey: "demo" });

      const delta = getStateDelta(store, { projectKey: "demo", since: "2020-01-01T00:00:00.000Z", excludeSessionId: "s-me", viewerSessionId: "s-me" });
      expect(delta.decisions.map((d) => d.text)).toEqual(["decision A"]);
      expect(delta.goals.map((g) => g.text)).toEqual(["goal B"]);
      expect(delta.feedback.map((f) => f.text)).toEqual(["pref B"]);
      expect(delta.pending.map((p) => p.text)).toEqual(["candidate C"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("since watermark: older rows don't hit", () => {
    const { store, dir } = makeStore();
    try {
      store.proposeDecision("s-a", "old decision", { projectKey: "demo", ts: "2026-08-19T00:00:00.000Z" });
      const delta = getStateDelta(store, { projectKey: "demo", since: "2026-08-20T00:00:00.000Z", excludeSessionId: "s-me", viewerSessionId: "s-me" });
      expect(delta.decisions).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolation: isolated rows invisible to others (isolated viewer skip is caller-side)", () => {
    const { store, dir } = makeStore();
    try {
      store.proposeDecision("s-iso", "isolated decision", { projectKey: "demo", isolation: true });
      const delta = getStateDelta(store, { projectKey: "demo", since: "2020-01-01T00:00:00.000Z", excludeSessionId: "s-me", viewerSessionId: "s-me" });
      expect(delta.decisions).toHaveLength(0);
      // 隔离查看方的"无跨会话 delta"由调用方判定（viewer 隔离 → 不注入）；本函数只负责写入方过滤
      const viewerIsolated = store.getSessionIsolation("s-iso");
      expect(viewerIsolated).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("status transitions surface via updated_at (goal completed)", () => {
    const { store, dir } = makeStore();
    try {
      const g = store.addGoal("s-a", "goal X", { projectKey: "demo" });
      store.updateGoalStatus("s-a", g.id, "completed");
      const delta = getStateDelta(store, { projectKey: "demo", since: "2020-01-01T00:00:00.000Z", excludeSessionId: "s-me", viewerSessionId: "s-me" });
      expect(delta.goals).toHaveLength(1);
      expect(delta.goals[0].status).toBe("completed");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderStateDelta (2.3.2 format)", () => {
  it("with changes -> headed block", () => {
    const text = renderStateDelta({
      goals: [],
      decisions: [{ id: 3, text: "plan A", session_id: "session-abc12345", updated_at: "t", status: "active" }],
      feedback: [],
      pending: [],
    });
    expect(text).toContain("[Thread");
    expect(text).toContain("plan A");
    expect(text).toContain("abc1234");
  });

  it("empty -> undefined (zero injection)", () => {
    expect(renderStateDelta({ goals: [], decisions: [], feedback: [], pending: [] })).toBeUndefined();
  });
});
