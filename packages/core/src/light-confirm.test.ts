import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTurn, applyAnalysis, applyTurn } from "./light-confirm.js";
import { ThreadStore } from "./store.js";
import { canTransition } from "./state.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-confirm-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "test-proj" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("analyzeTurn", () => {
  it("detects assistant decision declarations", () => {
    expect(analyzeTurn({ assistant_msg: "我记下了方案 A" }).decisions).toEqual([
      { action: "propose", text: "方案 A" },
    ]);
    expect(analyzeTurn({ assistant_msg: "我决定采用 Vite 构建" }).decisions).toEqual([
      { action: "propose", text: "Vite 构建" },
    ]);
  });

  it("detects pure acceptance short replies", () => {
    for (const msg of ["嗯", "好的", "没问题", "收到", "就这样"]) {
      expect(analyzeTurn({ user_msg: msg }).decisions).toEqual([{ action: "confirm" }]);
    }
  });

  it("does not treat qualified replies as acceptance", () => {
    expect(analyzeTurn({ user_msg: "好的，不过我还要想想" }).decisions).toEqual([]);
  });

  it("detects revocations", () => {
    for (const msg of ["不要用 A 库了", "算了", "别用了", "放弃吧", "不用了"]) {
      expect(analyzeTurn({ user_msg: msg }).decisions).toEqual([{ action: "revoke" }]);
    }
  });

  it("detects supersede with replacement text", () => {
    expect(analyzeTurn({ user_msg: "改用 B 库" }).decisions).toEqual([
      { action: "supersede", text: "B 库" },
    ]);
    expect(analyzeTurn({ user_msg: "改成方案 C。" }).decisions).toEqual([
      { action: "supersede", text: "方案 C" },
    ]);
  });

  it("detects goals from imperative messages", () => {
    const analysis = analyzeTurn({ user_msg: "帮我实现登录功能" });
    expect(analysis.goals).toEqual([{ text: "帮我实现登录功能", action: "add" }]);
  });

  it("treats preference sentences as feedback, not revocation", () => {
    const analysis = analyzeTurn({ user_msg: "以后不要用 jQuery" });
    expect(analysis.decisions).toEqual([]);
    expect(analysis.feedback).toEqual([
      { text: "以后不要用 jQuery", kind: "correction" },
    ]);
    const pref = analyzeTurn({ user_msg: "以后优先用 pnpm" });
    expect(pref.feedback).toEqual([{ text: "以后优先用 pnpm", kind: "preference" }]);
  });

  it("captures supersede and preference in the same message", () => {
    const analysis = analyzeTurn({ user_msg: "改成用 Redis，以后都别用 Memcached" });
    expect(analysis.decisions).toEqual([
      { action: "supersede", text: "用 Redis，以后都别用 Memcached" },
    ]);
    expect(analysis.feedback).toEqual([
      { text: "改成用 Redis，以后都别用 Memcached", kind: "correction" },
    ]);
  });

  it("does not declare decisions from negated or unrelated phrases", () => {
    expect(analyzeTurn({ assistant_msg: "我不确定这个方案是否可行" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "我忘记下载依赖包" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "我们还在讨论中" }).decisions).toEqual([]);
  });

  it("does not declare decisions from questions or technical terms", () => {
    expect(analyzeTurn({ assistant_msg: "要我记下这个决策吗？" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "写入确定性摘要，degraded 可达" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "怎么确定当前是哪个项目？" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "这是一个决定性的因素" }).decisions).toEqual([]);
  });

  it("requires first-person subject for bare 决定/确定", () => {
    expect(analyzeTurn({ assistant_msg: "产出直接决定 B/C 怎么做" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "调研结论确定下一步" }).decisions).toEqual([]);
    expect(analyzeTurn({ assistant_msg: "我确定用 Vite" }).decisions).toEqual([
      { action: "propose", text: "用 Vite" },
    ]);
    expect(analyzeTurn({ assistant_msg: "我们已经决定用 pnpm" }).decisions).toEqual([
      { action: "propose", text: "用 pnpm" },
    ]);
    expect(analyzeTurn({ assistant_msg: "我决定采用 Vite 构建" }).decisions).toEqual([
      { action: "propose", text: "Vite 构建" },
    ]);
  });

  it("does not treat questions as goals", () => {
    expect(analyzeTurn({ user_msg: "请问登录怎么做" }).goals).toEqual([]);
    expect(analyzeTurn({ user_msg: "帮我查一下这个错误" }).goals).toEqual([]);
  });

  it("ignores unrelated messages", () => {
    expect(analyzeTurn({ user_msg: "用 A 吧" })).toEqual({ goals: [], decisions: [], feedback: [] });
    expect(analyzeTurn({})).toEqual({ goals: [], decisions: [], feedback: [] });
  });
});

describe("applyTurn", () => {
  it("propose -> confirm -> active", () => {
    applyTurn(store, "s1", { assistant_msg: "我记下了用 Vite" });
    const proposed = store.getLatestProposed("s1");
    expect(proposed?.status).toBe("proposed");
    applyTurn(store, "s1", { user_msg: "嗯" });
    const active = store.getActiveDecisions("s1");
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe("用 Vite");
    expect(active[0].status).toBe("active");
  });

  it("supersede marks the old decision and replaces it", () => {
    const applied = applyTurn(store, "s1", { user_msg: "改用 Webpack" });
    expect(applied.decisions.map((d) => d.text)).toEqual(["用 Vite", "Webpack"]);
    expect(applied.decisions[0].status).toBe("superseded");
    expect(applied.decisions[0].superseded_by).toBe(applied.decisions[1].id);
    expect(applied.decisions[1].status).toBe("active");
  });

  it("revoke ends the latest decision", () => {
    applyTurn(store, "s1", { user_msg: "不要了" });
    expect(store.getActiveDecisions("s1")).toHaveLength(0);
  });

  it("records goals and feedback", () => {
    applyTurn(store, "s1", { user_msg: "帮我重构配置模块" });
    expect(store.getActiveGoals("s1")).toHaveLength(1);
    applyTurn(store, "s1", { user_msg: "以后别用回调" });
    expect(store.getActiveGoals("s1")).toHaveLength(1);
  });

  it("applyAnalysis writes structured rows without appending events", () => {
    const before = store.getRecentEvents("s2", 100).length;
    const ev = store.append({
      session_id: "s2",
      kind: "assistant_message",
      ts: "2026-08-13T00:00:00.000Z",
      body: "我记下了用 pnpm 管理依赖",
    });
    const applied = applyAnalysis(store, "s2", { assistant_msg: "我记下了用 pnpm 管理依赖" }, { sourceEvent: ev.id });
    expect(applied.decisions).toHaveLength(1);
    expect(store.getRecentEvents("s2", 100).length).toBe(before + 1);
  });
});

describe("decision state machine", () => {
  it("allows documented transitions only", () => {
    expect(canTransition("proposed", "active")).toBe(true);
    expect(canTransition("proposed", "revoked")).toBe(true);
    expect(canTransition("active", "superseded")).toBe(true);
    expect(canTransition("active", "revoked")).toBe(true);
    expect(canTransition("superseded", "active")).toBe(false);
    expect(canTransition("revoked", "revoked")).toBe(false);
  });
});
