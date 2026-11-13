import type { ThreadStore, Handoff } from "./store.js";
import { progressFor, renderEvidenceLine } from "./verification.js";

export interface HandoffBrief {
  goal: string;
  decisions: Array<{ id: number; text: string }>;
  open: string[];
  next: string[];
  artifacts: string[];
  conditions: string[];
  acceptance?: string;
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
  // 验收证据进交接（P0-2）：接手方一眼看到哪些验收条目还没证，避免"以为做完了"
  const acceptanceProgress = store.projectKey === undefined ? { proven: 0, total: 0, missing: [] } : progressFor(store, store.projectKey);
  const acceptanceField = acceptanceProgress.total > 0 ? { acceptance: renderEvidenceLine(acceptanceProgress) } : {};

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
    ...acceptanceField,
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
  if (brief.acceptance !== undefined) lines.push(`验收：${brief.acceptance}`);
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

export interface ProposeHandoffInput {
  toRole?: string;
  toSession?: string;
  goal?: string;
  decisions?: string[];
  open?: string[];
  next?: string[];
  artifacts?: string[];
}

// 模型侧提议（§1.4b.7 在线触发之一）：以当前会话状态为底，允许覆盖目标/决策/未决/下一步/产物。
// 同一会话同目标已存在 pending 时复用，避免模型每轮重复提议造成重复交接。
export function proposeHandoff(
  store: ThreadStore,
  sessionId: string,
  input: ProposeHandoffInput,
  opts: { projectKey?: string; taskId?: string; fromRole?: string } = {},
): Handoff {
  const base = buildCloseOutBrief(store, sessionId);
  const goal = input.goal ?? base.goal;
  const brief: HandoffBrief = {
    goal,
    decisions: input.decisions === undefined
      ? base.decisions
      : input.decisions.map((text, i) => ({ id: i + 1, text })),
    open: input.open ?? base.open,
    next: input.next ?? base.next,
    artifacts: input.artifacts ?? base.artifacts,
    conditions: base.conditions,
  };
  const projectKey = opts.projectKey ?? store.projectKey;
  const duplicate = store
    .listHandoffs({ projectKey, fromSession: sessionId, status: "pending", limit: 20 })
    .find((row) => parseBrief(row.brief_json).goal === goal);
  if (duplicate !== undefined) return duplicate;
  return store.addHandoff({
    projectKey,
    taskId: opts.taskId,
    fromSession: sessionId,
    fromRole: opts.fromRole,
    toSession: input.toSession,
    toRole: input.toRole,
    brief,
  });
}

// 编排器动词（§1.4b.7）：原子领取一条待投递交接（领取即 delivered），ack 才推进到终态。
// 两个 worker 并发调用不会拿到同一条：claim 是单条 UPDATE … RETURNING。
export function nextHandoff(
  store: ThreadStore,
  opts: { taskId?: string; role?: string; projectKey?: string } = {},
): { handoff: Handoff; brief: HandoffBrief } | null {
  const handoff = store.claimHandoff({
    projectKey: opts.projectKey ?? store.projectKey,
    ...(opts.taskId === undefined ? {} : { taskId: opts.taskId }),
    ...(opts.role === undefined ? {} : { toRole: opts.role }),
  });
  if (handoff === undefined) return null;
  return { handoff, brief: parseBrief(handoff.brief_json) };
}

export function ackHandoff(store: ThreadStore, id: number): boolean {
  const row = store.getHandoff(id);
  if (row === undefined) return false;
  if (row.status === "ack") return true;
  return store.setHandoffStatus(id, "ack");
}

