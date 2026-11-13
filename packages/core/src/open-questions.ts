import type { ThreadStore } from "./store.js";

export type OpenQuestionStatus = "open" | "continued" | "settled" | "timed_out" | "cancelled";

export interface OpenQuestion {
  id: number;
  project_key: string;
  session_id: string;
  call_id: string;
  questions_json: string;
  timed: number;
  deadline: string | null;
  status: OpenQuestionStatus;
  answers_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface QuestionInput {
  projectKey: string;
  sessionId: string;
  callId: string;
  questions: unknown;
  timed?: boolean;
  deadline?: string | null;
}

// 阻塞性问题通道（P0-3）：模型问用户的阻塞问题必须进收件箱，
// 不能超时后静默继续（否则等于模型替用户做了选择）。
export function recordOpenQuestion(store: ThreadStore, input: QuestionInput): number {
  const result = store.structuredDb
    .prepare(
      `INSERT INTO open_questions (project_key, session_id, call_id, questions_json, timed, deadline, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      input.projectKey,
      input.sessionId,
      input.callId,
      JSON.stringify(input.questions ?? []),
      input.timed === true ? 1 : 0,
      input.deadline ?? null,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

export function listOpenQuestions(
  store: ThreadStore,
  opts: { projectKey?: string; sessionId?: string; status?: OpenQuestionStatus; limit?: number } = {},
): OpenQuestion[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectKey !== undefined) {
    where.push("project_key = ?");
    params.push(opts.projectKey);
  }
  if (opts.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.status !== undefined) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const sql = `SELECT * FROM open_questions${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${opts.limit ?? 50}`;
  return store.structuredDb.prepare(sql).all(...params) as OpenQuestion[];
}

export function settleOpenQuestion(
  store: ThreadStore,
  id: number,
  status: Exclude<OpenQuestionStatus, "open">,
  answers?: unknown,
): boolean {
  const result = store.structuredDb
    .prepare(`UPDATE open_questions SET status = ?, answers_json = COALESCE(?, answers_json), resolved_at = ? WHERE id = ?`)
    .run(status, answers === undefined ? null : JSON.stringify(answers), new Date().toISOString(), id);
  return result.changes > 0;
}

// 超时后把"模型假设的答案"落成待确认候选（不静默替用户做决定，也不直接变成正式决策）。
export function markTimedOut(
  store: ThreadStore,
  id: number,
  assumption: string,
): { settled: boolean; candidateId?: number } {
  const row = store.structuredDb.prepare("SELECT * FROM open_questions WHERE id = ?").get(id) as OpenQuestion | undefined;
  if (row === undefined) return { settled: false };
  settleOpenQuestion(store, id, "timed_out", { assumption });
  const candidate = store.addPendingCandidate({
    sessionId: row.session_id,
    text: `条件：问题 #${id} 未获回答；假设：${assumption}（待人工复核）`,
    kind: "decision",
    projectKey: row.project_key,
  });
  return { settled: true, candidateId: candidate.id };
}

export function openQuestionCount(store: ThreadStore, opts: { projectKey?: string; sessionId?: string } = {}): number {
  return listOpenQuestions(store, { ...opts, status: "open", limit: 200 }).length;
}

export function renderQuestionLine(count: number): string {
  return count === 0 ? "待答问题：无" : `待答问题 ${count} 条（未答前不应假设答案继续）`;
}
