import type { ThreadStore } from "./store.js";
import { applyScopePriority } from "./store.js";
import { buildProgressTimeline } from "./progress.js";
import { MEMORY_BOUNDARY, suggestionsFrom } from "./metaknowledge.js";

function shortSession(sessionId: string): string {
  const cleaned = sessionId.replace(/^session-/, "");
  return cleaned.slice(0, 7);
}

// 状态卡构建（B③/B④ 共用）：合并视图 + 分层优先级 + 预算分档 + 词汇边界（不出现 session/project/scope 等机制词）。
// 注入隔离：内容 = 数据非指令（状态卡是用户可理解的事实 + 低频冲突询问）。
// 情境化传达（§1.5，P0 情境 C+A）：程序判定情境 → 恰时传达对应记忆块，用户无感。
// 2026-08-25 格式规整（用户指令）：区块空行分隔、全角冒号计数标题（截断时示"前 N/总数"）、行首 id 统一
// `- #id 文本…（来源）`、截断带省略号、正文单行化（防事件换行打穿卡片行结构）、最近事件改新→旧。

export type StatusCardSituation = "normal" | "new-session" | "post-compact" | "decision-change";

export interface BuildStatusCardOptions {
  sessionId: string;
  projectKey?: string;
  budgetLines?: number;
  recentCount?: number;
  isolated?: boolean;
  // 首轮档（外部借鉴①：会话首请求即锚定轨迹，首轮给全量锚点，后续维持轻量 O(1)）
  firstTurn?: boolean;
  // 情境判定（§1.5：程序判定，不靠模型自觉）：new-session=新会话续接 / post-compact=压缩边界回归
  situation?: StatusCardSituation;
}

// 单行化：折叠换行与连续空白，防事件正文换行打穿卡片行结构
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 截断带省略号（先单行化再截：折叠会缩短文本，避免误加省略号）
function clip(text: string, n: number): string {
  const t = oneLine(text);
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

export function buildStatusCard(store: ThreadStore, opts: BuildStatusCardOptions): string {
  const sessionId = opts.sessionId;
  const projectKey = opts.projectKey;
  const budgetLines = opts.budgetLines ?? 100;
  const firstTurn = opts.firstTurn ?? false;
  const situation = opts.situation ?? "normal";
  const isolated = opts.isolated ?? false;
  // 2026-09-02 质量档（用户定案：卡片仅情境注入非每轮，预算不再第一要素，质量优先）：
  // 情境卡（new-session/post-compact/decision-change/首轮）放宽行文本上限并全卡逐行溯源锚；normal 刷新卡维持 G6 预算档。
  const quality = situation !== "normal" || firstTurn;
  const textCap = quality ? 200 : 120;
  const carryCap = quality ? 120 : 60;
  const eventCap = quality ? 120 : 60;
  const timelineCap = quality ? 120 : 60;
  const recentCount = opts.recentCount ?? (firstTurn ? 5 : 3);
  const listLimit = quality ? 8 : 5;
  const feedbackLimit = quality ? 8 : 5;

  let goals: Array<{ id: number; text: string; scope?: string | null; session_id: string; source_event?: number | null }> = [];
  let decisions: Array<{ id: number; text: string; scope?: string | null; session_id: string; source_event?: number | null }> = [];
  let feedback: Array<{ id: number; text: string; scope?: string | null; session_id: string; source_event?: number | null }> = [];
  let recent: Array<{ kind: string; body: string }> = [];
  try {
    if (isolated) {
      // 隔离模式：只显示本会话内容（不继承项目/全局），状态卡不随其他代理变动
      goals = store.getActiveGoals(sessionId);
      decisions = store.getActiveDecisions(sessionId);
      feedback = store.getFeedback(sessionId, feedbackLimit);
    } else {
      goals = applyScopePriority(store.getActiveGoalsMerged(sessionId, projectKey));
      decisions = applyScopePriority(store.getActiveDecisionsMerged(sessionId, projectKey));
      feedback = applyScopePriority(store.getFeedbackMerged(sessionId, projectKey, feedbackLimit));
    }
    recent = store.getRecentEvents(sessionId, recentCount);
  } catch {
    // 状态卡是主路径增强，任何失败都降级为最小卡，绝不阻塞
  }

  const shareMark = (row: { scope?: string | null; session_id: string }): string =>
    row.scope === "global" ? "（全局）" : row.session_id !== sessionId ? "（来自其他会话）" : "";
  // 溯源锚（2026-09-02 质量档）：逐行附 source_event 引用，cat <event id> 即回原文（nav cat 支持事件 id）
  const sourceAnchor = (row: { source_event?: number | null }): string =>
    row.source_event != null ? `（源#e${row.source_event}）` : "";

  const lines: string[] = [];
  lines.push(isolated ? "[Thread 会话记忆状态卡]（本会话已隔离，内容仅自己可见）" : "[Thread 会话记忆状态卡]");
  // 区块统一：空行分隔 + 全角冒号计数标题
  const section = (header: string): void => {
    lines.push("");
    lines.push(header);
  };

  // 决策反例（2026-08-26 用户定案）：最近一条被取代/废弃的决策入卡——卡片只列生效决策，
  // 模型看不到反例会自信重提旧案；与决策块同视图（merged + scope 优先级 + 隔离语义），取最近一条。
  const anti =
    ((): { id: number; text: string; scope?: string | null; session_id: string; source_event?: number | null; tag: string } | undefined => {
      try {
        const rows = isolated
          ? store.getDecisions(sessionId).reverse() // 本会话全状态，id DESC 取最近
          : applyScopePriority(store.getRecentDecisionsMerged(sessionId, projectKey, 20)); // updated_at DESC
        const hit = rows.find((d) => d.status === "superseded" || d.status === "revoked");
        if (!hit) {
          return undefined;
        }
        return { ...hit, tag: hit.status === "superseded" ? "被取代" : "已废弃" };
      } catch {
        return undefined;
      }
    })();

  // 进展脉络（2026-09-02 R2，四格第一项）：结构化行变更时间线，"做到哪一步/下一步"的确定性表达
  const timelineRows = buildProgressTimeline(store, { sessionId, projectKey, limit: 5, isolated });
  const nextTodo = ((): { id: number; text: string } | undefined => {
    try {
      return store.listTodos({ visibleToSession: sessionId, status: "pending", limit: 1 })[0];
    } catch {
      return undefined;
    }
  })();
  const renderTimeline = (): void => {
    if (timelineRows.length === 0) {
      return;
    }
    section(`进展脉络（最近 ${timelineRows.length} 步）：`);
    for (const r of timelineRows) {
      const mark = r.scope === "global" ? "（全局）" : r.session_id !== sessionId ? "（来自其他会话）" : "";
      const tag = r.tag ? ` [${r.tag}]` : "";
      const anchor = r.source_event != null ? `（源#e${r.source_event}）` : "";
      lines.push(`  - ${r.ts} ${r.type} #${r.id}${tag} ${clip(r.text, timelineCap)}${anchor}${mark}`);
    }
    if (nextTodo) {
      lines.push(`  下一步：${clip(nextTodo.text, 120)} #${nextTodo.id}`);
    }
  };

  // 情境 A：新会话续接块（§1.5 P0 + max 2.3.1 接续包）——开场即知上次上下文，无需用户显式提醒
  if (situation === "new-session" && !isolated) {
    const carryGoals = goals.length > 0 ? `目标：${goals.map((g) => `${clip(g.text, carryCap)}${sourceAnchor(g)}`).join("；")}` : null;
    const carryDecisions = decisions.length > 0 ? `生效决策：${decisions.map((d) => `${clip(d.text, carryCap)}${sourceAnchor(d)}`).join("；")}` : null;
    const carryAnti = anti ? `最近废弃：${clip(anti.text, carryCap)} #${anti.id}${sourceAnchor(anti)}` : null;
    const assets = store.listAssets({ visibleToSession: sessionId, limit: 3 });
    const todos = store.listTodos({ visibleToSession: sessionId, status: "pending", limit: 3 });
    if (carryGoals || carryDecisions || carryAnti || assets.length > 0 || todos.length > 0) {
      section("会话接续（来自之前的工作）：");
      if (carryGoals) lines.push(`  - ${carryGoals}`);
      if (carryDecisions) lines.push(`  - ${carryDecisions}`);
      if (carryAnti) lines.push(`  - ${carryAnti}`);
      if (assets.length > 0) lines.push(`  - 最近产出：${assets.map((a) => `${a.title}（${a.path}）`).join("；")}`);
      if (todos.length > 0) lines.push(`  - 待办：${todos.map((t) => `${clip(t.text, 60)} #${t.id}`).join("；")}`);
      lines.push("  基于以上继续，不要重新开始；查更多用 query_session_memory 导航（ls/cd/cat/grep）。");
      // 迭代 B（R3 metaknowledge + 检索建议词 + 溯源锚，2026-09-02）：接续块尾附边界声明与深挖建议词
      const sugg = suggestionsFrom([...goals, ...decisions]);
      if (sugg.length > 0) {
        lines.push(`  深挖建议：${sugg.join("；")}`);
      }
      lines.push(`  ${MEMORY_BOUNDARY}`);
    }
    renderTimeline();
    // 发现层（max 2.4）：活跃会话区块——模型知道别的会话存在
    const activeSessions = store.listActiveSessionsWithAssets(4);
    const others = activeSessions.filter((s) => s.session_id !== sessionId).slice(0, 3);
    if (others.length > 0) {
      lines.push(`活跃会话：${others.map((s) => `${shortSession(s.session_id)}（${s.latest_title}）`).join(" | ")}`);
    }
  }

  // 情境 C：压缩回归块（§1.5，P0）——压缩边界后目标不漂移 + 记忆有损硬规则（2026-08-26 用户定案：
  // 压缩后模型不自知记忆有损，必须外部强制回查）+ 库存可见化（来源=结构化表/事件计数，只陈述
  // "库里还有什么"，不宣称"损失"——Thread 看不到模型上下文，无法知道它丢了什么）。
  if (situation === "post-compact" && !isolated) {
    section("压缩后回归（目标保持）：");
    if (goals.length > 0) {
      goals
        .slice()
        .reverse()
        .slice(0, listLimit)
        .forEach((g) => lines.push(`  - #${g.id} ${clip(g.text, textCap)}${sourceAnchor(g)}${shareMark(g)}`));
    }
    renderTimeline();
    lines.push(
      "本会话经过压缩，记忆有损：涉及历史状态/本项目情况的话题，先调 query_session_memory 回查（ls 无 target 看目录/库存，cd/cat/grep 下钻），不要凭压缩后记忆直接下结论。",
    );
    // 迭代 B（2026-09-02）：压缩回归块附深挖建议词 + 记忆边界（卡片未列出≠不存在）
    const sugg = suggestionsFrom(goals);
    if (sugg.length > 0) {
      lines.push(`深挖建议：${sugg.join("；")}`);
    }
    lines.push(MEMORY_BOUNDARY);
    const inventory = ((): string => {
      try {
        const parts: string[] = [];
        const todoCount = store.countTodos({ visibleToSession: sessionId, status: "pending" });
        parts.push(`待办 ${todoCount} 条`);
        const shown = Math.min(listLimit, decisions.length);
        parts.push(
          `生效决策共 ${decisions.length} 条${
            decisions.length > shown ? `（卡片示前 ${shown}，其余经 query_session_memory kind=decision 可查）` : ""
          }`,
        );
        parts.push(`事件流共 ${store.countEvents(sessionId)} 条（query/grep 可查）`);
        return parts.join("；");
      } catch {
        return "";
      }
    })();
    if (inventory) {
      lines.push(`库存：${inventory}。`);
    }
  }

  // 决策变更情境（§1.5.3c 机制 3）：项目最近定的决策 → 传达，防模型基于旧状态行动
  if (situation === "decision-change" && !isolated) {
    const recentDecisions = store.getRecentDecisionsMerged(sessionId, projectKey, 3);
    if (recentDecisions.length > 0) {
      section("最近决策：");
      recentDecisions.forEach((d) => {
        const status = d.status === "active" ? "生效" : d.status === "proposed" ? "提议" : d.status;
        lines.push(`  - #${d.id} [${status}] ${clip(d.text, textCap)}${sourceAnchor(d)}${shareMark(d)}`);
      });
      lines.push("基于最近决策行动；如有冲突需先确认，不要自行推翻。");
    }
  }

  if (goals.length > 0 && situation !== "post-compact") {
    section(goals.length > listLimit ? `目标（前 ${listLimit}/${goals.length}）：` : `目标（${goals.length}）：`);
    goals
      .slice()
      .reverse()
      .slice(0, listLimit)
      .forEach((g) => lines.push(`  - #${g.id} ${clip(g.text, textCap)}${sourceAnchor(g)}${shareMark(g)}`));
  }
  if ((decisions.length > 0 || anti !== undefined) && situation !== "new-session") {
    // 无生效决策但有反例：区块以反例示人；有生效决策：反例行附于末尾（[被取代]/[已废弃] 标记与生效项区分）
    section(
      decisions.length > 0
        ? decisions.length > listLimit
          ? `决策（前 ${listLimit}/${decisions.length}）：`
          : `决策（${decisions.length}）：`
        : "最近废弃：",
    );
    decisions.slice(0, listLimit).forEach((d) => lines.push(`  - #${d.id} ${clip(d.text, textCap)}${sourceAnchor(d)}${shareMark(d)}`));
    if (anti) {
      lines.push(`  - #${anti.id} [${anti.tag}] ${clip(anti.text, textCap)}${sourceAnchor(anti)}${shareMark(anti)}`);
    }
  }
  if (feedback.length > 0) {
    section(`偏好（${feedback.length}）：`);
    feedback.forEach((f) => lines.push(`  - #${f.id} ${clip(f.text, textCap)}${sourceAnchor(f)}${shareMark(f)}`));
  }
  if (recent.length > 0) {
    section(`最近事件（${recent.length}）：`);
    // 新→旧：getRecentEvents 已按 id DESC，直接展示与区块语义一致
    recent.forEach((e) => lines.push(`  - [${e.kind}] ${clip(e.body, eventCap)}`));
  }
  // 待处理事项唤醒（§1.5.3d 通道二 + 2026-08-20 复盘修复 + 2026-08-21 收件箱化）：计数 + 前 2 条原文——
  // 无 UI 环境（headless）折叠卡片不触发，候选堆积数天未决（狗粮实证）；完成/转正/丢弃走
  // /thread-cfm do/cnl，原文入卡让模型可向用户转述推进，修复"重要决策既不转正又被实际遵循"的脱节
  if (!isolated) {
    try {
      const pending = store.listPendingCandidates({ sessionId, projectKey });
      if (pending.length > 0) {
        section(`待处理候选（${pending.length}）：`);
        pending
          .slice(0, 2)
          .forEach((c) => lines.push(`  - c#${c.id} [${c.kind === "decision" ? "决策" : "偏好"}] ${clip(c.text, 60)}`));
        lines.push("候选转正前不得当正式决策执行，处理经 /thread-cfm。");
      }
    } catch {
      // 失败降级，不阻塞
    }
  }
  // 收束语（外部借鉴③）：绑定式行动收束，防止纯"再想想"式开放引导
  if (lines.length > 1) lines.push("");
  lines.push("需要更早的历史细节时，调用 query_session_memory 工具查询，并基于结果给出结论。");
  lines.push("收到 Thread 管理命令（/thread-reg /thread-rev /thread-cfm /thread-iso /thread-uniso /thread-pub）或\"隔离/静默\"指令时，只回一句状态确认，不展开思考。");

  return lines.slice(0, budgetLines).join("\n");
}

// 情境判定（程序确定性，§1.5）：供适配器在 pre-step 调用。
// new-session = 首轮且项目已有历史（跨会话续接）；post-compact = 最近事件是压缩 checkpoint；
// decision-change = 项目最近决策晚于本会话最新事件（会话外新定，防基于旧状态行动）。
export function detectSituation(
  store: ThreadStore,
  opts: { sessionId: string; turn: number; projectKey?: string },
): StatusCardSituation {
  if (opts.turn === 1) {
    // 首轮：本会话无事件（新会话）但项目有历史 → 续接情境（跨会话）
    const own = store.getRecentEvents(opts.sessionId, 1);
    if (own.length === 0) {
      const merged = store.getActiveDecisionsMerged(opts.sessionId, opts.projectKey);
      const goals = store.getActiveGoalsMerged(opts.sessionId, opts.projectKey);
      if (merged.length > 0 || goals.length > 0) {
        return "new-session";
      }
    }
  }
  try {
    const recent = store.getRecentEvents(opts.sessionId, 3);
    if (recent.some((e) => e.kind === "compact_checkpoint")) {
      return "post-compact";
    }
    // 决策变更：项目最近决策的 updated_at 晚于本会话最新事件时间（会话外新定）
    if (recent.length > 0) {
      const latestEventTs = recent[0].ts;
      const recentDecisions = store.getRecentDecisionsMerged(opts.sessionId, opts.projectKey, 1);
      if (recentDecisions.length > 0 && recentDecisions[0].updated_at > latestEventTs) {
        return "decision-change";
      }
    }
  } catch {
    // 判定失败降级为 normal，不阻塞注入
  }
  return "normal";
}
