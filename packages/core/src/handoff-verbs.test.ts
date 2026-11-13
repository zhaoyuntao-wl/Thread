import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackHandoff, nextHandoff, proposeHandoff } from "./handoff.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-handoff-verbs-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "verbs-proj" });
  store.addGoal("s1", "交接动词");
  store.addDecision("s1", "决策 X");
});

afterAll(() => {
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
    const again = proposeHandoff(store, "s1", { toRole: "dev", next: ["实现接口"] }, { projectKey: "verbs-proj" });
    expect(store.listHandoffs({ projectKey: "verbs-proj", status: "pending" })).toHaveLength(1);
    expect(again.id).toBe(store.listHandoffs({ projectKey: "verbs-proj", status: "pending" })[0]?.id);
  });

  it("next 按 role 取到结构化 brief，且不改状态", () => {
    const next = nextHandoff(store, { projectKey: "verbs-proj", role: "dev" });
    expect(next?.brief.goal).toContain("交接动词");
    expect(store.getHandoff(next?.handoff.id ?? 0)?.status).toBe("pending");
  });

  it("role 不匹配时 next 返回 null（不误取别人的交接）", () => {
    expect(nextHandoff(store, { projectKey: "verbs-proj", role: "test" })).toBeNull();
  });

  it("ack 推进状态后不再被 next 取到", () => {
    const id = store.listHandoffs({ projectKey: "verbs-proj", status: "pending" })[0]?.id ?? 0;
    expect(ackHandoff(store, id)).toBe(true);
    expect(store.getHandoff(id)?.status).toBe("ack");
    expect(nextHandoff(store, { projectKey: "verbs-proj", role: "dev" })).toBeNull();
  });
});
