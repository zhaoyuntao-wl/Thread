import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusCard, detectSituation } from "./status-card.js";
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

  it("行尾带行 id（① 治理可见性：目标/决策/偏好均可定位）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    expect(card).toMatch(/决策 1 #\d+/);
    expect(card).toMatch(/目标 \d+ #\d+/);
    expect(card).toMatch(/偏好 1 #\d+/);
  });
});

describe("detectSituation（§1.5 P0 情境判定，程序确定性）", () => {
  it("首轮且会话有历史 → new-session", () => {
    expect(detectSituation(store, { sessionId: "s1", turn: 1 })).toBe("new-session");
  });

  it("首轮且会话无历史（全新会话）→ normal", () => {
    expect(detectSituation(store, { sessionId: "brand-new", turn: 1 })).toBe("normal");
  });

  it("最近事件含 compact_checkpoint → post-compact", () => {
    store.append({
      session_id: "s1",
      kind: "compact_checkpoint",
      ts: new Date().toISOString(),
      body: "摘要全文",
    });
    expect(detectSituation(store, { sessionId: "s1", turn: 5 })).toBe("post-compact");
  });

  it("无 checkpoint → normal", () => {
    expect(detectSituation(store, { sessionId: "brand-new", turn: 5 })).toBe("normal");
  });
});

describe("buildStatusCard 情境传达块（§1.5 P0 C+A）", () => {
  it("new-session 情境出现会话接续块（含沿用决策）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "new-session" });
    expect(card).toContain("会话接续");
    expect(card).toContain("生效决策");
    expect(card).toContain("基于以上继续");
  });

  it("post-compact 情境出现压缩回归块（目标重述）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "post-compact" });
    expect(card).toContain("压缩后回归");
    expect(card).toContain("主线目标不变");
  });

  it("normal 情境不出现传达块（避免每轮塞指令）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "normal" });
    expect(card).not.toContain("会话接续");
    expect(card).not.toContain("压缩后回归");
  });

  it("隔离 + new-session 组合不出现续接块（隔离不继承）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "new-session", isolated: true });
    expect(card).not.toContain("会话接续");
    expect(card).toContain("本会话已隔离");
  });
});
