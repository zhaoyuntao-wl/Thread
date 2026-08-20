import { navigate, type NavigateOptions, type NavResult } from "./nav.js";
import { queryEvents, queryMemory, queryStructured } from "./query.js";
import type { ThreadStore } from "./store.js";

// 统一查询处理器（G3：MCP server 与 dsh 原生工具共用同一实现，防两处漂移）。
// 路由：nav 指令 → navigate()；kind/since/until/order/count → 精确路径；其余 → BM25 语义检索。

export interface QueryToolArgs {
  query?: string;
  kind?: string;
  nav?: NavigateOptions["nav"];
  target?: string;
  limit?: number;
  session_id?: string;
  since?: string;
  until?: string;
  order?: "asc" | "desc";
  count_only?: boolean;
  token_budget?: number;
}

export interface QueryToolResult {
  text: string;
  session_isolation: boolean | null;
}

const TABLE_KIND: Record<string, "goals" | "decisions" | "feedback"> = {
  goal: "goals",
  decision: "decisions",
  feedback: "feedback",
};
const EVENT_KINDS = ["user_message", "assistant_message", "tool_call", "tool_result", "compact_checkpoint"] as const;

export function runQueryTool(store: ThreadStore, args: QueryToolArgs): QueryToolResult {
  const sessionId = args.session_id ?? store.getRecentSessionId();
  const isolation = sessionId ? store.getSessionIsolation(sessionId) : null;

  // nav 导航指令（max 2.5）：ls/cd/cat/grep
  if (args.nav) {
    const result: NavResult = navigate(store, {
      nav: args.nav,
      target: args.target,
      query: args.query,
      sessionId: sessionId,
      viewerSessionId: sessionId,
      limit: args.limit,
    });
    return { text: JSON.stringify(result, null, 2), session_isolation: isolation };
  }

  if (!sessionId) {
    return {
      text: JSON.stringify({ status: "not-found", results: [], note: "会话记忆为空：尚无事件写入。", session_isolation: null }, null, 2),
      session_isolation: null,
    };
  }

  const table = typeof args.kind === "string" ? TABLE_KIND[args.kind] : undefined;
  const eventKind = typeof args.kind === "string" && (EVENT_KINDS as readonly string[]).includes(args.kind) ? (args.kind as (typeof EVENT_KINDS)[number]) : undefined;
  const structured =
    args.kind !== undefined ||
    args.since !== undefined ||
    args.until !== undefined ||
    args.order !== undefined ||
    args.count_only === true;
  const result = table
    ? queryStructured(store, {
        sessionId,
        table,
        order: args.order,
        limit: args.limit,
        count: args.count_only,
      })
    : structured
      ? queryEvents(store, {
          sessionId,
          kind: eventKind,
          timeRange: { since: args.since, until: args.until },
          order: args.order,
          limit: args.limit,
          count: args.count_only,
        })
      : queryMemory(store, args.query ?? "", {
          tokenBudget: args.token_budget,
          sessionId,
          limit: args.limit,
        });
  return { text: JSON.stringify({ ...result, session_isolation: isolation }, null, 2), session_isolation: isolation };
}
