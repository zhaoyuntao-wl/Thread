# @thread/core API Reference

Thread core: base-agnostic session memory for coding agents — lossless event
pipeline, structured tables (goals/decisions/feedback), lineage graph, BM25 retrieval.

All exports are re-exported from the package root. TypeScript declarations ship
in `dist/*.d.ts`; this document summarizes the stable public surface.

## Quick start

```ts
import { ThreadStore, applyAnalysis, buildStatusCard, queryMemory } from "@thread/core";

const store = new ThreadStore({ eventsPath, structuredPath, projectKey });

store.append(
  { session_id: "s1", kind: "user_message", ts: new Date().toISOString(), body: "帮我实现登录功能" },
  { origin: "demo://msg#1", projectKey },
);
applyAnalysis(store, "s1", { user_msg: "帮我实现登录功能" }, { projectKey });

const card = buildStatusCard(store, { sessionId: "s1", projectKey, budgetLines: 200 });
const hits = queryMemory(store, "JWT 认证", { sessionId: "s1" });
const goals = store.getActiveGoals("s1");

store.close();
```

## ThreadStore

```ts
class ThreadStore {
  constructor(opts: ThreadStoreOptions, spillPolicy?: SpillPolicy);
  close(): void;
}
```

### Event pipeline

| Method | Description |
|---|---|
| `append(event, opts?)` | Append one event; idempotent on `opts.origin` (same origin returns the existing row). Transactional: idempotency check → truncation → insert → spill → FTS → lineage → episode. |
| `getRecentEvents(sessionId, limit?)` | Latest events for a session, newest first. |
| `getRecentSessionId()` | Session id of the most recent event. |
| `expand(eventId)` | Recover the full body of a spilled event from the spills table; returns body + missing marker when unrecoverable. |
| `hasAssistantTurn(sessionId, uuid)` | True if an assistant turn with this uuid was already stored. |
| `setSessionIsolation(sessionId, isolated)` / `getSessionIsolation(sessionId)` | Per-session isolation switch (B⑧). Isolated rows (messages/decisions/feedback) are visible only to their own session across merged views, search, queryEvents, expand, and lineage; tool events always stay shared. |
| `unisolateRow(sessionId, table, id)` | Publish one isolated structured row (goals/decisions/feedback) back to shared visibility. |

### Structured tables

| Method | Description |
|---|---|
| `addGoal(sessionId, text, opts?)` / `getActiveGoals(sessionId)` / `updateGoalStatus(sessionId, goalId, status)` | Goals lifecycle. |
| `proposeDecision(...)` / `confirmLatestProposed(...)` / `revokeLatestActive(...)` / `supersedeLatestActive(...)` / `getDecisions(sessionId, status?)` / `getLatestProposed(sessionId)` / `getActiveDecisions(sessionId)` | Decision state machine (proposed → active → superseded). |
| `addFeedback(sessionId, text, kind, opts?)` / `getFeedback(sessionId, limit?)` | Feedback/preferences. |

### Cross-session inheritance (merged views)

| Method | Description |
|---|---|
| `getActiveDecisionsMerged(sessionId, projectKey?)` / `getActiveGoalsMerged(...)` / `getFeedbackMerged(...)` | Merge current session + same project + global rows. |
| `applyScopePriority(rows)` | Layered priority: session > project > global, normalized dedup. |

### Retrieval

| Method | Description |
|---|---|
| `search(query, opts?)` | BM25 FTS5 search over the event stream. |

### Lineage

| Method | Description |
|---|---|
| `addLineageEdge(...)` / `getRelatedEvents(sessionId, eventId)` / `getRelatedEdges(sessionId, type, id)` / `getEventsForFile(sessionId, filePath)` | File/decision lineage graph. |

## Standalone functions

| Export | Module | Description |
|---|---|---|
| `truncateBody(body, maxChars?)` / `eventKindCounts(db)` | events | Body truncation; event counts by kind. |
| `assertTransition(from, to)` / `canTransition(from, to)` | state | Decision/goal status transitions. |
| `analyzeTurn(input)` / `applyAnalysis(store, sessionId, input, opts?)` | light-confirm | Deterministic lightweight confirmation (zero LLM): user messages → goals, assistant replies → decisions/feedback. |
| `queryMemory(store, query, opts?)` | query | Semantic retrieval (BM25) with episode-summary fallback. |
| `queryEvents(store, opts)` | query | Structured retrieval: kind filter, time range, ordering, counts. |
| `SpillPolicy` / `INDEXABLE_KINDS` | governor | Body spill policy (4K threshold) and FTS indexable kinds. |
| `deriveProjectKey(cwd)` / `deriveProjectKeyHash(cwd)` | project-key | Normalized git-root project identity. |
| `threadRoot()` / `defaultPaths(cwd?)` | paths | Dual-DB paths (`THREAD_ROOT` overridable). |
| `buildStatusCard(store, opts)` | status-card | Per-turn status card (merged views + budget tiers; `opts.isolated: true` shows only the own session, B⑧). |
| `migrateSplit(...)` / `replayIncrement(...)` | migrate | Single-DB → dual-DB migration core. |
| `SCHEMA_VERSION` | schema | Schema version constant (current: 3, B⑧ isolation columns + session_isolation table). |
| `THREAD_VERSION` | index | Version constant. |

## Types

`SessionEvent`, `EventKind`, `Goal`, `Decision`, `FeedbackRow`, `AppendOptions`
(`isolation?: boolean`, B⑧), `StructuredWriteOptions`, `Episode`,
`LineageNeighbor`, `SearchHit`, `ThreadPaths`.
