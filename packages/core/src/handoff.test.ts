import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCloseOutBrief, createCloseOutHandoff, parseBrief, pendingHandoffsFor, renderBrief } from "./handoff.js";
import { runQueryTool } from "./query-tool.js";
import { buildStatusCard } from "./status-card.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-handoff-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "handoff-proj" });
  store.addGoal("s1", "完成 handoff 原语");
  store.addDecision("s1", "决策 A：brief 只放指针与摘要（条件：跨 Agent 时）");
  store.addDecision("s1", "决策 B：事件驱动生成");
  store.addDecision("s1", "决策 C：不做调度");
  store.addTodo({ sessionId: "s1", text: "补 close-out 生成", projectKey: "handoff-proj" });
  store.registerAsset({ sessionId: "s1", path: "docs/local/design.md", title: "设计" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("handoff brief 生成", () => {
  it("目标/决策/下一步/产物都从已有状态取，决策按最新截断", () => {
    const brief = buildCloseOutBrief(store, "s1", { maxDecisions: 2 });
    expect(brief.goal).toContain("handoff 原语");
    expect(brief.decisions).toHaveLength(2);
    expect(brief.decisions[0]?.id ?? 0).toBeGreaterThan(brief.decisions[1]?.id ?? 0);
    expect(brief.next.some((t) => t.includes("close-out"))).toBe(true);
    expect(brief.artifacts).toContain("docs/local/design.md");
    expect(brief.conditions.length).toBeGreaterThan(0);
  });

  it("会话没有任何可交接内容时返回 null", () => {
    expect(createCloseOutHandoff(store, "empty-session", { projectKey: "handoff-proj" })).toBeNull();
  });
});

describe("handoff 落库与投递", () => {
  it("生成 pending 交接，并按 project 寻址可查", () => {
    const handoff = createCloseOutHandoff(store, "s1", { projectKey: "handoff-proj" });
    expect(handoff).not.toBeNull();
    expect(handoff?.status).toBe("pending");
    expect(pendingHandoffsFor(store, { projectKey: "handoff-proj" })).toHaveLength(1);
    expect(parseBrief(handoff?.brief_json ?? "{}").decisions.length).toBeGreaterThan(0);
  });

  it("同一会话重复生成幂等（不重复落行）", () => {
    const again = createCloseOutHandoff(store, "s1", { projectKey: "handoff-proj" });
    const rows = store.listHandoffs({ projectKey: "handoff-proj", status: "pending" });
    expect(rows).toHaveLength(1);
    expect(again?.id).toBe(rows[0]?.id);
  });

  it("ack 后状态推进且不再出现在待投递列表", () => {
    const handoff = store.listHandoffs({ projectKey: "handoff-proj", status: "pending" })[0]!;
    expect(store.setHandoffStatus(handoff.id, "ack")).toBe(true);
    expect(store.getHandoff(handoff.id)?.status).toBe("ack");
    expect(store.getHandoff(handoff.id)?.acked_at).toBeTruthy();
    expect(store.listHandoffs({ projectKey: "handoff-proj", status: "pending" })).toHaveLength(0);
  });
});

describe("brief 渲染与查询通道", () => {
  it("渲染文本含目标、决策 id 与查询指针", () => {
    const brief = buildCloseOutBrief(store, "s1");
    const text = renderBrief(brief, 7);
    expect(text).toContain("目标：");
    expect(text).toMatch(/#\d+/);
    expect(text).toContain("kind=handoff id=7");
  });

  it("query_session_memory kind=handoff 可按 id 取结构化 brief", () => {
    const handoff = createCloseOutHandoff(store, "s1", { projectKey: "handoff-proj" });
    const single = runQueryTool(store, { kind: "handoff", target: String(handoff?.id) });
    const parsed = JSON.parse(single.text) as { brief?: { goal?: string } };
    expect(parsed.brief?.goal).toContain("handoff 原语");
  });
});

describe("状态卡", () => {
  it("有待投递交接时库存行披露条数", () => {
    createCloseOutHandoff(store, "s1", { projectKey: "handoff-proj" });
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "handoff-proj" });
    expect(card).toContain("交接（1 条待投递）");
  });
});
