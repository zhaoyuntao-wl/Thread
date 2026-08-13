import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryMemory } from "./query.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-query-"));
  store = new ThreadStore({ path: join(dir, "test.db") });
  store.append({
    session_id: "q1",
    kind: "user_message",
    ts: "2026-08-13T00:00:00.000Z",
    body: "帮我实现登录功能",
  });
  store.append({
    session_id: "q1",
    kind: "tool_call",
    ts: "2026-08-13T00:00:01.000Z",
    body: "创建 auth 模块，使用 bcrypt 加密密码",
    meta: { tool_name: "Write", file_path: "src/auth.ts" },
  });
  store.append({
    session_id: "q1",
    kind: "tool_result",
    ts: "2026-08-13T00:00:02.000Z",
    body: "auth 模块已创建，含 bcrypt 哈希函数",
  });
  store.append({
    session_id: "q2",
    kind: "user_message",
    ts: "2026-08-13T00:00:03.000Z",
    body: "完全无关的内容：今天天气不错",
  });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queryMemory", () => {
  it("returns found with BM25 hits", () => {
    const result = queryMemory(store, "bcrypt 加密", { sessionId: "q1" });
    expect(result.status).toBe("found");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].kind).toBe("tool_call");
  });

  it("returns not-found with actionable note", () => {
    const result = queryMemory(store, "不存在的概念量子咖啡机", { sessionId: "q1" });
    expect(result.status).toBe("not-found");
    expect(result.results).toHaveLength(0);
    expect(result.note).toContain("未检索到");
    expect(result.note).toContain("建议");
  });

  it("filters by session", () => {
    const result = queryMemory(store, "bcrypt", { sessionId: "q2" });
    expect(result.status).toBe("not-found");
  });

  it("respects token budget", () => {
    const small = queryMemory(store, "登录 模块 bcrypt auth", {
      sessionId: "q1",
      tokenBudget: 10,
    });
    const large = queryMemory(store, "登录 模块 bcrypt auth", {
      sessionId: "q1",
      tokenBudget: 4000,
    });
    const smallChars = small.results.reduce((n, r) => n + r.body.length, 0);
    expect(smallChars).toBeLessThanOrEqual(20 * 2 + 64);
    expect(large.results.length).toBeGreaterThanOrEqual(small.results.length);
  });

  it("falls through to not-found when no episode summary exists", () => {
    const result = queryMemory(store, "summary-marker", { sessionId: "q1" });
    expect(result.status).toBe("not-found");
  });
});
