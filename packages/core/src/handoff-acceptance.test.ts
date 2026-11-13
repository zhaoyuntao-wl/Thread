import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCloseOutBrief, renderBrief } from "./handoff.js";
import { registerCriteria, verifyCriteria } from "./verification.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-handoff-acceptance-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "accept-proj" });
  store.addGoal("s1", "交付检索层");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("交接带验收状态", () => {
  it("未登记验收条目时交接不出现验收行", () => {
    const brief = buildCloseOutBrief(store, "s1");
    expect(brief.acceptance).toBeUndefined();
    expect(renderBrief(brief)).not.toContain("验收：");
  });

  it("已登记且部分已证时交接写明进度与缺口", () => {
    registerCriteria(store, "accept-proj", [{ key: "unit-tests" }, { key: "lint" }]);
    verifyCriteria(store, { projectKey: "accept-proj", sessionId: "s1", criteria: [{ key: "unit-tests", command: "exit 0" }] });
    const brief = buildCloseOutBrief(store, "s1");
    expect(brief.acceptance).toBe("验收 1/2 已证（缺：lint）");
    expect(renderBrief(brief)).toContain("验收：验收 1/2 已证（缺：lint）");
  });

  it("全部已证时交接写明 2/2", () => {
    registerCriteria(store, "accept-proj", [{ key: "unit-tests" }]);
    verifyCriteria(store, { projectKey: "accept-proj", sessionId: "s1", criteria: [{ key: "unit-tests", command: "exit 0" }] });
    expect(buildCloseOutBrief(store, "s1").acceptance).toBe("验收 1/1 已证");
  });
});
