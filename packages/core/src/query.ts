import type { ThreadStore } from "./store.js";
import type { EventKind } from "./events.js";

export interface QueryOptions {
  tokenBudget?: number;
  sessionId?: string;
  limit?: number;
}

export interface QueryHit {
  segment_id: number;
  kind: string;
  ts: string;
  seq: number;
  body: string;
  score: number;
}

export type QueryStatus = "found" | "degraded" | "not-found";

export interface QueryResult {
  status: QueryStatus;
  results: QueryHit[];
  note?: string;
}

// 结构化查询（抽查/审计路径）：时间范围 / kind 过滤 / 排序 / 计数——接口内聚，不新增工具
export interface StructuredQueryOptions {
  sessionId?: string;
  timeRange?: { since?: string; until?: string };
  kind?: EventKind | EventKind[];
  order?: "asc" | "desc";
  limit?: number;
  count?: boolean;
}

export interface StructuredQueryResult {
  status: "found" | "not-found";
  results: QueryHit[];
  count?: number;
}

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 2;
const KIND_LABELS: Record<string, string> = {
  user_message: "user",
  assistant_message: "assistant",
  tool_call: "tool_call",
  tool_result: "tool_result",
  session_start: "session_start",
  session_end: "session_end",
  compact_checkpoint: "compact",
};

export function queryMemory(
  store: ThreadStore,
  query: string,
  opts: QueryOptions = {},
): QueryResult {
  const hits = store.search(query, { limit: opts.limit ?? 20, sessionId: opts.sessionId });

  if (hits.length === 0) {
    const fallback = findEpisodeSummary(store, opts.sessionId, query);
    if (fallback) {
      return {
        status: "degraded",
        results: [fallback],
        note: "精确检索未命中，已退回情节摘要。",
      };
    }
    return {
      status: "not-found",
      results: [],
      note: buildNotFoundNote(query),
    };
  }

  const budgetChars = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;
  const results: QueryHit[] = [];
  let used = 0;
  for (const h of hits) {
    const item: QueryHit = {
      segment_id: h.id,
      kind: KIND_LABELS[h.kind] ?? h.kind,
      ts: h.ts,
      seq: h.seq,
      body: h.body,
      score: h.score,
    };
    const cost = item.body.length + 64;
    if (used + cost > budgetChars && results.length > 0) {
      break;
    }
    results.push(item);
    used += cost;
  }

  return { status: "found", results };
}

// 结构化事件查询：精确时序/过滤/计数，不走 FTS——服务层抽查/审计路径（接口内聚，单一工具内路由）
export function queryEvents(store: ThreadStore, opts: StructuredQueryOptions): StructuredQueryResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sessionId) {
    // 当前会话可见自己的全部内容（含隔离），其他会话只见未隔离行
    where.push("(session_id = ? OR isolation = 0)");
    params.push(opts.sessionId);
  } else {
    where.push("isolation = 0");
  }
  if (opts.timeRange?.since) {
    where.push("ts >= ?");
    params.push(opts.timeRange.since);
  }
  if (opts.timeRange?.until) {
    where.push("ts <= ?");
    params.push(opts.timeRange.until);
  }
  if (opts.kind) {
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind];
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  if (opts.count) {
    const row = store.eventsDb.prepare(`SELECT COUNT(*) AS c FROM events ${whereSql}`).get(...params) as { c: number };
    return { status: row.c > 0 ? "found" : "not-found", results: [], count: row.c };
  }

  const order = opts.order === "asc" ? "ASC" : "DESC";
  const limit = Math.min(opts.limit ?? 20, 50);
  const rows = store.eventsDb
    .prepare(
      `SELECT id, session_id, kind, ts, seq, body, truncated FROM events ${whereSql} ORDER BY ts ${order}, id ${order} LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number;
    session_id: string;
    kind: EventKind;
    ts: string;
    seq: number;
    body: string;
    truncated: number;
  }>;
  if (rows.length === 0) {
    return { status: "not-found", results: [] };
  }
  return {
    status: "found",
    results: rows.map((r) => ({
      segment_id: r.id,
      kind: KIND_LABELS[r.kind] ?? r.kind,
      ts: r.ts,
      seq: r.seq,
      body: r.body,
      score: 0,
    })),
  };
}

function findEpisodeSummary(
  store: ThreadStore,
  sessionId: string | undefined,
  query: string,
): QueryHit | undefined {
  if (!sessionId) {
    return undefined;
  }
  const episode = store.getLatestEpisodeWithSummary(sessionId);
  const summary = episode?.summary;
  if (!summary) {
    return undefined;
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.every((t) => summary.includes(t))) {
    return undefined;
  }
  return {
    segment_id: episode.id,
    kind: "summary",
    ts: episode.created_at,
    seq: episode.seq_start,
    body: summary,
    score: 0,
  };
}

function buildNotFoundNote(query: string): string {
  return [
    `会话记忆中未检索到与「${query.slice(0, 100)}」相关的内容。`,
    "建议：",
    "1. 换用更具体的关键词（文件路径、函数名、命令）重试；",
    "2. 该信息可能在更早的会话或外部资料中，可扩大查询范围或直接补充说明；",
    "3. 请补充触发该信息的上下文，以便继续定位。",
  ].join("\n");
}
