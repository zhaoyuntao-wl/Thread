// 进展脉络（2026-09-02 R2，四格第一项，确定性聚合）：
// 把结构化表的变更时间线（决策/目标/产出/待办）聚合成"做到哪一步/下一步"的确定性表达。
// 零 LLM：来源全部是写时即有的结构化行；与状态卡同视图（merged + scope 优先级 + 隔离语义）。
// 送达：new-session 接续块 + post-compact 压缩回归块（"下一步" = 最新 pending 待办）。
// 设计依据：用户情境调研 P0 情境（压缩后失忆/新会话断链）+ AML"时间与事件序列"维度。
import type { ThreadStore } from "./store.js";
import { applyScopePriority } from "./store.js";

export interface ProgressRow {
  ts: string;
  type: "决策" | "目标" | "产出" | "待办";
  id: number;
  text: string;
  session_id: string;
  scope?: string | null;
  tag?: string;
}

export interface BuildProgressOptions {
  sessionId: string;
  projectKey?: string;
  limit?: number;
  isolated?: boolean;
}

function dateOf(ts: string | null | undefined): string {
  return (ts ?? "").slice(0, 10);
}

export function buildProgressTimeline(store: ThreadStore, opts: BuildProgressOptions): ProgressRow[] {
  const limit = opts.limit ?? 5;
  const rows: ProgressRow[] = [];
  try {
    if (opts.isolated) {
      for (const d of store.getDecisions(opts.sessionId)) {
        rows.push({
          ts: dateOf(d.updated_at),
          type: "决策",
          id: d.id,
          text: d.text,
          session_id: d.session_id,
          scope: d.scope,
          tag: d.status === "superseded" ? "被取代" : d.status === "revoked" ? "已废弃" : undefined,
        });
      }
      for (const g of store.getActiveGoals(opts.sessionId)) {
        rows.push({ ts: dateOf(g.updated_at ?? g.created_at), type: "目标", id: g.id, text: g.text, session_id: g.session_id, scope: g.scope });
      }
    } else {
      for (const d of applyScopePriority(store.getRecentDecisionsMerged(opts.sessionId, opts.projectKey, 30))) {
        rows.push({
          ts: dateOf(d.updated_at),
          type: "决策",
          id: d.id,
          text: d.text,
          session_id: d.session_id,
          scope: d.scope,
          tag: d.status === "superseded" ? "被取代" : d.status === "revoked" ? "已废弃" : undefined,
        });
      }
      for (const g of applyScopePriority(store.getActiveGoalsMerged(opts.sessionId, opts.projectKey))) {
        rows.push({ ts: dateOf(g.updated_at ?? g.created_at), type: "目标", id: g.id, text: g.text, session_id: g.session_id, scope: g.scope });
      }
    }
    for (const a of store.listAssets({ visibleToSession: opts.sessionId, limit: 30 })) {
      rows.push({ ts: dateOf(a.created_at), type: "产出", id: a.id, text: `${a.title}（${a.path}）`, session_id: a.session_id });
    }
    for (const t of store.listTodos({ visibleToSession: opts.sessionId, status: "pending", limit: 30 })) {
      rows.push({ ts: dateOf(t.created_at), type: "待办", id: t.id, text: t.text, session_id: t.session_id });
    }
  } catch {
    // 进展脉络是卡片增强，任何失败降级为空，绝不阻塞
  }
  rows.sort((a, b) => (b.ts === a.ts ? b.id - a.id : b.ts < a.ts ? 1 : -1));
  return rows.slice(0, limit);
}
