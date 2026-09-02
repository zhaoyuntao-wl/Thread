import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";
import { buildProgressTimeline } from "./progress.js";

describe("buildProgressTimeline（2026-09-02 R2 进展脉络：确定性时间线）", () => {
  it("合并视图：四类结构化行按时间倒序聚合，决策反例带标记", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-prog-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "prog-proj",
    });
    try {
      const d1 = store.addDecision("s1", "方案 A：Session 认证", { projectKey: "prog-proj" });
      store.supersedeDecisionById("s1", d1.id, "方案 B：JWT");
      store.addGoal("s1", "进展脉络落地", { projectKey: "prog-proj" });
      store.registerAsset({ sessionId: "s1", path: "docs/p.md", title: "进展设计", projectKey: "prog-proj" });
      store.addTodo({ sessionId: "s1", text: "部署三刷新", projectKey: "prog-proj" });
      store.addDecision("s2", "另一会话的决策", { projectKey: "prog-proj" });

      const rows = buildProgressTimeline(store, { sessionId: "s1", projectKey: "prog-proj", limit: 10 });
      const types = new Set(rows.map((r) => r.type));
      expect(types).toEqual(new Set(["决策", "目标", "产出", "待办"]));
      expect(rows.some((r) => r.tag === "被取代" && r.text === "方案 A：Session 认证")).toBe(true);
      // 合并视图含其他会话行
      expect(rows.some((r) => r.session_id === "s2" && r.text === "另一会话的决策")).toBe(true);
      // 时间倒序
      const ts = rows.map((r) => r.ts);
      expect([...ts].sort().reverse()).toEqual(ts);
      // limit 生效
      expect(buildProgressTimeline(store, { sessionId: "s1", projectKey: "prog-proj", limit: 2 })).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("隔离视图：只含本会话行", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-prog-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "prog-proj",
    });
    try {
      store.addDecision("s1", "本会话决策", { projectKey: "prog-proj" });
      store.addDecision("s2", "他会话决策", { projectKey: "prog-proj" });
      const rows = buildProgressTimeline(store, { sessionId: "s1", projectKey: "prog-proj", isolated: true });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.session_id === "s1")).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空库不抛异常，返回空数组", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-prog-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "prog-proj",
    });
    try {
      expect(buildProgressTimeline(store, { sessionId: "s-empty" })).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("跨项目零泄漏（2026-09-02 现网修复）：他项目产出/待办不入时间线", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-prog-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "prog-proj",
    });
    try {
      store.addDecision("s1", "本项目决策", { projectKey: "prog-proj" });
      store.registerAsset({ sessionId: "s-other", path: "E:/otherWork/one/报价单.xlsx", title: "铝灯罩报价模板", projectKey: "lamp-proj" });
      store.addTodo({ sessionId: "s-other", text: "联系目标灯厂", projectKey: "lamp-proj" });
      const rows = buildProgressTimeline(store, { sessionId: "s1", projectKey: "prog-proj", limit: 20 });
      expect(rows.some((r) => r.text.includes("铝灯罩"))).toBe(false);
      expect(rows.some((r) => r.text.includes("灯厂"))).toBe(false);
      expect(rows.some((r) => r.text.includes("本项目决策"))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
