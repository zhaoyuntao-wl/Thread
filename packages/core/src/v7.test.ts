import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "thread-v7-"));
  const store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "demo" });
  return { store, dir };
}

describe("knowledge_assets（v7 产出登记 + 写时建边）", () => {
  it("registerAsset 落行 + produces/references 边", () => {
    const { store, dir } = makeStore();
    try {
      const ev = store.append({ session_id: "s1", kind: "tool_call", ts: "2026-08-20T00:00:00.000Z", body: "write" });
      const a = store.registerAsset({ sessionId: "s1", path: "docs/local/design/x.md", title: "设计", sourceEvent: ev.id });
      expect(a.id).toBeGreaterThan(0);
      expect(a.path).toBe("docs/local/design/x.md");
      const edges = store.getRelatedEdges("s1", "asset", a.id);
      const types = edges.map((e) => e.edge_type).sort();
      expect(types).toEqual(["produces", "references"]);
      const produces = edges.find((e) => e.edge_type === "produces");
      expect(produces?.src_type).toBe("session");
      expect(produces?.ref).toBe("s1");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listAssets：sessionId 过滤 + 隔离只对建立会话可见", () => {
    const { store, dir } = makeStore();
    try {
      store.registerAsset({ sessionId: "s1", path: "a.md", title: "A" });
      store.registerAsset({ sessionId: "s1", path: "b.md", title: "B", isolation: true });
      store.registerAsset({ sessionId: "s2", path: "c.md", title: "C" });
      expect(store.listAssets({ sessionId: "s1" })).toHaveLength(2);
      // 隔离语义：查看方可见 isolation=0 的全会话产出 + 自己会话的隔离产出
      expect(store.listAssets({ visibleToSession: "s2" }).map((a) => a.title)).toEqual(["C", "A"]);
      expect(store.listAssets({ visibleToSession: "s1" }).map((a) => a.title)).toEqual(["C", "B", "A"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("显式登记（/thread-asset 路径）：topic/scenario 可带", () => {
    const { store, dir } = makeStore();
    try {
      const a = store.registerAsset({ sessionId: "s1", path: "notes.md", title: "研究笔记", topic: "cordis" });
      expect(store.getAsset(a.id)?.topic).toBe("cordis");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("todos（v7 待办）", () => {
  it("addTodo/listTodos/updateTodoStatus 全链", () => {
    const { store, dir } = makeStore();
    try {
      const t = store.addTodo({ sessionId: "s1", text: "完成批 1", basis: "目标 #1", projectKey: "demo" });
      expect(t.status).toBe("pending");
      expect(store.listTodos({ projectKey: "demo", status: "pending" })).toHaveLength(1);
      expect(store.updateTodoStatus(t.id, "done")).toBe(true);
      expect(store.updateTodoStatus(t.id, "done")).toBe(true);
      expect(store.listTodos({ status: "pending" })).toHaveLength(0);
      expect(store.listTodos({ status: "done" })).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("隔离过滤：visibleToSession 只漏本会话待办", () => {
    const { store, dir } = makeStore();
    try {
      store.addTodo({ sessionId: "s1", text: "公开待办" });
      store.addTodo({ sessionId: "s2", text: "隔离待办", isolation: true });
      expect(store.listTodos({ visibleToSession: "s1" }).map((t) => t.text)).toEqual(["公开待办"]);
      expect(store.listTodos({ visibleToSession: "s2" }).map((t) => t.text)).toEqual(["隔离待办", "公开待办"]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("thread_meta（v7 送达水位，G5 跨会话 delta 判定持久化）", () => {
  it("set/get/覆盖更新", () => {
    const { store, dir } = makeStore();
    try {
      expect(store.getMeta("lastDeltaAt:s1")).toBeUndefined();
      store.setMeta("lastDeltaAt:s1", "2026-08-20T00:00:00.000Z");
      expect(store.getMeta("lastDeltaAt:s1")).toBe("2026-08-20T00:00:00.000Z");
      store.setMeta("lastDeltaAt:s1", "2026-08-20T01:00:00.000Z");
      expect(store.getMeta("lastDeltaAt:s1")).toBe("2026-08-20T01:00:00.000Z");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
