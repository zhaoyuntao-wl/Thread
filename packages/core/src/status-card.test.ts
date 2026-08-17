import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusCard } from "./status-card.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-card-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "card-proj" });
  for (let i = 1; i <= 6; i++) {
    store.addGoal("s1", `目标 ${i}`);
    store.proposeDecision("s1", `决策 ${i}`);
    store.confirmLatestProposed("s1");
  }
  store.addFeedback("s1", "偏好 1", "preference");
  store.append({ session_id: "s1", kind: "user_message", ts: new Date().toISOString(), body: "事件 1" });
  store.append({ session_id: "s1", kind: "assistant_message", ts: new Date().toISOString(), body: "事件 2" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildStatusCard（外部借鉴 ①③：首轮加权 + 收束语）", () => {
  it("尾行收束语为绑定式行动引导（③）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    expect(card).toContain("需要更早的历史细节时，调用 query_session_memory 工具查询，并基于结果给出结论。");
  });

  it("首轮档展示更多目标/决策（① 锚点全量）", () => {
    const normal = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    const first = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", firstTurn: true });
    const countOf = (card: string, marker: string) => card.split("\n").filter((l) => l.includes(marker)).length;
    expect(countOf(first, "决策 ")).toBeGreaterThan(countOf(normal, "决策 "));
    expect(countOf(first, "目标 ")).toBeGreaterThan(countOf(normal, "目标 "));
  });

  it("首轮档默认 recent 更多（5 条档）", () => {
    const first = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", firstTurn: true });
    const events = first.split("\n").filter((l) => l.startsWith("  - "));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("隔离 + 首轮组合不降级崩溃", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", isolated: true, firstTurn: true });
    expect(card).toContain("本会话已隔离");
  });
});
