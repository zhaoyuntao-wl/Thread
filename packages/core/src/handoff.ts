import type { ThreadStore, Handoff } from "./store.js";

export interface HandoffBrief {
  goal: string;
  decisions: Array<{ id: number; text: string }>;
  open: string[];
  next: string[];
  artifacts: string[];
  conditions: string[];
}

export interface CloseOutOptions {
  projectKey?: string;
  taskId?: string;
  fromRole?: string;
  toRole?: string;
  toSession?: string;
  maxDecisions?: number;
  ts?: string;
}

const MAX_OPEN = 3;
const MAX_NEXT = 3;
const MAX_ARTIFACTS = 5;

export function buildCloseOutBrief(
  store: ThreadStore,
  sessionId: string,
  opts: { maxDecisions?: number } = {},
): HandoffBrief {
  const maxDecisions = opts.maxDecisions ?? 3;
  const goals = store.getActiveGoals(sessionId);
  const decisions = store.getActiveDecisions(sessionId);
  const proposed = store.getDecisions(sessionId, "proposed");
  const todos = store.listTodos({ sessionId, status: "pending" });
  const assets = store.listAssets({ sessionId });
  const pending = store.pendingCount({ sessionId });

  const brief: HandoffBrief = {
    goal: goals[0]?.text ?? decisions[0]?.text ?? "（无进行中目标）",
    decisions: decisions
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, maxDecisions)
      .map((d) => ({ id: d.id, text: d.text })),
    open: [
      ...(pending > 0 ? [`待确认候选 ${pending} 条`] : []),
      ...proposed.map((d) => `#${d.id} ${d.text}（proposed）`).slice(0, MAX_OPEN),
    ].slice(0, MAX_OPEN),
    next: todos.map((t) => t.text).slice(0, MAX_NEXT),
    artifacts: assets.map((a) => a.path).slice(0, MAX_ARTIFACTS),
    conditions: decisions
      .filter((d) => d.text.includes("条件："))
      .map((d) => `#${d.id} ${d.text}`)
      .slice(0, 2),
  };
  return brief;
}

export function isEmptyBrief(brief: HandoffBrief): boolean {
  return brief.decisions.length === 0 && brief.next.length === 0 && brief.artifacts.length === 0;
}

export function createCloseOutHandoff(
  store: ThreadStore,
  sessionId: string,
  opts: CloseOutOptions = {},
): Handoff | null {
  const brief = buildCloseOutBrief(store, sessionId, { maxDecisions: opts.maxDecisions });
  if (isEmptyBrief(brief)) return null;
  const existing = store.listHandoffs({
    projectKey: opts.projectKey ?? store.projectKey,
    taskId: opts.taskId,
    fromSession: sessionId,
    status: "pending",
    limit: 1,
  });
  if (existing.length > 0) return existing[0];
  return store.addHandoff({
    projectKey: opts.projectKey ?? store.projectKey,
    taskId: opts.taskId,
    fromSession: sessionId,
    fromRole: opts.fromRole,
    toSession: opts.toSession,
    toRole: opts.toRole,
    brief,
    ts: opts.ts,
  });
}

export function pendingHandoffsFor(
  store: ThreadStore,
  opts: { projectKey?: string; taskId?: string; role?: string; sessionId?: string; limit?: number },
): Handoff[] {
  return store.listHandoffs({
    projectKey: opts.projectKey ?? store.projectKey,
    taskId: opts.taskId,
    toSession: opts.sessionId,
    toRole: opts.role,
    status: "pending",
    limit: opts.limit ?? 5,
  });
}

export function renderBrief(brief: HandoffBrief, handoffId?: number): string {
  const lines: string[] = [`[Thread 交接] 目标：${brief.goal}`];
  if (brief.conditions.length > 0) lines.push(`条件：${brief.conditions.join("；")}`);
  if (brief.decisions.length > 0) {
    lines.push(`决策（${brief.decisions.length}）：${brief.decisions.map((d) => `#${d.id} ${d.text}`).join("；")}`);
  }
  if (brief.open.length > 0) lines.push(`未决：${brief.open.join("；")}`);
  if (brief.next.length > 0) lines.push(`下一步：${brief.next.join("；")}`);
  if (brief.artifacts.length > 0) lines.push(`产物：${brief.artifacts.join(", ")}`);
  lines.push(
    handoffId === undefined
      ? "细节用 query_session_memory 取；文档是产物层，本交接只放指针与摘要。"
      : `细节用 query_session_memory kind=handoff id=${handoffId} 取；文档是产物层，本交接只放指针与摘要。`,
  );
  return lines.join("\n");
}

export function parseBrief(json: string): HandoffBrief {
  const raw = JSON.parse(json) as Partial<HandoffBrief>;
  return {
    goal: raw.goal ?? "",
    decisions: raw.decisions ?? [],
    open: raw.open ?? [],
    next: raw.next ?? [],
    artifacts: raw.artifacts ?? [],
    conditions: raw.conditions ?? [],
  };
}
