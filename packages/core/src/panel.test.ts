import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPanel } from "./panel.js";
import { proposeHandoff } from "./handoff.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-panel-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "panel-proj" });
  store.addGoal("s1", "把可见性做成只读面板");
  store.addDecision("s1", "条件：只读；面板用纯文本渲染，底座无关");
  const first = store.addDecision("s1", "旧方案：用 Web 面板");
  store.supersedeDecisionById("s1", first.id, "新方案：先做文本面板");
  proposeHandoff(store, "s1", { toRole: "dev", next: ["实现面板"] }, { projectKey: "panel-proj", taskId: "T-panel" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("renderPanel", () => {
  it("五个区块齐全", () => {
    const text = renderPanel(store, { sessionId: "s1" });
    expect(text).toContain("[Thread 面板]");
    expect(text).toContain("目标（1）");
    expect(text).toContain("决策链");
    expect(text).toContain("未决");
    expect(text).toContain("交接（未确认 1）");
    expect(text).toContain("最近事件");
  });

  it("决策链标出取代关系", () => {
    const text = renderPanel(store, { sessionId: "s1" });
    expect(text).toMatch(/\[superseded → #\d+\]/);
    expect(text).toContain("新方案：先做文本面板");
  });

  it("交接显示目标角色与来源会话", () => {
    const text = renderPanel(store, { sessionId: "s1" });
    expect(text).toContain("to dev");
    expect(text).toContain("from s1");
  });

  it("空会话不抛错且明示为空", () => {
    const text = renderPanel(store, { sessionId: "empty-session" });
    expect(text).toContain("（无进行中目标）");
    expect(text).toContain("（无生效决策）");
  });

  it("验收证据每个条目只显示最新一条", () => {
    store.addEvidence({
      projectKey: "panel-proj",
      sessionId: "s1",
      criterion: "lint",
      command: "pnpm lint",
      exit: 1,
      passed: false,
      envFingerprint: "test",
    });
    store.addEvidence({
      projectKey: "panel-proj",
      sessionId: "s1",
      criterion: "lint",
      command: "pnpm lint",
      exit: 0,
      passed: true,
      envFingerprint: "test",
    });
    const text = renderPanel(store, { sessionId: "s1", projectKey: "panel-proj" });
    const lintLines = text.split("\n").filter((line) => line.includes("lint exit="));
    expect(lintLines).toHaveLength(1);
    expect(lintLines[0]).toContain("✓");
  });
});
