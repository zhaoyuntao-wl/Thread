import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackHandoff, nextHandoff, proposeHandoff } from "./handoff.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-handoff-verbs-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "verbs-proj" });
  store.addGoal("s1", "交接动词");
  store.addDecision("s1", "决策 X");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("handoff 三动词", () => {
  it("propose_handoff 以会话状态为底生成交接，并按 to_role 寻址", () => {
    const handoff = proposeHandoff(store, "s1", { toRole: "dev", next: ["实现接口"] }, { projectKey: "verbs-proj" });
    expect(handoff.status).toBe("pending");
    expect(handoff.to_role).toBe("dev");
    const brief = JSON.parse(handoff.brief_json) as { goal: string; next: string[] };
    expect(brief.goal).toContain("交接动词");
    expect(brief.next).toContain("实现接口");
  });

  it("propose_handoff 同目标重复提议幂等", () => {
    const first = proposeHandoff(store, "s1", { toRole: "dev" }, { projectKey: "verbs-proj" });
    const again = proposeHandoff(store, "s1", { toRole: "dev" }, { projectKey: "verbs-proj" });
    expect(store.listHandoffs({ projectKey: "verbs-proj", status: "pending" })).toHaveLength(1);
    expect(again.id).toBe(first.id);
  });

  it("next 领取即 delivered（编排器消费后状态自洽）", () => {
    const created = proposeHandoff(store, "s1", { toRole: "dev" }, { projectKey: "verbs-proj" });
    const next = nextHandoff(store, { projectKey: "verbs-proj", role: "dev" });
    expect(next?.handoff.id).toBe(created.id);
    expect(next?.brief.goal).toContain("交接动词");
    expect(store.getHandoff(created.id)?.status).toBe("delivered");
    expect(store.getHandoff(created.id)?.delivered_at).toBeTruthy();
  });

  it("两个 worker 并发领取不会拿到同一条", () => {
    proposeHandoff(store, "s1", { toRole: "dev", goal: "交接 A" }, { projectKey: "verbs-proj" });
    proposeHandoff(store, "s1", { toRole: "dev", goal: "交接 B" }, { projectKey: "verbs-proj" });
    const first = nextHandoff(store, { projectKey: "verbs-proj", role: "dev" });
    const second = nextHandoff(store, { projectKey: "verbs-proj", role: "dev" });
    const third = nextHandoff(store, { projectKey: "verbs-proj", role: "dev" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.handoff.id).not.toBe(second?.handoff.id);
    expect(third).toBeNull();
  });

  it("role 不匹配时 next 返回 null（不误取别人的交接）", () => {
    proposeHandoff(store, "s1", { toRole: "dev" }, { projectKey: "verbs-proj" });
    expect(nextHandoff(store, { projectKey: "verbs-proj", role: "test" })).toBeNull();
  });

  it("ack 幂等：重复确认仍成功，且不再被 next 取到", () => {
    const created = proposeHandoff(store, "s1", { toRole: "dev" }, { projectKey: "verbs-proj" });
    expect(ackHandoff(store, created.id)).toBe(true);
    expect(ackHandoff(store, created.id)).toBe(true);
    expect(store.getHandoff(created.id)?.status).toBe("ack");
    expect(nextHandoff(store, { projectKey: "verbs-proj", role: "dev" })).toBeNull();
  });

  it("task_id 寻址：只取本任务的交接", () => {
    proposeHandoff(store, "s1", { toRole: "dev" }, { projectKey: "verbs-proj", taskId: "T-1" });
    expect(nextHandoff(store, { projectKey: "verbs-proj", role: "dev", taskId: "T-2" })).toBeNull();
    const claimed = nextHandoff(store, { projectKey: "verbs-proj", role: "dev", taskId: "T-1" });
    expect(claimed?.handoff.task_id).toBe("T-1");
  });
});
