import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScopePriority, ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "test-proj" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ThreadStore", () => {
  it("appends events with per-session sequence", () => {
    const e1 = store.append({
      session_id: "s1",
      kind: "user_message",
      ts: "2026-08-13T00:00:00.000Z",
      body: "hello",
    });
    const e2 = store.append({
      session_id: "s1",
      kind: "tool_call",
      ts: "2026-08-13T00:00:01.000Z",
      body: "run tests",
    });
    const e3 = store.append({
      session_id: "s2",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "hi",
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(1);
  });

  it("truncates oversized bodies and marks them", () => {
    const big = "x".repeat(200_000);
    const e = store.append({
      session_id: "s1",
      kind: "tool_result",
      ts: "2026-08-13T00:00:03.000Z",
      body: big,
    });
    expect(e.truncated).toBe(true);
    expect(e.body.length).toBeLessThan(big.length);
  });

  it("indexes on write and searches with BM25", () => {
    store.append({
      session_id: "s1",
      kind: "user_message",
      ts: "2026-08-13T00:00:03.000Z",
      body: "run the full test suite now",
    });
    const hits = store.search("test");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].session_id).toBe("s1");
  });

  it("does not index tool_call/tool_result (FTS layering)", () => {
    const before = store.search("bcrypt").length;
    store.append({
      session_id: "s1",
      kind: "tool_call",
      ts: "2026-08-13T00:00:04.000Z",
      body: "创建 auth 模块，使用 bcrypt 加密密码",
    });
    store.append({
      session_id: "s1",
      kind: "tool_result",
      ts: "2026-08-13T00:00:05.000Z",
      body: "auth 模块已创建，含 bcrypt 哈希函数",
    });
    const after = store.search("bcrypt").length;
    expect(after).toBe(before);
  });

  it("filters search by session and hides isolated content from others", () => {
    // 未隔离内容跨会话可见（跨会话继承检索语义）
    const visible = store.search("hello", { sessionId: "s2" });
    expect(visible.length).toBeGreaterThan(0);
    // 隔离内容对其他会话不可见（全链路过滤）
    store.append(
      {
        session_id: "s-iso",
        kind: "user_message",
        ts: "2026-08-13T00:00:06.000Z",
        body: "秘密计划代号红隼",
      },
      { isolation: true },
    );
    const hidden = store.search("红隼", { sessionId: "s2" });
    expect(hidden).toHaveLength(0);
    const self = store.search("红隼", { sessionId: "s-iso" });
    expect(self.length).toBeGreaterThan(0);
  });

  it("starts a new episode on user message", () => {
    const seqBefore = store.append({
      session_id: "s4",
      kind: "tool_call",
      ts: "2026-08-13T00:00:01.000Z",
      body: "step1",
    }).seq;
    const user = store.append({
      session_id: "s4",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "next task",
    });
    const ep = store.getActiveEpisode("s4");
    expect(ep?.seq_start).toBe(user.seq);
    expect(seqBefore).toBe(user.seq - 1);
  });

  it("writes a deterministic summary when an episode closes", () => {
    store.append({
      session_id: "s3",
      kind: "user_message",
      ts: "2026-08-13T00:00:00.000Z",
      body: "使用 sqlite 存储",
    });
    store.append({
      session_id: "s3",
      kind: "tool_call",
      ts: "2026-08-13T00:00:01.000Z",
      body: "init db",
    });
    store.append({
      session_id: "s3",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "继续",
    });
    const ep = store.getLatestEpisodeWithSummary("s3");
    expect(ep?.seq_end).toBe(2);
    expect(ep?.summary).toContain("使用 sqlite 存储");
    expect(ep?.summary).toContain("init db");
  });

  it("parses stored meta back into objects", () => {
    const ev = store.append({
      session_id: "s4",
      kind: "tool_call",
      ts: "2026-08-13T00:00:00.000Z",
      body: "x",
      meta: { tool_name: "Edit", file_path: "src/a.ts" },
    });
    expect(ev.meta).toEqual({ tool_name: "Edit", file_path: "src/a.ts" });
    const recent = store.getRecentEvents("s4", 1);
    expect(recent[0].meta).toEqual({ tool_name: "Edit", file_path: "src/a.ts" });
  });

  it("dedupes by origin (idempotent append)", () => {
    const e1 = store.append(
      {
        session_id: "s5",
        kind: "user_message",
        ts: "2026-08-13T00:00:00.000Z",
        body: "dup test",
      },
      { origin: "qoder://transcript#uuid-1" },
    );
    const e2 = store.append(
      {
        session_id: "s5",
        kind: "user_message",
        ts: "2026-08-13T00:00:00.000Z",
        body: "dup test",
      },
      { origin: "qoder://transcript#uuid-1" },
    );
    expect(e2.id).toBe(e1.id);
    const count = store.eventsDb.prepare("SELECT COUNT(*) AS c FROM events WHERE origin = ?").get("qoder://transcript#uuid-1") as { c: number };
    expect(count.c).toBe(1);
  });

  it("spills oversized bodies with expand recovery", () => {
    const big = "y".repeat(6000);
    const e = store.append(
      {
        session_id: "s5",
        kind: "tool_result",
        ts: "2026-08-13T00:00:01.000Z",
        body: big,
      },
      { spillRef: "transcript#tool-1" },
    );
    expect(e.spilled).toBe(1);
    expect(e.body.length).toBeLessThan(1000);
    const restored = store.expand(e.id);
    expect(restored).toBe(big);
  });

  it("expands non-spilled event body", () => {
    const e = store.append({
      session_id: "s5",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "plain body",
    });
    expect(store.expand(e.id)).toBe("plain body");
  });
});

describe("structured scope (B②-4)", () => {
  it("writes scope/project_key/origin on structured rows", () => {
    const g = store.addGoal("s6", "目标 A", { scope: "session", projectKey: "p1", origin: "o-goal-1", ts: "2026-08-13T00:00:00.000Z" });
    const d = store.proposeDecision("s6", "决策 B", { scope: "project", projectKey: "p1", origin: "o-dec-1", ts: "2026-08-13T00:00:00.000Z" });
    const f = store.addFeedback("s6", "偏好 C", "preference", { scope: "global", origin: "o-fb-1", ts: "2026-08-13T00:00:00.000Z" });
    expect(g.scope).toBe("session");
    expect(g.project_key).toBe("p1");
    expect(g.origin).toBe("o-goal-1");
    expect(d.scope).toBe("project");
    expect(d.project_key).toBe("p1");
    expect(f.scope).toBe("global");
    expect(f.project_key).toBeNull();
  });

  it("dedupes structured writes by origin across sessions", () => {
    const d1 = store.proposeDecision("s6", "同源决策", { scope: "project", projectKey: "p1", origin: "o-dec-same", ts: "2026-08-13T00:00:00.000Z" });
    const d2 = store.proposeDecision("s7", "同源决策不同描述", { scope: "project", projectKey: "p1", origin: "o-dec-same", ts: "2026-08-13T00:00:00.000Z" });
    expect(d2.id).toBe(d1.id);
  });

  it("merged decisions include same-project rows from other sessions, hard-filter others", () => {
    store.proposeDecision("s8", "pnpm 包管理", { scope: "project", projectKey: "proj-x", origin: "o-x-1", ts: "2026-08-13T00:00:00.000Z" });
    store.confirmLatestProposed("s8", { ts: "2026-08-13T00:00:01.000Z" });
    store.proposeDecision("s8", "会话内临时决策", { scope: "session", projectKey: "proj-x", origin: "o-x-2", ts: "2026-08-13T00:00:02.000Z" });
    store.confirmLatestProposed("s8", { ts: "2026-08-13T00:00:03.000Z" });
    store.proposeDecision("s9", "另一项目决策", { scope: "project", projectKey: "proj-y", origin: "o-y-1", ts: "2026-08-13T00:00:04.000Z" });
    store.confirmLatestProposed("s9", { ts: "2026-08-13T00:00:05.000Z" });
    store.proposeDecision("s10", "无关项目", { scope: "project", projectKey: "proj-z", origin: "o-z-1", ts: "2026-08-13T00:00:06.000Z" });
    store.confirmLatestProposed("s10", { ts: "2026-08-13T00:00:07.000Z" });

    const merged = store.getActiveDecisionsMerged("s9", "proj-y");
    const texts = merged.map((d) => d.text);
    expect(texts).toContain("另一项目决策");
    expect(texts).not.toContain("pnpm 包管理");
    expect(texts).not.toContain("会话内临时决策");
    expect(texts).not.toContain("无关项目");
  });

  it("merged goals include same-project rows from other sessions", () => {
    store.addGoal("s8", "重构核心模块", { scope: "project", projectKey: "proj-x", origin: "o-gx-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addGoal("s9", "本会话目标", { scope: "session", projectKey: "proj-y", origin: "o-gy-1", ts: "2026-08-13T00:00:00.000Z" });
    const merged = store.getActiveGoalsMerged("s9", "proj-y");
    expect(merged.map((g) => g.text)).toEqual(["本会话目标"]);
    const x = store.getActiveGoalsMerged("s9", "proj-x");
    expect(x.map((g) => g.text)).toContain("重构核心模块");
  });

  it("merged feedback includes global rows and own-session rows only", () => {
    store.addFeedback("s8", "全局偏好：用 pnpm", "preference", { scope: "global", projectKey: "proj-x", origin: "o-fx-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addFeedback("s9", "项目偏好：用 vitest", "preference", { scope: "project", projectKey: "proj-y", origin: "o-fy-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addFeedback("s10", "他项目偏好", "preference", { scope: "project", projectKey: "proj-z", origin: "o-fz-1", ts: "2026-08-13T00:00:00.000Z" });
    const merged = store.getFeedbackMerged("s9", "proj-y", 10);
    const texts = merged.map((f) => f.text);
    expect(texts).toContain("全局偏好：用 pnpm");
    expect(texts).toContain("项目偏好：用 vitest");
    expect(texts).not.toContain("他项目偏好");
  });

  it("scope defaults to project (先到先得) when not specified", () => {
    const d = store.proposeDecision("s11", "默认项目级决策", { projectKey: "proj-x", ts: "2026-08-13T00:00:00.000Z" });
    expect(d.scope).toBe("project");
    expect(d.project_key).toBe("proj-x");
  });
});

describe("applyScopePriority (B③)", () => {
  it("keeps highest-priority scope for the same normalized text", () => {
    const rows = [
      { id: 1, text: "包管理用 pnpm", scope: "global" },
      { id: 2, text: "包管理用 pnpm。", scope: "project" },
      { id: 3, text: "包管理用 pnpm", scope: "session" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("session");
  });

  it("project overrides global for the same fact (项目特例覆盖全局默认)", () => {
    const rows = [
      { id: 1, text: "用 pnpm", scope: "global" },
      { id: 2, text: "用 pnpm", scope: "project" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("project");
  });

  it("keeps distinct facts regardless of scope", () => {
    const rows = [
      { id: 1, text: "用 pnpm", scope: "global" },
      { id: 2, text: "用 yarn", scope: "project" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(2);
  });

  it("treats missing scope as project (旧行默认)", () => {
    const rows = [
      { id: 1, text: "决策 A", scope: undefined },
      { id: 2, text: "决策 A", scope: "session" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("session");
  });
});
