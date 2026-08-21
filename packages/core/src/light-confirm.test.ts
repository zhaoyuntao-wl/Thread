import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTurn, applyAnalysis, applyTurn, detectGoalCompletion } from "./light-confirm.js";
import { sedimentClosingTodos } from "./closing.js";
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

describe("analyzeTurn（2026-08-21 结构通道化：仅目标判定保留，决策/偏好 NL 停用）", () => {
  it("detects goals from imperative messages", () => {
    const analysis = analyzeTurn({ user_msg: "帮我实现登录功能" });
    expect(analysis.goals).toEqual([{ text: "帮我实现登录功能", action: "add" }]);
  });

  it("does not treat questions as goals", () => {
    expect(analyzeTurn({ user_msg: "请问登录怎么做" }).goals).toEqual([]);
    expect(analyzeTurn({ user_msg: "帮我查一下这个错误" }).goals).toEqual([]);
  });

  it("does not treat completion declarations as new goals", () => {
    expect(analyzeTurn({ user_msg: "整理研究笔记搞定了" }).goals).toEqual([]);
  });

  it("system-reminder/指令注入不抽任何结构化行", () => {
    const a = analyzeTurn({ user_msg: "<system-reminder>\nUpdated instructions from: AGENTS.md\nThis file changed" });
    expect(a.goals).toEqual([]);
  });

  it("多行粘贴不判目标（md 提示词粘贴守卫，2026-08-21 用户场景）", () => {
    const mdPrompt = [
      "# 角色",
      "你是一个资深工程师",
      "帮我实现登录模块",
      "## 要求",
      "- 支持 JWT",
      "- 以后优先用 pnpm",
    ].join("\n");
    expect(analyzeTurn({ user_msg: mdPrompt }).goals).toEqual([]);
    // 附件内联 = 同一入口：单行守卫对多行内容同样生效
    expect(analyzeTurn({ user_msg: "文件内容如下：\n帮我修复缓存模块\n（来自 spec.md）" }).goals).toEqual([]);
  });

  it("长文不判目标（>200 字符守卫）", () => {
    const long = `帮我实现一个登录系统具体要求如下${"支持手机号邮箱用户名三种登录方式".repeat(15)}`;
    expect(long.length).toBeGreaterThan(200);
    expect(analyzeTurn({ user_msg: long }).goals).toEqual([]);
  });

  it("单行短祈使句正常判目标（守卫不误伤真实指令）", () => {
    expect(analyzeTurn({ user_msg: "帮我修复缓存模块" }).goals).toHaveLength(1);
    expect(analyzeTurn({ user_msg: "实现一个 BM25 检索模块，支持中文分词和增量索引" }).goals).toHaveLength(1);
  });

  it("决策/偏好自然语言不再产生任何结构化动作（只留显式通道）", () => {
    expect(analyzeTurn({ user_msg: "就按方案 A 吧" })).toEqual({ goals: [] });
    expect(analyzeTurn({ user_msg: "以后不要用 jQuery" })).toEqual({ goals: [] });
    expect(analyzeTurn({ user_msg: "改成用 Redis" })).toEqual({ goals: [] });
    expect(analyzeTurn({ user_msg: "好的" })).toEqual({ goals: [] });
    expect(analyzeTurn({ assistant_msg: "我记下了方案 A" })).toEqual({ goals: [] });
    expect(analyzeTurn({ assistant_msg: "我决定采用 Vite 构建" })).toEqual({ goals: [] });
  });

  it("ignores unrelated messages", () => {
    expect(analyzeTurn({ user_msg: "用 A 吧" })).toEqual({ goals: [] });
    expect(analyzeTurn({})).toEqual({ goals: [] });
  });
});

describe("applyTurn", () => {
  it("records goals and appends events", () => {
    applyTurn(store, "s1", { user_msg: "帮我重构配置模块" });
    expect(store.getActiveGoals("s1")).toHaveLength(1);
    expect(store.getRecentEvents("s1", 10).some((e) => e.kind === "user_message")).toBe(true);
  });

  it("applyAnalysis writes structured rows without appending events", () => {
    const before = store.getRecentEvents("s2", 100).length;
    const ev = store.append({
      session_id: "s2",
      kind: "user_message",
      ts: "2026-08-13T00:00:00.000Z",
      body: "帮我编写查询工具",
    });
    const applied = applyAnalysis(store, "s2", { user_msg: "帮我编写查询工具" }, { sourceEvent: ev.id });
    expect(applied.goals).toHaveLength(1);
    expect(store.getRecentEvents("s2", 100).length).toBe(before + 1);
  });

  it("assistant 文本不再进入判定（模型通道 = record_decision 工具）", () => {
    const before = store.getDecisions("s2").length;
    applyTurn(store, "s2", { assistant_msg: "我决定采用 Webpack 构建" });
    expect(store.getDecisions("s2").length).toBe(before);
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

describe("显式决策通道（2026-08-21 结构通道化）", () => {
  it("addDecision：命令/工具创建直接落 active", () => {
    const d = store.addDecision("s-d1", "用 pnpm 管理依赖", { projectKey: "test-proj" });
    expect(d.status).toBe("active");
    expect(store.getActiveDecisions("s-d1").map((x) => x.text)).toContain("用 pnpm 管理依赖");
    // 同文本幂等：重复创建返回既有行，不产生重复 active 决策
    const dup = store.addDecision("s-d1", "用 pnpm 管理依赖", { projectKey: "test-proj" });
    expect(dup.id).toBe(d.id);
    expect(store.getActiveDecisions("s-d1")).toHaveLength(1);
  });

  it("supersedeDecisionById：旧决策转 superseded + 血缘边 + 字段继承", () => {
    const old = store.addDecision("s-d2", "JWT 认证", { projectKey: "test-proj", scope: "project" });
    const r = store.supersedeDecisionById("s-d2", old.id, "Session 认证", { ts: "2026-08-13T00:00:05.000Z" });
    expect(r).toBeDefined();
    expect(r?.superseded.status).toBe("superseded");
    expect(r?.superseded.superseded_by).toBe(r?.replacement.id);
    expect(r?.replacement.status).toBe("active");
    expect(r?.replacement.project_key).toBe("test-proj");
    const edges = store.getRelatedEdges("s-d2", "decision", old.id);
    expect(edges.some((e) => (e as { edge_type?: string }).edge_type === "supersedes")).toBe(true);
    // 非本会话/非 active 行不可取代
    expect(store.supersedeDecisionById("other", old.id, "X")).toBeUndefined();
  });

  it("deleteDecision：硬删除 + 血缘边清理，事件流水保留", () => {
    const d = store.addDecision("s-d3", "临时决策", { projectKey: "test-proj", sourceEvent: 1 });
    expect(store.deleteDecision(d.id)).toBe(true);
    expect(store.getDecisions("s-d3")).toHaveLength(0);
    expect(store.deleteDecision(d.id)).toBe(false);
  });

  it("promoteCandidate：候选转正为 active 决策（可带修正文本）", () => {
    const c = store.addPendingCandidate({ sessionId: "s-d4", text: "开发基线：标准模式为主", kind: "decision", projectKey: "test-proj" });
    const d = store.promoteCandidate(c.id);
    expect(d?.status).toBe("active");
    expect(d?.text).toBe("开发基线：标准模式为主");
    expect(store.listPendingCandidates({ sessionId: "s-d4" })).toHaveLength(0);
    // 带修正文本转正
    const c2 = store.addPendingCandidate({ sessionId: "s-d4", text: "碎片候选文本", kind: "decision", projectKey: "test-proj" });
    const d2 = store.promoteCandidate(c2.id, "修正后的决策文本");
    expect(d2?.text).toBe("修正后的决策文本");
    // 已处理候选不可再转正
    expect(store.promoteCandidate(c2.id)).toBeUndefined();
  });
});

describe("轻确认候选（§1.5.3d：粗筛-候选，不污染正式表）", () => {
  it("候选待处理期不入正式表；转正后进 decisions", () => {
    const c = store.addPendingCandidate({ sessionId: "s-p1", text: "用 pnpm", kind: "decision", projectKey: "test-proj" });
    expect(store.getDecisions("s-p1")).toHaveLength(0);
    store.promoteCandidate(c.id);
    expect(store.getDecisions("s-p1").map((d) => d.text)).toContain("用 pnpm");
  });

  it("忽略候选 → ignored", () => {
    const c = store.addPendingCandidate({ sessionId: "s-p3", text: "别用 yarn", kind: "preference", projectKey: "test-proj" });
    const ignored = store.ignoreCandidate(c.id);
    expect(ignored?.status).toBe("ignored");
    expect(store.listPendingCandidates({ sessionId: "s-p3" })).toHaveLength(0);
  });

  it("提示计数与超时过期", () => {
    const c = store.addPendingCandidate({ sessionId: "s-p4", text: "缓存用 LRU", kind: "decision", projectKey: "test-proj" });
    store.markCandidatePrompted(c.id);
    store.markCandidatePrompted(c.id);
    const listed = store.listPendingCandidates({ projectKey: "test-proj" }).find((x) => x.id === c.id);
    expect(listed?.prompt_count).toBe(2);
    store.structuredDb.prepare(`UPDATE pending_candidates SET last_prompt_ts = ? WHERE id = ?`).run("2026-01-01T00:00:00.000Z", c.id);
    const expired = store.expireCandidates({ before: new Date().toISOString(), projectKey: "test-proj" });
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(store.listPendingCandidates({ projectKey: "test-proj" }).find((x) => x.id === c.id)).toBeUndefined();
  });

  it("从未被提示的候选（headless 堆积场景）超龄也过期（2026-08-20 收口）", () => {
    const c = store.addPendingCandidate({ sessionId: "s-p5", text: "碎片误报候选", kind: "decision", projectKey: "test-proj" });
    store.structuredDb.prepare(`UPDATE pending_candidates SET created_at = ? WHERE id = ?`).run("2026-01-01T00:00:00.000Z", c.id);
    store.expireCandidates({ before: new Date().toISOString(), projectKey: "test-proj" });
    expect(store.listPendingCandidates({ sessionId: "s-p5" })).toHaveLength(0);
  });
});

describe("detectGoalCompletion（2026-08-20 收口：明确完成宣告 + 目标命中）", () => {
  it("完成宣告命中 active 目标", () => {
    const goals = store.addGoal("s-c1", "完成批 5 验证", { projectKey: "test-proj" });
    const hit = detectGoalCompletion("批 5 验证完成了", [goals]);
    expect(hit?.id).toBe(goals.id);
  });

  it("否定/疑问不误判", () => {
    const goals = store.addGoal("s-c2", "接入弹窗", { projectKey: "test-proj" });
    expect(detectGoalCompletion("接入弹窗还没完成", [goals])).toBeUndefined();
    expect(detectGoalCompletion("接入弹窗完成了吗", [goals])).toBeUndefined();
  });

  it("无目标命中不误判", () => {
    const goals = store.addGoal("s-c3", "迁移到 monorepo", { projectKey: "test-proj" });
    expect(detectGoalCompletion("午饭吃完了", [goals])).toBeUndefined();
  });

  it("长粘贴文本不触发完成（2026-08-21 狗粮假阳性守卫）", () => {
    const goals = store.addGoal("s-c5", "接入弹窗收尾", { projectKey: "test-proj" });
    const paste = "以下是 web 界面看到的内容：收到——验证任务那条也标记完成。当前待办还剩两条：接入弹窗收尾（确认/取消/推迟）和 5 条待确认候选的处理。需要继续哪个说一声即可。上下文注入 dsh-thread：收到状态卡——其他会话正在排查清单改动的问题，本会话不介入。";
    expect(paste.length).toBeGreaterThan(100);
    expect(detectGoalCompletion(paste, [goals])).toBeUndefined();
    expect(detectGoalCompletion("接入弹窗收尾完成了", [goals])?.id).toBe(goals.id);
  });

  it("applyAnalysis 全链：完成宣告 → 目标 completed + todo 自愈 done", () => {
    const g = store.addGoal("s-c4", "整理研究笔记", { projectKey: "test-proj" });
    sedimentClosingTodos(store, "s-c4", { projectKey: "test-proj" });
    expect(store.listTodos({ sessionId: "s-c4" })[0].status).toBe("pending");
    applyAnalysis(store, "s-c4", { user_msg: "整理研究笔记搞定了" }, { projectKey: "test-proj" });
    expect(store.getActiveGoals("s-c4")).toHaveLength(0);
    const completed = store.structuredDb
      .prepare(`SELECT id, status FROM goals WHERE session_id = ? AND status = 'completed'`)
      .all("s-c4") as Array<{ id: number; status: string }>;
    expect(completed.map((r) => r.id)).toContain(g.id);
    expect(store.listTodos({ sessionId: "s-c4" })[0].status).toBe("done");
  });

  it("applyAnalysis 跨会话完成（2026-08-21 狗粮修复）：目标在旧会话，新会话指认完成", () => {
    const g = store.addGoal("s-old", "验证链全绿 110/110 提交", { projectKey: "test-proj" });
    sedimentClosingTodos(store, "s-old", { projectKey: "test-proj" });
    applyAnalysis(store, "s-new", { user_msg: "验证链全绿（110/110 提交）那条已完成了" }, { projectKey: "test-proj" });
    const row = store.structuredDb.prepare(`SELECT status FROM goals WHERE id = ?`).get(g.id) as { status: string };
    expect(row.status).toBe("completed");
    expect(store.listTodos({ sessionId: "s-old" })[0].status).toBe("done");
    expect(store.getActiveGoals("s-new")).toHaveLength(0);
  });

  it("英文 4 字符窗口不判完成（2026-08-21 狗粮误报：北极星 Thread 被 thread-reg 命中 read）", () => {
    const goals = store.addGoal("s-c6", "Thread 定位北极星：让模型工作质量更高（可靠性向），不是让用户更舒服（体验向）——任何功能决策拿它对齐", { projectKey: "test-proj" });
    const msg = "重启完成了，我试了一下thread-reg ast，发现两个问题：\n1.changeset记录也在里面\n2.大量的重复";
    expect(detectGoalCompletion(msg, [goals])).toBeUndefined();
    // 合法中文窗口仍命中（空格归一化）
    expect(detectGoalCompletion("Thread定位北极星那条已经完成了", [goals])?.id).toBe(goals.id);
  });

  it("纯 ASCII 目标需 ≥8 连字符窗口；短英文目标不误判不误伤", () => {
    const en = store.addGoal("s-c7", "Ship the MVP by end of August", { projectKey: "test-proj" });
    expect(detectGoalCompletion("Ship the MVP by end of August 已经交付了", [en])?.id).toBe(en.id);
    // 短英文片段（<8 连字符）不构成重叠——宁可漏判不误判
    const short = store.addGoal("s-c8", "MVP", { projectKey: "test-proj" });
    expect(detectGoalCompletion("MVP 完成了", [short])).toBeUndefined();
  });
});
