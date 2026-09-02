import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusCard, detectSituation } from "./status-card.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-card-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "card-proj" });
  for (let i = 1; i <= 6; i++) {
    store.addGoal("s1", `目标 ${i}`);
    store.addDecision("s1", `决策 ${i}`);
  }
  store.addFeedback("s1", "偏好 1", "preference");
  store.append({ session_id: "s1", kind: "user_message", ts: new Date().toISOString(), body: "事件 1" });
  store.append({ session_id: "s1", kind: "assistant_message", ts: new Date().toISOString(), body: "事件 2" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildStatusCard（外部借鉴 ①③：首轮加权 + 收束语）", () => {
  it("尾行收束语为绑定式行动引导（③）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    expect(card).toContain("需要更早的历史细节时，调用 query_session_memory 工具查询，并基于结果给出结论。");
  });

  it("候选唤醒（2026-08-20 复盘修复）：待确认计数 + 前 2 条原文入卡", () => {
    store.addPendingCandidate({ sessionId: "s1", text: "候选决策 A", kind: "decision", projectKey: "card-proj" });
    store.addPendingCandidate({ sessionId: "s1", text: "候选决策 B", kind: "decision", projectKey: "card-proj" });
    store.addPendingCandidate({ sessionId: "s1", text: "候选偏好 C", kind: "preference", projectKey: "card-proj" });
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    expect(card).toContain("待处理候选（3）：");
    expect(card).toContain("候选偏好 C"); // 最近优先（listPendingCandidates ORDER BY id DESC）
    expect(card).toContain("候选决策 B");
    expect(card).not.toContain("候选决策 A"); // 只露前 2 条，控制预算
    expect(card).toContain("候选转正前不得当正式决策执行，处理经 /thread-cfm。");
    // 清理候选，避免影响后续用例
    store.ignoreAllPendingCandidates({ projectKey: "card-proj" });
  });

  it("首轮档展示更多目标/决策（① 锚点全量）", () => {
    const normal = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    const first = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", firstTurn: true });
    const countOf = (card: string, marker: string) => card.split("\n").filter((l) => l.includes(marker)).length;
    expect(countOf(first, "决策 ")).toBeGreaterThan(countOf(normal, "决策 "));
    expect(countOf(first, "目标 ")).toBeGreaterThan(countOf(normal, "目标 "));
  });

  it("首轮档默认 recent 更多（5 条档），事件行新→旧", () => {
    const first = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", firstTurn: true });
    const events = first.split("\n").filter((l) => /^  - \[(user_message|assistant_message)\]/.test(l));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("[assistant_message]"); // getRecentEvents 按 id DESC → 新→旧
  });

  it("截断时计数标题示总数（前 N/总数）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    expect(card).toContain("目标（前 5/6）：");
    expect(card).toContain("决策（前 5/6）：");
  });

  it("隔离 + 首轮组合不降级崩溃", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", isolated: true, firstTurn: true });
    expect(card).toContain("本会话已隔离");
  });

  it("行首带行 id（① 治理可见性：目标/决策/偏好均可定位）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj" });
    expect(card).toMatch(/  - #\d+ 决策 1$/m);
    expect(card).toMatch(/  - #\d+ 目标 \d$/m);
    expect(card).toMatch(/  - #\d+ 偏好 1$/m);
  });

  it("2026-08-25 格式规整：截断带省略号 + 正文单行化（换行折叠）", () => {
    // projectKey 独立（fmt-proj）：隔离视图只看本会话行，且不污染 card-proj 的合并视图（detectSituation 用例依赖）
    store.addDecision("s-fmt", "长决策".repeat(50), { projectKey: "fmt-proj" });
    store.append({ session_id: "s-fmt", kind: "user_message", ts: new Date().toISOString(), body: "第一行\n第二行\t第三行" });
    const card = buildStatusCard(store, { sessionId: "s-fmt", projectKey: "fmt-proj", isolated: true });
    expect(card).toContain("决策（1）：");
    expect(card).toMatch(/  - #\d+ (长决策){40}…$/m); // 120 字截断 + 省略号
    expect(card).toContain("[user_message] 第一行 第二行 第三行");
    expect(card).not.toContain("第一行\n第二行");
  });

  it("2026-08-26 决策反例：最近被取代决策入卡（防重提旧案）", () => {
    const old = store.addDecision("s-anti", "JWT 自签方案", { projectKey: "anti-proj" });
    const { superseded, replacement } = store.supersedeDecisionById("s-anti", old.id, "改用 Session 认证")!;
    // 普通视图：反例行附于生效决策末尾，带 [被取代] 标记
    const card = buildStatusCard(store, { sessionId: "s-anti", projectKey: "anti-proj" });
    expect(card).toContain("决策（1）：");
    expect(card).toMatch(new RegExp(`  - #${superseded.id} \\[被取代\\] JWT 自签方案$`, "m"));
    expect(card).toContain("改用 Session 认证");
    // 续接情境：接续块加"最近废弃"行
    const carry = buildStatusCard(store, { sessionId: "s-anti-new", projectKey: "anti-proj", situation: "new-session" });
    expect(carry).toContain(`最近废弃：JWT 自签方案 #${superseded.id}`);
    // 隔离视图：他会话的反例不可见
    const iso = buildStatusCard(store, { sessionId: "s-anti-other", projectKey: "anti-proj", isolated: true });
    expect(iso).not.toContain("JWT 自签方案");
    // 边界：无生效决策只剩反例 → 区块以"最近废弃"示人
    store.deleteDecision(replacement.id);
    const onlyAnti = buildStatusCard(store, { sessionId: "s-anti", projectKey: "anti-proj" });
    expect(onlyAnti).toContain("最近废弃：");
    expect(onlyAnti).toMatch(new RegExp(`  - #${superseded.id} \\[被取代\\] JWT 自签方案$`, "m"));
  });
});

describe("detectSituation（§1.5 P0 情境判定，程序确定性）", () => {
  it("首轮且本会话无事件、项目有历史 → new-session（跨会话续接）", () => {
    // s1 有历史（beforeAll 造），s2 是本会话（无事件）→ 续接情境
    expect(detectSituation(store, { sessionId: "s2", turn: 1, projectKey: "card-proj" })).toBe("new-session");
  });

  it("首轮且本会话已有事件（续写会话）→ normal", () => {
    // s1 自己有事件 → 不是新会话续接
    expect(detectSituation(store, { sessionId: "s1", turn: 1, projectKey: "card-proj" })).toBe("normal");
  });

  it("最近事件含 compact_checkpoint → post-compact", () => {
    store.append({
      session_id: "s1",
      kind: "compact_checkpoint",
      ts: new Date().toISOString(),
      body: "摘要全文",
    });
    expect(detectSituation(store, { sessionId: "s1", turn: 5, projectKey: "card-proj" })).toBe("post-compact");
  });

  it("无 checkpoint 且非首轮 → normal", () => {
    expect(detectSituation(store, { sessionId: "brand-new", turn: 5, projectKey: "card-proj" })).toBe("normal");
  });

  it("项目有比本会话最新事件更新的决策 → decision-change（§1.5.3c 机制 3）", () => {
    // 先造一个本会话事件（作为时间基准，用过去时间），再在另一会话定决策（updated_at 明确更晚）
    const past = new Date(Date.now() - 60_000).toISOString();
    store.append({ session_id: "s-change", kind: "user_message", ts: past, body: "本会话事件" });
    store.addDecision("s-other", "新定的开发基线决策（标准模式为主）");
    // 判定：本会话最新事件（60s 前）< 项目最近决策 updated_at（现在）→ decision-change
    expect(detectSituation(store, { sessionId: "s-change", turn: 2, projectKey: "card-proj" })).toBe("decision-change");
  });
});

describe("buildStatusCard 情境传达块（§1.5 P0 C+A）", () => {
  it("new-session 情境出现会话接续块（含沿用决策）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "new-session" });
    expect(card).toContain("会话接续");
    expect(card).toContain("生效决策");
    expect(card).toContain("基于以上继续");
    expect(card).toContain("记忆边界："); // 迭代 B：R3 metaknowledge
    expect(card).toContain("深挖建议："); // 迭代 B：检索建议词
  });

  it("post-compact 情境出现压缩回归块（目标重述 + 记忆有损硬规则 + 库存）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "post-compact" });
    expect(card).toContain("压缩后回归");
    expect(card).toContain("记忆有损");
    expect(card).toContain("先调 query_session_memory 回查");
    expect(card).toContain("库存：");
    expect(card).toContain("生效决策共");
    expect(card).toContain("事件流共");
    expect(card).toContain("进展脉络（最近"); // R2 进展脉络：压缩后回归块带时间线
    expect(card).toContain("记忆边界："); // 迭代 B：R3 metaknowledge（卡片未列出≠不存在）
  });

  it("2026-08-26 压缩库存可见化：待办/未展示决策计数/事件总数（独立 proj 防污染）", () => {
    store.addTodo({ sessionId: "s-inv", text: "待办一", projectKey: "inv-proj" });
    store.addTodo({ sessionId: "s-inv", text: "待办二", projectKey: "inv-proj" });
    store.addDecision("s-inv", "决策一", { projectKey: "inv-proj" });
    store.addDecision("s-inv", "决策二", { projectKey: "inv-proj" });
    store.append({ session_id: "s-inv", kind: "user_message", ts: new Date().toISOString(), body: "e1" });
    store.append({ session_id: "s-inv", kind: "user_message", ts: new Date().toISOString(), body: "e2" });
    const card = buildStatusCard(store, { sessionId: "s-inv", projectKey: "inv-proj", situation: "post-compact" });
    expect(card).toContain("待办 2 条");
    expect(card).toContain("生效决策共 2 条"); // 2 ≤ listLimit：不出现"卡片示前"截断提示
    expect(card).not.toContain("卡片示前");
    expect(card).toContain("事件流共 2 条（query/grep 可查）");
    expect(card).toContain("下一步：待办二 #"); // R2：最新待办即"下一步"
  });

  it("2026-08-26 压缩回归块：无目标也出现（硬规则不依赖目标存在）", () => {
    // 独立空库：共享 store 已有其他用例的隔离=0 待办（库存待办计数为全局可见语义），无法断言零待办
    const dir2 = mkdtempSync(join(tmpdir(), "thread-card-empty-"));
    const store2 = new ThreadStore({
      eventsPath: join(dir2, "events.db"),
      structuredPath: join(dir2, "structured.db"),
      projectKey: "empty-proj",
    });
    try {
      const card = buildStatusCard(store2, { sessionId: "s-empty", projectKey: "empty-proj", situation: "post-compact" });
      expect(card).toContain("压缩后回归");
      expect(card).toContain("记忆有损");
      expect(card).toContain("库存：");
      expect(card).toContain("待办 0 条"); // 库存行完整陈述，零待办也明示
      expect(card).toContain("ls 无 target 看目录/库存");
    } finally {
      store2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("2026-08-26 隔离 + post-compact 不出现压缩回归块（隔离不继承项目库存）", () => {
    const card = buildStatusCard(store, { sessionId: "s-inv", projectKey: "inv-proj", situation: "post-compact", isolated: true });
    expect(card).not.toContain("压缩后回归");
  });

  it("normal 情境不出现传达块（避免每轮塞指令）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "normal" });
    expect(card).not.toContain("会话接续");
    expect(card).not.toContain("压缩后回归");
  });

  it("隔离 + new-session 组合不出现续接块（隔离不继承）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "new-session", isolated: true });
    expect(card).not.toContain("会话接续");
    expect(card).toContain("本会话已隔离");
  });

  it("decision-change 情境出现最近决策块（§1.5.3c 机制 3）", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "decision-change" });
    expect(card).toContain("最近决策");
    expect(card).toContain("基于最近决策行动");
  });

  it("2026-09-02 质量档：情境卡放宽截断 + 逐行溯源锚（normal 维持预算档）", () => {
    // 独立库防污染共享 store 的行尾格式断言
    const dir2 = mkdtempSync(join(tmpdir(), "thread-card-quality-"));
    const store2 = new ThreadStore({
      eventsPath: join(dir2, "events.db"),
      structuredPath: join(dir2, "structured.db"),
      projectKey: "quality-proj",
    });
    try {
      const dec = "长决策".repeat(45); // 135 字：>120 且 ≤200
      store2.addDecision("s-q", dec, { projectKey: "quality-proj", sourceEvent: 777 });
      // normal 刷新卡 = 预算档：120 截断
      const normal = buildStatusCard(store2, { sessionId: "s-q", projectKey: "quality-proj" });
      expect(normal).toContain("长决策".repeat(40));
      expect(normal).not.toContain(dec);
      // 情境卡（decision-change）= 质量档：135 字完整 + 溯源锚
      const change = buildStatusCard(store2, { sessionId: "s-q", projectKey: "quality-proj", situation: "decision-change" });
      expect(change).toContain(dec);
      expect(change).toContain("（源#e777）");
      // 接续块（new-session）与进展脉络（post-compact）同样带锚
      const carry = buildStatusCard(store2, { sessionId: "s-q", projectKey: "quality-proj", situation: "new-session" });
      expect(carry).toContain("（源#e777）");
      const post = buildStatusCard(store2, { sessionId: "s-q", projectKey: "quality-proj", situation: "post-compact" });
      expect(post).toContain("（源#e777）");
    } finally {
      store2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("normal 情境不出现最近决策块", () => {
    const card = buildStatusCard(store, { sessionId: "s1", projectKey: "card-proj", situation: "normal" });
    expect(card).not.toContain("最近决策");
  });
});
