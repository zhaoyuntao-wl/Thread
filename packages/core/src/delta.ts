import type { ThreadStore } from "./store.js";

// 跨会话状态变更 delta（G5，max 设计 2.3.2）：多 Agent 共享协作增量推送。
// 数据源 = goals / decisions / feedback / pending_candidates 的 updated_at（v8 补齐，COALESCE 兜底 created_at）。
// 隔离语义：写入方 isolation=1 的行对查看方不可见；查看方隔离时本函数不返回跨会话行（调用方自行跳过 delta）。

export interface StateDeltaItem {
  id: number;
  text: string;
  session_id: string;
  updated_at: string;
  status?: string;
  kind?: string;
}

export interface StateDelta {
  goals: StateDeltaItem[];
  decisions: StateDeltaItem[];
  feedback: StateDeltaItem[];
  pending: StateDeltaItem[];
}

export interface StateDeltaOptions {
  projectKey?: string;
  since: string;
  excludeSessionId: string;
  viewerSessionId: string;
  limit?: number;
}

export function getStateDelta(store: ThreadStore, opts: StateDeltaOptions): StateDelta {
  const limit = opts.limit ?? 5;
  const read = (table: string, tsCol: string, extraCols: string[]): StateDeltaItem[] => {
    const select = extraCols.map((c) => c).join(", ");
    const rows = store.structuredDb
      .prepare(
        `SELECT id, text, session_id, COALESCE(${tsCol}, created_at) AS updated_at${select ? `, ${select}` : ""}
         FROM ${table}
         WHERE COALESCE(${tsCol}, created_at) > ?
           AND session_id != ?
           AND (isolation = 0 OR session_id = ?)
           AND (? IS NULL OR project_key = ?)
         ORDER BY COALESCE(${tsCol}, created_at) DESC
         LIMIT ?`,
      )
      .all(opts.since, opts.excludeSessionId, opts.viewerSessionId, opts.projectKey ?? null, opts.projectKey ?? null, limit) as StateDeltaItem[];
    return rows;
  };
  return {
    goals: read("goals", "updated_at", ["status"]),
    decisions: read("decisions", "updated_at", ["status"]),
    feedback: read("feedback", "updated_at", ["kind"]),
    pending: read("pending_candidates", "updated_at", ["status", "kind"]),
  };
}

// delta 块渲染（2.3.2 格式）：无变更返回 undefined（零注入）
export function renderStateDelta(delta: StateDelta): string | undefined {
  const lines: string[] = [];
  for (const d of delta.decisions) {
    const status = d.status === "active" ? "生效" : d.status === "proposed" ? "提议" : d.status ?? "";
    lines.push(`▸ 新决策: ${d.text}（${shortSession(d.session_id)} #${d.id}${status ? ` ${status}` : ""}）`);
  }
  for (const g of delta.goals) {
    const status = g.status && g.status !== "active" ? ` ${g.status}` : "";
    lines.push(`▸ 目标变更: ${g.text}（${shortSession(g.session_id)}${status}）`);
  }
  for (const f of delta.feedback) {
    lines.push(`▸ 新偏好: ${f.text}（${shortSession(f.session_id)}）`);
  }
  for (const p of delta.pending) {
    lines.push(`▸ 待确认候选: ${p.text}（${shortSession(p.session_id)} ${p.status ?? "pending"}）`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  return `[Thread 状态更新（来自其他会话）]\n${lines.join("\n")}`;
}

function shortSession(sessionId: string): string {
  const cleaned = sessionId.replace(/^session-/, "");
  return cleaned.slice(0, 7);
}
