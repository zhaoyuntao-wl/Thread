import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";
import { registerCriteria, verifyCriteria } from "./verification.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-gate-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "gate-proj" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("目标完成门禁", () => {
  it("未登记验收条目时允许完成", () => {
    const goal = store.addGoal("s1", "目标 A");
    expect(store.updateGoalStatus("s1", goal.id, "completed")?.status).toBe("completed");
  });

  it("登记了验收条目但缺证据时拒绝完成，目标保持 active", () => {
    const goal = store.addGoal("s1", "目标 B");
    registerCriteria(store, "gate-proj", [{ key: "unit-tests" }]);
    expect(store.updateGoalStatus("s1", goal.id, "completed")).toBeUndefined();
    expect(store.getActiveGoals("s1").some((g) => g.id === goal.id)).toBe(true);
  });

  it("全部条目已证后允许完成", () => {
    const goal = store.addGoal("s1", "目标 C");
    verifyCriteria(store, { projectKey: "gate-proj", sessionId: "s1", criteria: [{ key: "unit-tests", command: "exit 0" }] });
    expect(store.updateGoalStatus("s1", goal.id, "completed")?.status).toBe("completed");
  });

  it("失败证据不足以放行；补一条通过证据后放行", () => {
    const goal = store.addGoal("s1", "目标 D");
    verifyCriteria(store, { projectKey: "gate-proj", sessionId: "s1", criteria: [{ key: "lint", command: "exit 1" }] });
    expect(store.updateGoalStatus("s1", goal.id, "completed")).toBeUndefined();
    verifyCriteria(store, { projectKey: "gate-proj", sessionId: "s1", criteria: [{ key: "lint", command: "exit 0" }] });
    expect(store.updateGoalStatus("s1", goal.id, "completed")?.status).toBe("completed");
  });

  it("放弃目标不受证据门禁约束", () => {
    const goal = store.addGoal("s1", "目标 E");
    registerCriteria(store, "gate-proj", [{ key: "unit-tests" }]);
    expect(store.updateGoalStatus("s1", goal.id, "abandoned")?.status).toBe("abandoned");
  });
});
