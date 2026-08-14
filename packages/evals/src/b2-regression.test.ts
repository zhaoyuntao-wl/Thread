import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "@thread/core";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-b2-"));
  store = new ThreadStore({ path: join(dir, "b2.db") });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("B② 回归：作用域过滤零泄漏", () => {
  it("项目 P1 的项目级决策不出现在 P2 的合并视图（零泄漏）", () => {
    store.proposeDecision("p1-s1", "P1 用 pnpm 管理依赖", {
      scope: "project",
      projectKey: "proj-p1",
      origin: "eval://p1/1",
      ts: "2026-08-14T00:00:00.000Z",
    });
    store.confirmLatestProposed("p1-s1", { ts: "2026-08-14T00:00:01.000Z" });

    const p1View = store.getActiveDecisionsMerged("p1-s1", "proj-p1");
    expect(p1View.some((d) => d.text.includes("pnpm"))).toBe(true);

    const p2View = store.getActiveDecisionsMerged("p2-s1", "proj-p2");
    expect(p2View.some((d) => d.text.includes("pnpm"))).toBe(false);

    const noKeyView = store.getActiveDecisionsMerged("p2-s1", undefined);
    expect(noKeyView.some((d) => d.text.includes("pnpm"))).toBe(false);
  });

  it("会话级决策不泄漏给同项目其他会话", () => {
    store.proposeDecision("p1-s2", "本会话临时方案", {
      scope: "session",
      projectKey: "proj-p1",
      origin: "eval://p1/2",
      ts: "2026-08-14T00:00:02.000Z",
    });
    store.confirmLatestProposed("p1-s2", { ts: "2026-08-14T00:00:03.000Z" });

    const other = store.getActiveDecisionsMerged("p1-s1", "proj-p1");
    expect(other.some((d) => d.text.includes("临时方案"))).toBe(false);
  });

  it("全局反馈在所有项目可见，项目反馈只在本项目", () => {
    store.addFeedback("g-s1", "全局偏好：优先 TypeScript", "preference", {
      scope: "global",
      origin: "eval://g/1",
      ts: "2026-08-14T00:00:04.000Z",
    });
    store.addFeedback("p1-s3", "P1 偏好：用 vitest", "preference", {
      scope: "project",
      projectKey: "proj-p1",
      origin: "eval://p1/3",
      ts: "2026-08-14T00:00:05.000Z",
    });

    const p2Fb = store.getFeedbackMerged("p2-s1", "proj-p2", 10);
    expect(p2Fb.some((f) => f.text.includes("TypeScript"))).toBe(true);
    expect(p2Fb.some((f) => f.text.includes("vitest"))).toBe(false);

    const p1Fb = store.getFeedbackMerged("p1-s3", "proj-p1", 10);
    expect(p1Fb.some((f) => f.text.includes("vitest"))).toBe(true);
  });
});

describe("B② 回归：origin 幂等", () => {
  it("事件同源重复写只落一行", () => {
    const base = {
      session_id: "idem-s1",
      kind: "user_message" as const,
      ts: "2026-08-14T00:00:06.000Z",
      body: "幂等验证消息",
    };
    store.append(base, { origin: "eval://idem/1", projectKey: "proj-p1" });
    store.append(base, { origin: "eval://idem/1", projectKey: "proj-p1" });
    const count = store.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE origin = ?")
      .get("eval://idem/1") as { c: number };
    expect(count.c).toBe(1);
  });

  it("结构化写同源重复只落一行（跨会话也不重复）", () => {
    store.proposeDecision("idem-s1", "同源决策", {
      scope: "project",
      projectKey: "proj-p1",
      origin: "eval://idem/dec/1",
      ts: "2026-08-14T00:00:07.000Z",
    });
    store.proposeDecision("idem-s2", "同源决策", {
      scope: "project",
      projectKey: "proj-p1",
      origin: "eval://idem/dec/1",
      ts: "2026-08-14T00:00:08.000Z",
    });
    const count = store.db
      .prepare("SELECT COUNT(*) AS c FROM decisions WHERE origin = ?")
      .get("eval://idem/dec/1") as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("B② 回归：spill 回拉", () => {
  it("超长正文被 spill，命中保留前缀后 expand 回拉全文", () => {
    const deep = "deep-marker-" + "x".repeat(5000) + " 尾部结论";
    const e = store.append(
      {
        session_id: "spill-s1",
        kind: "tool_result",
        ts: "2026-08-14T00:00:09.000Z",
        body: deep,
      },
      { spillRef: "eval://spill/1" },
    );
    expect(e.spilled).toBe(1);
    expect(e.body.length).toBeLessThan(deep.length);
    const restored = store.expand(e.id);
    expect(restored).toBe(deep);
  });

  it("非 spill 事件 expand 返回原正文", () => {
    const e = store.append({
      session_id: "spill-s1",
      kind: "user_message",
      ts: "2026-08-14T00:00:10.000Z",
      body: "普通正文",
    });
    expect(store.expand(e.id)).toBe("普通正文");
  });
});
