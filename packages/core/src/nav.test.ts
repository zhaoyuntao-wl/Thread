import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { navigate } from "./nav.js";
import { ThreadStore } from "./store.js";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "thread-nav-"));
  const store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "demo" });
  return { store, dir };
}

describe("navigate (query primitives ls/cd/cat/grep)", () => {
  it("ls session -> assets + todos", () => {
    const { store, dir } = makeStore();
    try {
      store.registerAsset({ sessionId: "s1", path: "docs/a.md", title: "asset A" });
      store.addTodo({ sessionId: "s1", text: "todo 1" });
      const r = navigate(store, { nav: "ls", target: "s1", viewerSessionId: "s1" });
      expect(r.kind).toBe("list");
      expect(r.items.map((i) => i.type)).toEqual(["asset", "todo"]);
      expect(r.items[0].label).toContain("asset A");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ls asset -> related edges", () => {
    const { store, dir } = makeStore();
    try {
      const ev = store.append({ session_id: "s1", kind: "tool_call", ts: "t", body: "write" });
      const a = store.registerAsset({ sessionId: "s1", path: "docs/a.md", title: "A", sourceEvent: ev.id });
      const r = navigate(store, { nav: "ls", target: String(a.id), viewerSessionId: "s1" });
      expect(r.kind).toBe("list");
      expect(r.items.length).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cat asset -> file content", () => {
    const { store, dir } = makeStore();
    try {
      const file = join(dir, "notes.md");
      writeFileSync(file, "# note title\ncontent body");
      const a = store.registerAsset({ sessionId: "s1", path: file, title: "note title" });
      const r = navigate(store, { nav: "cat", target: String(a.id), viewerSessionId: "s1" });
      expect(r.kind).toBe("content");
      expect(r.items[0].label).toContain("note title");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cat event -> expand body", () => {
    const { store, dir } = makeStore();
    try {
      const ev = store.append({ session_id: "s1", kind: "user_message", ts: "t", body: "hello event" });
      const r = navigate(store, { nav: "cat", target: String(ev.id), viewerSessionId: "s1" });
      expect(r.items[0].label).toContain("hello event");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("grep -> search hits + asset index matches", () => {
    const { store, dir } = makeStore();
    try {
      store.append({ session_id: "s1", kind: "user_message", ts: "t", body: "discuss the login design" });
      store.registerAsset({ sessionId: "s1", path: "docs/login.md", title: "login design doc", projectKey: "demo" });
      const r = navigate(store, { nav: "grep", query: "login", sessionId: "s1", viewerSessionId: "s1" });
      expect(r.kind).toBe("hits");
      expect(r.items.some((i) => i.label.includes("login design doc"))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ls no-target -> directory view（活跃会话完整 id 可作 target + 本会话库存 note）", () => {
    const { store, dir } = makeStore();
    try {
      store.registerAsset({ sessionId: "session-aaaa", path: "docs/a.md", title: "asset A", projectKey: "demo" });
      store.registerAsset({ sessionId: "session-bbbb", path: "docs/b.md", title: "asset B", projectKey: "demo" });
      store.addTodo({ sessionId: "session-aaaa", text: "todo 1", projectKey: "demo" });
      store.addDecision("session-aaaa", "决策一");
      store.append({ session_id: "session-aaaa", kind: "user_message", ts: "t", body: "e1" });
      store.append({ session_id: "session-aaaa", kind: "user_message", ts: "t2", body: "e2" });
      const r = navigate(store, { nav: "ls", viewerSessionId: "session-aaaa" });
      expect(r.kind).toBe("list");
      // 完整 id 出现在条目（截断 id 不可作 target 的缺口）
      expect(r.items.some((i) => i.type === "session" && i.id === "session-bbbb" && i.label.includes("session-bbbb"))).toBe(true);
      expect(r.items.find((i) => i.id === "session-aaaa")?.label.startsWith("★")).toBe(true);
      expect(r.note).toContain("待办 1 条");
      expect(r.note).toContain("生效决策 1 条");
      expect(r.note).toContain("事件 2 条");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ls no-target 且库为空 → 不抛异常，空目录 + 零库存", () => {
    const { store, dir } = makeStore();
    try {
      const r = navigate(store, { nav: "ls", viewerSessionId: "session-zzzz" });
      expect(r.kind).toBe("list");
      expect(r.items).toHaveLength(0);
      expect(r.note).toContain("待办 0 条");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cd path -> asset node", () => {
    const { store, dir } = makeStore();
    try {
      const file = join(dir, "docs", "x.md");
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(file, "# X");
      store.registerAsset({ sessionId: "s1", path: file, title: "X", projectKey: "demo" });
      const r = navigate(store, { nav: "cd", target: file, viewerSessionId: "s1" });
      expect(r.kind).toBe("node");
      expect(r.title).toContain("X");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
