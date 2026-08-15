import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusCard } from "./status-card.js";
import { queryEvents } from "./query.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-isolation-"));
  store = new ThreadStore({
    eventsPath: join(dir, "events.db"),
    structuredPath: join(dir, "structured.db"),
    projectKey: "proj-iso",
  });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("会话隔离（B⑧）", () => {
  it("写入：对话上下文打隔离标记，tool 事件强制共享", () => {
    const msg = store.append(
      { session_id: "iso-s1", kind: "user_message", ts: "2026-08-15T00:00:00.000Z", body: "隔离会话消息" },
      { isolation: true },
    );
    expect(msg.isolation).toBe(1);
    const tool = store.append(
      { session_id: "iso-s1", kind: "tool_call", ts: "2026-08-15T00:00:01.000Z", body: "改文件", meta: { tool_name: "Write", file_path: "a.ts" } },
      { isolation: true },
    );
    expect(tool.isolation).toBe(0);
  });

  it("结构化写入带隔离标记（决策/反馈），跨会话合并视图过滤", () => {
    store.addFeedback("iso-s1", "隔离会话偏好：用 pnpm", "preference", {
      scope: "project",
      projectKey: "proj-iso",
      isolation: true,
      ts: "2026-08-15T00:00:02.000Z",
    });
    store.proposeDecision("iso-s1", "隔离决策：改用 yarn", {
      scope: "project",
      projectKey: "proj-iso",
      isolation: true,
      ts: "2026-08-15T00:00:03.000Z",
    });
    store.confirmLatestProposed("iso-s1", { ts: "2026-08-15T00:00:04.000Z" });

    // 本会话自己可见
    expect(store.getActiveDecisions("iso-s1").some((d) => d.text.includes("yarn"))).toBe(true);
    // 其他会话（未隔离）看不到隔离内容
    expect(store.getActiveDecisionsMerged("other-s1", "proj-iso").some((d) => d.text.includes("yarn"))).toBe(false);
    expect(store.getFeedbackMerged("other-s1", "proj-iso", 10).some((f) => f.text.includes("pnpm"))).toBe(false);
  });

  it("检索过滤：search / queryEvents / expand 对他人不可见，自己可见", () => {
    store.append(
      { session_id: "iso-s1", kind: "user_message", ts: "2026-08-15T00:00:05.000Z", body: "隔离细节金丝雀编号 8842" },
      { isolation: true },
    );
    expect(store.search("金丝雀", { sessionId: "other-s1" })).toHaveLength(0);
    expect(store.search("金丝雀", { sessionId: "iso-s1" }).length).toBeGreaterThan(0);

    const ev = store.append(
      { session_id: "iso-s1", kind: "user_message", ts: "2026-08-15T00:00:06.000Z", body: "隔离可回拉标记" },
      { isolation: true, spillRef: "iso://spill/1" },
    );
    expect(store.expand(ev.id, { sessionId: "other-s1" })).toContain("隔离内容不可见");
    expect(store.expand(ev.id, { sessionId: "iso-s1" })).toContain("隔离可回拉标记");

    const q = queryEvents(store, { sessionId: "other-s1", kind: "user_message" });
    expect(q.results.some((r) => r.body.includes("金丝雀"))).toBe(false);
    const self = queryEvents(store, { sessionId: "iso-s1", kind: "user_message" });
    expect(self.results.some((r) => r.body.includes("金丝雀"))).toBe(true);
  });

  it("会话隔离状态切换：进入后写入隔离，解除后历史仍隔离、新写共享", () => {
    store.setSessionIsolation("iso-s2", true);
    expect(store.getSessionIsolation("iso-s2")).toBe(true);
    store.append(
      { session_id: "iso-s2", kind: "user_message", ts: "2026-08-15T00:00:07.000Z", body: "隔离期内容" },
      { isolation: store.getSessionIsolation("iso-s2") },
    );
    expect(
      store.eventsDb.prepare(`SELECT isolation FROM events WHERE session_id = 'iso-s2' AND body = '隔离期内容'`).get(),
    ).toEqual({ isolation: 1 });

    store.setSessionIsolation("iso-s2", false);
    expect(store.getSessionIsolation("iso-s2")).toBe(false);
    store.append(
      { session_id: "iso-s2", kind: "user_message", ts: "2026-08-15T00:00:08.000Z", body: "解除后共享内容" },
      { isolation: store.getSessionIsolation("iso-s2") },
    );
    expect(
      store.eventsDb.prepare(`SELECT isolation FROM events WHERE session_id = 'iso-s2' AND body = '解除后共享内容'`).get(),
    ).toEqual({ isolation: 0 });
    // 历史仍隔离：他人检索不到
    expect(store.search("隔离期", { sessionId: "other-s1" })).toHaveLength(0);
  });

  it("沉淀：unisolateRow 后他人可见，supersede replacement 继承隔离标记", () => {
    const d = store.getActiveDecisions("iso-s1").find((x) => x.text.includes("yarn"));
    expect(d).toBeDefined();
    expect(d?.isolation).toBe(1);
    const ok = store.unisolateRow("iso-s1", "decisions", d!.id);
    expect(ok).toBe(true);
    expect(store.getActiveDecisionsMerged("other-s1", "proj-iso").some((x) => x.text.includes("yarn"))).toBe(true);

    // supersede replacement 继承被 supersede 行的隔离标记
    store.proposeDecision("iso-s1", "待替换的隔离决策", {
      scope: "project",
      projectKey: "proj-iso",
      isolation: true,
      ts: "2026-08-15T00:00:09.000Z",
    });
    store.confirmLatestProposed("iso-s1", { ts: "2026-08-15T00:00:10.000Z" });
    const r = store.supersedeLatestActive("iso-s1", "替换后决策", { ts: "2026-08-15T00:00:11.000Z" });
    expect(r?.replacement.isolation).toBe(1);
  });

  it("状态卡：隔离模式只显示本会话内容并标注", () => {
    const card = buildStatusCard(store, { sessionId: "iso-s1", projectKey: "proj-iso", isolated: true });
    expect(card).toContain("本会话已隔离");
    expect(card).toContain("替换后决策");
    expect(card).not.toContain("（来自其他会话）");
    // 非隔离模式状态卡包含已沉淀内容（未隔离继承）
    const normal = buildStatusCard(store, { sessionId: "other-s1", projectKey: "proj-iso" });
    expect(normal).toContain("yarn");
    expect(normal).not.toContain("替换后决策");
  });
});
