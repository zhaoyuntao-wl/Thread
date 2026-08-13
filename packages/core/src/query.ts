import type { ThreadStore } from "./store.js";

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
