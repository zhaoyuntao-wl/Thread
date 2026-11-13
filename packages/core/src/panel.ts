import type { ThreadStore } from "./store.js";
import { queryEvents } from "./query.js";
import { lastInjection } from "./receipt.js";
import { listEvidenceRows, progressFor, renderEvidenceLine } from "./verification.js";
import { listOpenQuestions } from "./open-questions.js";

export interface PanelOptions {
  sessionId: string;
  projectKey?: string;
  limit?: number;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

// 只读面板（P0-0）：目标 / 决策链（含取代关系）/ 未决 / 交接 / 最近事件。
// 纯文本、底座无关——同一个渲染器给命令、MCP 工具、演示脚本共用。
export function renderPanel(store: ThreadStore, opts: PanelOptions): string {
  const limit = opts.limit ?? 5;
  const lines: string[] = ["[Thread 面板]"];

  // 目标取会话 + 项目级合并：北极星这类目标由别的会话登记，只看会话会显示"无目标"（2026-11-13 实测）
  const goals = opts.projectKey === undefined ? store.getActiveGoals(opts.sessionId) : store.getActiveGoalsMerged(opts.sessionId, opts.projectKey);
  lines.push("", `目标（${goals.length}）：`);
  if (goals.length === 0) lines.push("  - （无进行中目标）");
  for (const goal of goals.slice(0, limit)) lines.push(`  - #${goal.id} ${clip(goal.text, 100)}`);

  const active = store.getActiveDecisions(opts.sessionId);
  const superseded = store.getDecisions(opts.sessionId, "superseded");
  lines.push("", `决策链（生效 ${active.length} · 已被取代 ${superseded.length}）：`);
  if (active.length === 0) lines.push("  - （无生效决策）");
  for (const row of active.slice(0, limit)) lines.push(`  - #${row.id} ${clip(row.text, 100)}`);
  for (const row of superseded.slice(0, limit)) {
    const to = row.superseded_by === null ? "?" : `#${row.superseded_by}`;
    lines.push(`  - #${row.id} [superseded → ${to}] ${clip(row.text, 80)}`);
  }

  const proposed = store.getDecisions(opts.sessionId, "proposed");
  const pending = store.pendingCount({ sessionId: opts.sessionId });
  lines.push("", `未决（候选 ${pending} · proposed ${proposed.length}）：`);
  if (pending === 0 && proposed.length === 0) lines.push("  - （无）");
  for (const row of proposed.slice(0, limit)) lines.push(`  - #${row.id} ${clip(row.text, 90)}（proposed）`);

  const receipt = lastInjection(store, opts.sessionId);
  lines.push("", "本轮注入：");
  lines.push(receipt === undefined ? "  - （本会话还没有注入记录）" : `  - ${receipt.ts} [${receipt.kind}] ${clip(receipt.summary, 120)}`);

  lines.push("", "待答问题：");
  const asks = listOpenQuestions(store, {
    ...(opts.projectKey === undefined ? {} : { projectKey: opts.projectKey }),
    status: "open",
    limit,
  });
  if (asks.length === 0) {
    lines.push("  - （无）");
  } else {
    for (const ask of asks) {
      let text = "";
      try {
        const parsed = JSON.parse(ask.questions_json) as Array<{ question?: string }>;
        text = parsed[0]?.question ?? "";
      } catch {
        text = "";
      }
      lines.push(`  - #${ask.id} ${clip(text, 70)}（call ${ask.call_id}）`);
    }
  }
  // 已关闭的问题（settled/cancelled/timed_out）：回答后回看用，也是"采集是否生效"的验证入口
  const closed = ["settled", "cancelled", "timed_out"].flatMap((status) =>
    listOpenQuestions(store, {
      ...(opts.projectKey === undefined ? {} : { projectKey: opts.projectKey }),
      status: status as "settled" | "cancelled" | "timed_out",
      limit,
    }),
  );
  closed.sort((a, b) => b.id - a.id);
  if (closed.length > 0) {
    lines.push(`  已关闭 ${closed.length} 条（最近）：`);
    for (const ask of closed.slice(0, limit)) {
      lines.push(`  - #${ask.id} [${ask.status}] ${clip(ask.questions_json, 60)}`);
    }
  }

  lines.push("", "验收证据：");
  if (opts.projectKey === undefined) {
    lines.push("  - （缺少项目键，无法计算验收进度）");
  } else {
    const progress = progressFor(store, opts.projectKey);
    if (progress.total === 0) {
      lines.push("  - （未登记验收条目）");
    } else {
      lines.push(`  - ${renderEvidenceLine(progress)}`);
      // 每个验收条目只显示最新一条证据（历史保留在库中，避免面板被重跑记录淹没）
      const rows = listEvidenceRows(store, { projectKey: opts.projectKey });
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!latest.has(row.criterion)) latest.set(row.criterion, row);
      }
      for (const row of [...latest.values()].slice(0, limit)) {
        const mark = row.passed === 1 ? "✓" : "✗";
        lines.push(`  - ${mark} ${row.criterion} exit=${row.exit ?? "?"} ${clip(row.command ?? "", 60)}`);
      }
    }
  }

  const handoffs = store.listHandoffs({ status: undefined, limit: limit * 2 });
  const live = handoffs.filter((h) => h.status !== "ack");
  lines.push("", `交接（未确认 ${live.length}）：`);
  if (live.length === 0) lines.push("  - （无）");
  for (const row of live.slice(0, limit)) {
    let goal = "";
    try {
      goal = String((JSON.parse(row.brief_json) as { goal?: string }).goal ?? "");
    } catch {
      goal = "";
    }
    const target = row.to_role === null ? "project" : row.to_role;
    lines.push(`  - #${row.id} [${row.status}] ${clip(goal, 70)}（from ${row.from_session} · to ${target}）`);
  }

  const events = queryEvents(store, { sessionId: opts.sessionId, order: "desc", limit: limit }).results;  lines.push("", `最近事件（${events.length}）：`);
  if (events.length === 0) lines.push("  - （无）");
  for (const event of events) lines.push(`  - ${event.ts} ${event.kind} ${clip(event.body, 80)}`);

  return lines.join("\n");
}
