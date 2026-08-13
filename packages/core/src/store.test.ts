import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-"));
  store = new ThreadStore({ path: join(dir, "test.db") });
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
    const hits = store.search("tests");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].session_id).toBe("s1");
  });

  it("filters search by session", () => {
    const hits = store.search("hello", { sessionId: "s2" });
    expect(hits).toHaveLength(0);
  });

  it("starts a new episode on user message", () => {
    store.append({
      session_id: "s1",
      kind: "assistant_message",
      ts: "2026-08-13T00:00:04.000Z",
      body: "ok",
    });
    store.append({
      session_id: "s1",
      kind: "user_message",
      ts: "2026-08-13T00:00:05.000Z",
      body: "next task",
    });
    const ep = store.getActiveEpisode("s1");
    expect(ep?.seq_start).toBe(5);
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
});
