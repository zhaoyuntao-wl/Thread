import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastInjection, recordInjection } from "./receipt.js";
import { renderPanel } from "./panel.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-receipt-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "receipt-proj" });
  store.addGoal("s1", "回执");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("注入回执", () => {
  it("没有记录时返回 undefined", () => {
    expect(lastInjection(store, "s1")).toBeUndefined();
  });

  it("记录后可读回 kind/summary/ts", () => {
    recordInjection(store, "s1", { kind: "handoff", summary: "交接 #1 → dev", ts: "2026-11-13T00:00:00.000Z" });
    expect(lastInjection(store, "s1")).toEqual({ kind: "handoff", summary: "交接 #1 → dev", ts: "2026-11-13T00:00:00.000Z" });
  });

  it("后一次覆盖前一次（回执只保留最近一次）", () => {
    recordInjection(store, "s1", { kind: "status-card", summary: "旧卡" });
    recordInjection(store, "s1", { kind: "handoff", summary: "新交接" });
    expect(lastInjection(store, "s1")?.summary).toBe("新交接");
  });

  it("坏数据不抛错", () => {
    store.setMeta("injection:s1", "{not json");
    expect(lastInjection(store, "s1")).toBeUndefined();
  });

  it("面板显示本轮注入", () => {
    recordInjection(store, "s1", { kind: "status-card", summary: "状态卡：目标 1 / 决策 2" });
    const text = renderPanel(store, { sessionId: "s1" });
    expect(text).toContain("本轮注入：");
    expect(text).toContain("[status-card] 状态卡：目标 1 / 决策 2");
  });

  it("无回执时面板明示未注入", () => {
    expect(renderPanel(store, { sessionId: "s1" })).toContain("（本会话还没有注入记录）");
  });
});
