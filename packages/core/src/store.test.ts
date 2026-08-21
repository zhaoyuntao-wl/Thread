import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScopePriority, ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "test-proj" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ThreadStore", () => {
  it("appends events with per-session sequence", () => {
    const e1 = store.append({
      session_id: "s1",
      kind: "user_message",
      ts: "2026-08-13T00:00:00.000Z",
      body: "hello",
    });
    const e2 = store.append({
      session_id: "s1",
      kind: "tool_call",
      ts: "2026-08-13T00:00:01.000Z",
      body: "run tests",
    });
    const e3 = store.append({
      session_id: "s2",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "hi",
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(1);
  });

  it("truncates oversized bodies and marks them", () => {
    const big = "x".repeat(200_000);
    const e = store.append({
      session_id: "s1",
      kind: "tool_result",
      ts: "2026-08-13T00:00:03.000Z",
      body: big,
    });
    expect(e.truncated).toBe(true);
    expect(e.body.length).toBeLessThan(big.length);
  });

  it("indexes on write and searches with BM25", () => {
    store.append({
      session_id: "s1",
      kind: "user_message",
      ts: "2026-08-13T00:00:03.000Z",
      body: "run the full test suite now",
    });
    const hits = store.search("test");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].session_id).toBe("s1");
  });

  it("does not index tool_call/tool_result (FTS layering)", () => {
    const before = store.search("bcrypt").length;
    store.append({
      session_id: "s1",
      kind: "tool_call",
      ts: "2026-08-13T00:00:04.000Z",
      body: "创建 auth 模块，使用 bcrypt 加密密码",
    });
    store.append({
      session_id: "s1",
      kind: "tool_result",
      ts: "2026-08-13T00:00:05.000Z",
      body: "auth 模块已创建，含 bcrypt 哈希函数",
    });
    const after = store.search("bcrypt").length;
    expect(after).toBe(before);
  });

  // 0-e 中文检索升级验收：jieba 词级分词 + 全 OR + BM25（替代原单字 AND，缺一字即 miss）
  it("中文查询词级命中（登录方案 → 命中含「登录/方案」正文）", () => {
    store.append({
      session_id: "s-cn",
      kind: "user_message",
      ts: "2026-08-18T00:00:00.000Z",
      body: "登录方案改成JWT，部署到周五",
    });
    const hits = store.search("登录方案");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.session_id === "s-cn")).toBe(true);
  });

  it("2 字词查询正常（「登录」是完整 token，不再依赖 trigram）", () => {
    const hits = store.search("登录");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.session_id === "s-cn")).toBe(true);
  });

  it("部分词命中仍召回（词级 OR：只记得「部署」也能召回）", () => {
    const hits = store.search("部署时间");
    expect(hits.some((h) => h.session_id === "s-cn")).toBe(true);
  });

  it("短句子串查询（「怎么定的」→ 命中决策上下文）", () => {
    store.append({
      session_id: "s-cn",
      kind: "user_message",
      ts: "2026-08-18T00:00:05.000Z",
      body: "决策：开发基线用标准模式为主",
    });
    const hits = store.search("开发基线怎么定的");
    expect(hits.some((h) => h.session_id === "s-cn")).toBe(true);
  });

  // 0-e 定案第 5 条（trigram 子串召回兜底）：主路径 jieba 词级 0 命中时，
  // 查询是正文 token 的连续子串（"用户只记得半句"）→ body_tri 短语匹配兜底召回
  it("半句子串兜底召回（主路径 0 命中 → trigram 命中「eepseek」∈ deepseek）", () => {
    store.append({
      session_id: "s-frag",
      kind: "user_message",
      ts: "2026-08-18T00:10:00.000Z",
      body: "模型选定 deepseek-v4-flash 作为主力，事件存储用 better-sqlite3",
    });
    const hits = store.search("eepseek");
    expect(hits.some((h) => h.session_id === "s-frag")).toBe(true);
  });

  it("半句子串兜底保持主路径语义（整词仍走 body_seg BM25）", () => {
    const hits = store.search("deepseek");
    expect(hits.some((h) => h.session_id === "s-frag")).toBe(true);
    expect(hits[0].session_id).toBe("s-frag");
  });

  it("半句子串兜底遵守隔离语义（其他会话不可见，本会话可见）", () => {
    store.append(
      {
        session_id: "s-frag-iso",
        kind: "user_message",
        ts: "2026-08-18T00:11:00.000Z",
        body: "孤岛验证 tokenizer-v5 半句隔离",
      },
      { isolation: true },
    );
    const hidden = store.search("okenizer", { sessionId: "s2" });
    expect(hidden.some((h) => h.session_id === "s-frag-iso")).toBe(false);
    const self = store.search("okenizer", { sessionId: "s-frag-iso" });
    expect(self.some((h) => h.session_id === "s-frag-iso")).toBe(true);
  });

  it("trigram 兜底 <3 字符查询返回空；≥3 字符子串正常命中", () => {
    // "ee" 不足 3 字符（trigram 需 ≥3）→ 空（不报错）
    expect(store.search("ee")).toEqual([]);
    // "eep" 恰好 3 字符且是 deepseek 子串 → 命中
    expect(store.search("eep")).not.toEqual([]);
    // 中文 2 字词走主路径词级命中
    expect(store.search("登录")).not.toEqual([]);
  });

  it("filters search by session and hides isolated content from others", () => {
    // 未隔离内容跨会话可见（跨会话继承检索语义）
    const visible = store.search("hello", { sessionId: "s2" });
    expect(visible.length).toBeGreaterThan(0);
    // 隔离内容对其他会话不可见（全链路过滤）
    store.append(
      {
        session_id: "s-iso",
        kind: "user_message",
        ts: "2026-08-13T00:00:06.000Z",
        body: "秘密计划代号红隼",
      },
      { isolation: true },
    );
    const hidden = store.search("红隼", { sessionId: "s2" });
    expect(hidden).toHaveLength(0);
    const self = store.search("红隼", { sessionId: "s-iso" });
    expect(self.length).toBeGreaterThan(0);
  });

  it("starts a new episode on user message", () => {
    const seqBefore = store.append({
      session_id: "s4",
      kind: "tool_call",
      ts: "2026-08-13T00:00:01.000Z",
      body: "step1",
    }).seq;
    const user = store.append({
      session_id: "s4",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "next task",
    });
    const ep = store.getActiveEpisode("s4");
    expect(ep?.seq_start).toBe(user.seq);
    expect(seqBefore).toBe(user.seq - 1);
  });

  it("writes a deterministic summary when an episode closes", () => {
    store.append({
      session_id: "s3",
      kind: "user_message",
      ts: "2026-08-13T00:00:00.000Z",
      body: "使用 sqlite 存储",
    });
    store.append({
      session_id: "s3",
      kind: "tool_call",
      ts: "2026-08-13T00:00:01.000Z",
      body: "init db",
    });
    store.append({
      session_id: "s3",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "继续",
    });
    const ep = store.getLatestEpisodeWithSummary("s3");
    expect(ep?.seq_end).toBe(2);
    expect(ep?.summary).toContain("使用 sqlite 存储");
    expect(ep?.summary).toContain("init db");
  });

  it("parses stored meta back into objects", () => {
    const ev = store.append({
      session_id: "s4",
      kind: "tool_call",
      ts: "2026-08-13T00:00:00.000Z",
      body: "x",
      meta: { tool_name: "Edit", file_path: "src/a.ts" },
    });
    expect(ev.meta).toEqual({ tool_name: "Edit", file_path: "src/a.ts" });
    const recent = store.getRecentEvents("s4", 1);
    expect(recent[0].meta).toEqual({ tool_name: "Edit", file_path: "src/a.ts" });
  });

  it("dedupes by origin (idempotent append)", () => {
    const e1 = store.append(
      {
        session_id: "s5",
        kind: "user_message",
        ts: "2026-08-13T00:00:00.000Z",
        body: "dup test",
      },
      { origin: "qoder://transcript#uuid-1" },
    );
    const e2 = store.append(
      {
        session_id: "s5",
        kind: "user_message",
        ts: "2026-08-13T00:00:00.000Z",
        body: "dup test",
      },
      { origin: "qoder://transcript#uuid-1" },
    );
    expect(e2.id).toBe(e1.id);
    const count = store.eventsDb.prepare("SELECT COUNT(*) AS c FROM events WHERE origin = ?").get("qoder://transcript#uuid-1") as { c: number };
    expect(count.c).toBe(1);
  });

  it("spills oversized bodies with expand recovery", () => {
    const big = "y".repeat(6000);
    const e = store.append(
      {
        session_id: "s5",
        kind: "tool_result",
        ts: "2026-08-13T00:00:01.000Z",
        body: big,
      },
      { spillRef: "transcript#tool-1" },
    );
    expect(e.spilled).toBe(1);
    expect(e.body.length).toBeLessThan(1000);
    const restored = store.expand(e.id);
    expect(restored).toBe(big);
  });

  it("expands non-spilled event body", () => {
    const e = store.append({
      session_id: "s5",
      kind: "user_message",
      ts: "2026-08-13T00:00:02.000Z",
      body: "plain body",
    });
    expect(store.expand(e.id)).toBe("plain body");
  });
});

describe("structured scope (B②-4)", () => {
  it("writes scope/project_key/origin on structured rows", () => {
    const g = store.addGoal("s6", "目标 A", { scope: "session", projectKey: "p1", origin: "o-goal-1", ts: "2026-08-13T00:00:00.000Z" });
    const d = store.addDecision("s6", "决策 B", { scope: "project", projectKey: "p1", origin: "o-dec-1", ts: "2026-08-13T00:00:00.000Z" });
    const f = store.addFeedback("s6", "偏好 C", "preference", { scope: "global", origin: "o-fb-1", ts: "2026-08-13T00:00:00.000Z" });
    expect(g.scope).toBe("session");
    expect(g.project_key).toBe("p1");
    expect(g.origin).toBe("o-goal-1");
    expect(d.scope).toBe("project");
    expect(d.project_key).toBe("p1");
    expect(f.scope).toBe("global");
    expect(f.project_key).toBeNull();
  });

  it("dedupes structured writes by origin across sessions", () => {
    const d1 = store.proposeDecision("s6", "同源决策", { scope: "project", projectKey: "p1", origin: "o-dec-same", ts: "2026-08-13T00:00:00.000Z" });
    const d2 = store.proposeDecision("s7", "同源决策不同描述", { scope: "project", projectKey: "p1", origin: "o-dec-same", ts: "2026-08-13T00:00:00.000Z" });
    expect(d2.id).toBe(d1.id);
  });

  it("merged decisions include same-project rows from other sessions, hard-filter others", () => {
    store.addDecision("s8", "pnpm 包管理", { scope: "project", projectKey: "proj-x", origin: "o-x-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addDecision("s8", "会话内临时决策", { scope: "session", projectKey: "proj-x", origin: "o-x-2", ts: "2026-08-13T00:00:02.000Z" });
    store.addDecision("s9", "另一项目决策", { scope: "project", projectKey: "proj-y", origin: "o-y-1", ts: "2026-08-13T00:00:04.000Z" });
    store.addDecision("s10", "无关项目", { scope: "project", projectKey: "proj-z", origin: "o-z-1", ts: "2026-08-13T00:00:06.000Z" });

    const merged = store.getActiveDecisionsMerged("s9", "proj-y");
    const texts = merged.map((d) => d.text);
    expect(texts).toContain("另一项目决策");
    expect(texts).not.toContain("pnpm 包管理");
    expect(texts).not.toContain("会话内临时决策");
    expect(texts).not.toContain("无关项目");
  });

  it("merged goals include same-project rows from other sessions", () => {
    store.addGoal("s8", "重构核心模块", { scope: "project", projectKey: "proj-x", origin: "o-gx-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addGoal("s9", "本会话目标", { scope: "session", projectKey: "proj-y", origin: "o-gy-1", ts: "2026-08-13T00:00:00.000Z" });
    const merged = store.getActiveGoalsMerged("s9", "proj-y");
    expect(merged.map((g) => g.text)).toEqual(["本会话目标"]);
    const x = store.getActiveGoalsMerged("s9", "proj-x");
    expect(x.map((g) => g.text)).toContain("重构核心模块");
  });

  it("merged feedback includes global rows and own-session rows only", () => {
    store.addFeedback("s8", "全局偏好：用 pnpm", "preference", { scope: "global", projectKey: "proj-x", origin: "o-fx-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addFeedback("s9", "项目偏好：用 vitest", "preference", { scope: "project", projectKey: "proj-y", origin: "o-fy-1", ts: "2026-08-13T00:00:00.000Z" });
    store.addFeedback("s10", "他项目偏好", "preference", { scope: "project", projectKey: "proj-z", origin: "o-fz-1", ts: "2026-08-13T00:00:00.000Z" });
    const merged = store.getFeedbackMerged("s9", "proj-y", 10);
    const texts = merged.map((f) => f.text);
    expect(texts).toContain("全局偏好：用 pnpm");
    expect(texts).toContain("项目偏好：用 vitest");
    expect(texts).not.toContain("他项目偏好");
  });

  it("scope defaults to project (先到先得) when not specified", () => {
    const d = store.addDecision("s11", "默认项目级决策", { projectKey: "proj-x", ts: "2026-08-13T00:00:00.000Z" });
    expect(d.scope).toBe("project");
    expect(d.project_key).toBe("proj-x");
    expect(d.status).toBe("active");
  });
});

describe("applyScopePriority (B③)", () => {
  it("keeps highest-priority scope for the same normalized text", () => {
    const rows = [
      { id: 1, text: "包管理用 pnpm", scope: "global" },
      { id: 2, text: "包管理用 pnpm。", scope: "project" },
      { id: 3, text: "包管理用 pnpm", scope: "session" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("session");
  });

  it("project overrides global for the same fact (项目特例覆盖全局默认)", () => {
    const rows = [
      { id: 1, text: "用 pnpm", scope: "global" },
      { id: 2, text: "用 pnpm", scope: "project" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("project");
  });

  it("keeps distinct facts regardless of scope", () => {
    const rows = [
      { id: 1, text: "用 pnpm", scope: "global" },
      { id: 2, text: "用 yarn", scope: "project" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(2);
  });

  it("treats missing scope as project (旧行默认)", () => {
    const rows = [
      { id: 1, text: "决策 A", scope: undefined },
      { id: 2, text: "决策 A", scope: "session" },
    ];
    const out = applyScopePriority(rows);
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe("session");
  });
});

describe("显式通道资源治理（2026-08-21 /thread-reg|rev|pub 资源集）", () => {
  it("getGoals 返回全状态目标（reg gol 无参列表的 id 来源）", () => {
    const g1 = store.addGoal("s-g1", "进行中的目标", { projectKey: "test-proj" });
    store.updateGoalStatus("s-g1", g1.id, "completed");
    const g2 = store.addGoal("s-g1", "已废弃的目标", { projectKey: "test-proj" });
    store.updateGoalStatus("s-g1", g2.id, "abandoned");
    const all = store.getGoals("s-g1");
    expect(all.map((g) => g.status).sort()).toEqual(["abandoned", "completed"]);
  });

  it("deleteAsset 硬删除 + 血缘边清理，事件流水保留", () => {
    const ev = store.append({
      session_id: "s-g2",
      kind: "tool_call",
      ts: "2026-08-13T00:00:00.000Z",
      body: "write docs/x.md",
      meta: { tool_name: "write", file_path: "docs/x.md" },
    });
    const a = store.registerAsset({ sessionId: "s-g2", path: "docs/x.md", title: "X 文档", sourceEvent: ev.id });
    expect(store.listAssets({ sessionId: "s-g2" })).toHaveLength(1);
    expect(store.deleteAsset(a.id)).toBe(true);
    expect(store.listAssets({ sessionId: "s-g2" })).toHaveLength(0);
    expect(store.getRelatedEdges("s-g2", "asset", a.id)).toHaveLength(0);
    expect(store.deleteAsset(a.id)).toBe(false);
  });

  it("registerAsset 路径幂等（2026-08-21 狗粮实证：同 path 重复堆行 12 行）", () => {
    const a1 = store.registerAsset({ sessionId: "s-g2b", path: "README.md", title: "旧标题" });
    const a2 = store.registerAsset({ sessionId: "s-g2b", path: "README.md", title: "新标题" });
    expect(a2.id).toBe(a1.id);
    expect(store.listAssets({ sessionId: "s-g2b" })).toHaveLength(1);
    // 标题刷新为最新
    expect(store.getAsset(a1.id)?.title).toBe("新标题");
    // 跨会话可见范围去重：他会话注册同 path 也不新增（isolation=0 行全局可见）
    const a3 = store.registerAsset({ sessionId: "s-g2c", path: "README.md", title: "标题三" });
    expect(a3.id).toBe(a1.id);
  });

  it("listIsolatedRows 覆盖 ast 产出 + 三元组，unisolateRow 支持 knowledge_assets", () => {
    const a = store.registerAsset({ sessionId: "s-g3", path: "docs/iso.md", title: "隔离产出", isolation: true });
    store.addGoal("s-g3", "隔离目标", { projectKey: "test-proj", isolation: true });
    const rows = store.listIsolatedRows("s-g3");
    expect(rows.some((r) => r.kind === "ast" && r.id === a.id)).toBe(true);
    expect(rows.some((r) => r.kind === "goal")).toBe(true);
    expect(store.unisolateRow("s-g3", "knowledge_assets", a.id)).toBe(true);
    expect(store.listIsolatedRows("s-g3").some((r) => r.kind === "ast")).toBe(false);
  });
});
