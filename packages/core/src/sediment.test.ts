import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_TODO_BASIS, sedimentClosingTodos } from "./closing.js";
import { ThreadStore } from "./store.js";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "thread-sediment-"));
  const store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "demo" });
  return { store, dir };
}

describe("sedimentClosingTodos（收尾自动沉淀，1.2）", () => {
  it("active goals → todos（text 带未完成标记，basis=goal:<id>）", () => {
    const { store, dir } = makeStore();
    try {
      store.addGoal("s1", "完成批 2", { projectKey: "demo" });
      const result = sedimentClosingTodos(store, "s1", { projectKey: "demo" });
      expect(result.goalTodosCreated).toBe(1);
      const todos = store.listTodos({ sessionId: "s1" });
      expect(todos).toHaveLength(1);
      expect(todos[0].text).toBe("完成批 2（未完成）");
      expect(todos[0].basis).toBe("goal:1");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等：重复沉淀不产生重复 todo", () => {
    const { store, dir } = makeStore();
    try {
      store.addGoal("s1", "目标 A", { projectKey: "demo" });
      sedimentClosingTodos(store, "s1", { projectKey: "demo" });
      const again = sedimentClosingTodos(store, "s1", { projectKey: "demo" });
      expect(again.goalTodosCreated).toBe(0);
      expect(again.goalTodosSkipped).toBe(1);
      expect(store.listTodos({ sessionId: "s1" })).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pending 候选归集 todo（每会话一条，basis=/thread-pending）", () => {
    const { store, dir } = makeStore();
    try {
      store.addPendingCandidate({ sessionId: "s1", text: "候选决策", kind: "decision", projectKey: "demo" });
      const result = sedimentClosingTodos(store, "s1", { projectKey: "demo" });
      expect(result.pendingTodoCreated).toBe(true);
      const todo = store.listTodos({ sessionId: "s1", basis: PENDING_TODO_BASIS });
      expect(todo).toHaveLength(1);
      expect(todo[0].text).toContain("1 条");
      // 重复沉淀：pending todo 已存在 → 不再创建
      const again = sedimentClosingTodos(store, "s1", { projectKey: "demo" });
      expect(again.pendingTodoCreated).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无候选 → 不产生 pending todo", () => {
    const { store, dir } = makeStore();
    try {
      const result = sedimentClosingTodos(store, "s1", { projectKey: "demo" });
      expect(result.pendingTodoCreated).toBe(false);
      expect(store.listTodos({ sessionId: "s1" })).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
