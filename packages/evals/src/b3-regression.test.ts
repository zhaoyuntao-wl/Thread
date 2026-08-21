import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScopePriority, ThreadStore } from "@thread-memory/core";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-b3-"));
  store = new ThreadStore({ eventsPath: join(dir, "b3-events.db"), structuredPath: join(dir, "b3-structured.db"), projectKey: "proj-inherit" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("B③ 回归：跨会话自动继承（轻量版）", () => {
  it("新会话开场合并视图继承上一项目会话的 active 决策与全局反馈", () => {
    // 会话 A（旧）：建立 project 级决策 + 全局反馈
    store.addDecision("old-s1", "本项目用 pnpm 管理依赖", {
      scope: "project",
      projectKey: "proj-inherit",
      origin: "eval://b3/dec/1",
      ts: "2026-08-14T00:00:00.000Z",
    });
    store.addFeedback("old-s1", "全局偏好：测试用 vitest", "preference", {
      scope: "global",
      origin: "eval://b3/fb/1",
      ts: "2026-08-14T00:00:02.000Z",
    });

    // 会话 B（新，同项目）：开场即继承
    const decisions = store.getActiveDecisionsMerged("new-s1", "proj-inherit");
    const feedback = store.getFeedbackMerged("new-s1", "proj-inherit", 5);

    expect(decisions.some((d) => d.text.includes("pnpm"))).toBe(true);
    expect(decisions.some((d) => d.session_id === "new-s1")).toBe(false);
    expect(feedback.some((f) => f.text.includes("vitest") && f.scope === "global")).toBe(true);
  });

  it("继承内容经分层优先级裁决：project 特例覆盖 global 同事实", () => {
    store.addFeedback("old-s1", "包管理用 pnpm", "preference", {
      scope: "global",
      origin: "eval://b3/fb/2",
      ts: "2026-08-14T00:00:03.000Z",
    });
    store.addFeedback("old-s2", "包管理用 pnpm", "preference", {
      scope: "project",
      projectKey: "proj-inherit",
      origin: "eval://b3/fb/3",
      ts: "2026-08-14T00:00:04.000Z",
    });

    const merged = store.getFeedbackMerged("new-s2", "proj-inherit", 10);
    const deduped = applyScopePriority(merged);
    const pnpmRows = deduped.filter((f) => f.text.includes("pnpm"));
    expect(pnpmRows).toHaveLength(1);
    expect(pnpmRows[0].scope).toBe("project");
  });

  it("本会话新决策不挤掉继承内容，且当前会话默认 project 级成为后续会话的继承源", () => {
    store.addDecision("new-s3", "本会话提出用 pnpm", {
      projectKey: "proj-inherit",
      origin: "eval://b3/dec/2",
      ts: "2026-08-14T00:00:05.000Z",
    });
    const later = store.getActiveDecisionsMerged("future-s1", "proj-inherit");
    expect(later.some((d) => d.text.includes("本会话提出用 pnpm"))).toBe(true);
  });
});
