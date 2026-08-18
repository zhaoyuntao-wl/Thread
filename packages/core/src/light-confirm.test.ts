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
      { action: "propose", text: "方案 A", source: "assistant-declare" },
    ]);
    expect(analyzeTurn({ assistant_msg: "我决定采用 Vite 构建" }).decisions).toEqual([
      { action: "propose", text: "Vite 构建", source: "assistant-declare" },
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
    expect(analysis.decisions).toEqual([]);    expect(analysis.feedback).toEqual([
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
      { action: "propose", text: "用 Vite", source: "assistant-declare" },
    ]);
    expect(analyzeTurn({ assistant_msg: "我们已经决定用 pnpm" }).decisions).toEqual([
      { action: "propose", text: "用 pnpm", source: "assistant-declare" },
    ]);
    expect(analyzeTurn({ assistant_msg: "我决定采用 Vite 构建" }).decisions).toEqual([
      { action: "propose", text: "Vite 构建", source: "assistant-declare" },
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

  it("机制1：用户侧决策宣告 → propose（source=user-declare，§1.5.3c）", () => {
    const a1 = analyzeTurn({ user_msg: "开发基线就定为：标准模式为主" });
    expect(a1.decisions).toEqual([{ action: "propose", text: "标准模式为主", source: "user-declare" }]);
    expect(a1.feedback).toEqual([]);
    const a2 = analyzeTurn({ user_msg: "以后就在创造模式开发" });
    expect(a2.decisions).toEqual([{ action: "propose", text: "创造模式开发", source: "user-declare" }]);
  });

  it("机制1：系统提醒/指令注入不抽结构化行（噪声过滤）", () => {
    const a = analyzeTurn({ user_msg: "<system-reminder>\nUpdated instructions from: AGENTS.md\nThis file changed" });
    expect(a.decisions).toEqual([]);
    expect(a.feedback).toEqual([]);
    expect(a.goals).toEqual([]);
  });

  it("机制1：偏好语 → feedback（决策 vs 偏好区分）", () => {
    const a = analyzeTurn({ user_msg: "以后不要用 jQuery" });
    expect(a.decisions).toEqual([]);
    expect(a.feedback).toHaveLength(1);
    expect(a.feedback[0].kind).toBe("correction");
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

describe("轻确认候选（§1.5.3d：粗筛-候选，不污染正式表）", () => {
  it("用户决策宣告 → pending 候选（kind=decision），正式表无行", () => {
    const applied = applyAnalysis(store, "s-p1", { user_msg: "以后就在创造模式开发" }, { projectKey: "test-proj" });
    expect(applied.pending).toHaveLength(1);
    expect(applied.pending[0].kind).toBe("decision");
    expect(applied.decisions).toHaveLength(0);
    expect(store.getActiveDecisions("s-p1")).toHaveLength(0);
    expect(store.pendingCount({ projectKey: "test-proj" })).toBeGreaterThanOrEqual(1);
  });

  it("偏好语 → 直接进 feedback 表（保持跨项目全局偏好共享）", () => {
    const applied = applyAnalysis(store, "s-p2", { user_msg: "以后不要用 jQuery" }, { projectKey: "test-proj" });
    expect(applied.feedback).toHaveLength(1);
    expect(applied.pending).toHaveLength(0);
    expect(store.getFeedback("s-p2")).toHaveLength(1);
  });

  it("确认候选 → status=confirmed；忽略 → ignored", () => {
    const c = store.addPendingCandidate({ sessionId: "s-p3", text: "用 pnpm", kind: "decision", projectKey: "test-proj" });
    const confirmed = store.confirmCandidate(c.id);
    expect(confirmed?.status).toBe("confirmed");
    const c2 = store.addPendingCandidate({ sessionId: "s-p3", text: "别用 yarn", kind: "preference", projectKey: "test-proj" });
    const ignored = store.ignoreCandidate(c2.id);
    expect(ignored?.status).toBe("ignored");
    // s-p3 的行全部处理完，pendingCount 不含 s-p3
    const s3Pending = store.listPendingCandidates({ sessionId: "s-p3" });
    expect(s3Pending).toHaveLength(0);
  });

  it("提示计数与超时过期", () => {
    const c = store.addPendingCandidate({ sessionId: "s-p4", text: "缓存用 LRU", kind: "decision", projectKey: "test-proj" });
    store.markCandidatePrompted(c.id);
    store.markCandidatePrompted(c.id);
    const listed = store.listPendingCandidates({ projectKey: "test-proj" }).find((x) => x.id === c.id);
    expect(listed?.prompt_count).toBe(2);
    // 超时过期：把 last_prompt_ts 设成过去，expire 后应 ignored
    store.structuredDb.prepare(`UPDATE pending_candidates SET last_prompt_ts = ? WHERE id = ?`).run("2026-01-01T00:00:00.000Z", c.id);
    const expired = store.expireCandidates({ before: new Date().toISOString(), projectKey: "test-proj" });
    expect(expired).toBeGreaterThanOrEqual(1);
    const after = store.listPendingCandidates({ projectKey: "test-proj" }).find((x) => x.id === c.id);
    expect(after).toBeUndefined();
  });
});
