# Thread Memory Protocol

The stable contract between Thread and any host base. A base "has Thread memory"
when it satisfies the three weak capabilities below; everything else is
implementation.

This document is the contract anchor for multi-base adapters (B4a). It describes
current state, not process.

## 1. The three weak capabilities a base must provide

| # | Capability | Purpose | Examples |
|---|---|---|---|
| 1 | **Capture hook** | Hand Thread every conversation event (user/assistant messages, tool calls/results) as it happens | dsh `session/event` subscription; Qoder hooks; Claude Code hooks |
| 2 | **Context injection** | Let Thread add context the model sees next turn | dsh `agent.inject`; Qoder `additionalContext`; MCP-visible instructions |
| 3 | **Compaction boundary signal** | Tell Thread when the base compacts context | dsh `compaction/summary` event; Qoder `PostCompact` hook |

Optional (capability-gated enhancements):

| Capability | Enables | Availability |
|---|---|---|
| Native tool registration | Query tool in the model's tool schema (strongest channel) | dsh `ctx.tools.register`; MCP tools elsewhere |
| Skill catalog registration | Behavior contract discoverable via the base's skill loader | dsh `ctx.skills.register`; SKILL.md-style skills elsewhere |
| Programmable compaction | Thread-triggered silent compaction | dsh `ctx.compaction.compactNow` |

## 2. The query tool contract

**Tool name**: `query_session_memory`

One tool, two modes:

### 2.1 Semantic search (default)

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string | Keyword/phrase search over the indexed event stream |
| `kind` | enum | Filter: `user_message` / `assistant_message` / `tool_call` / `tool_result` / `compact_checkpoint` / `goal` / `decision` / `feedback` |
| `session_id` | string | Target session; defaults to the most recent active one |
| `limit` | int | Max result segments (default 20, max 50) |
| `since` / `until` | ISO | Time bounds (exact-query path) |
| `order` | enum | `asc` / `desc` (default desc) |
| `count_only` | bool | Return counts instead of rows |
| `token_budget` | int | Result token budget |

### 2.2 Navigation primitives (`nav`)

Filesystem-style navigation over the association structure
(session → assets/documents, plus lineage edges):

| `nav` | `target` | Returns |
|---|---|---|
| `ls` | session id | That session's outputs (assets) and pending todos |
| `ls` | asset id | The asset's related edges |
| `cd` | asset id / event id / doc path | Node detail: title, source event, related edges |
| `cat` | asset id / event id / doc path | Full content (asset file text or event body) |
| `grep` | — (`query` = keyword) | Search hits with context + matching asset index entries |

All navigation responses use one envelope:

```ts
interface NavResult {
  kind: "list" | "node" | "content" | "hits";
  title: string;
  items: NavItem[];
  context?: { session_id?: string; asset_id?: number; evidence?: string[] };
}
interface NavItem {
  id: string;
  type: "session" | "asset" | "event" | "decision" | "todo";
  label: string;
  ref?: string;
}
```

### 2.3 Error contract

- Nothing found → `status: "not-found"` plus a follow-up suggestion; never a
  fabricated answer.
- Isolated content → visibility markers, never silent leaks.
- Unreadable source → explicit `[文件不可读: <path>]` marker, never silent.

## 3. Storage model (contract surface)

| Table | Meaning |
|---|---|
| `events` | Lossless append-only event stream (the source of truth) |
| `goals` / `decisions` / `feedback` | Structured state tables with status machines |
| `pending_candidates` | Staged candidates; promoted to decisions via explicit update, nothing becomes a decision implicitly |
| `knowledge_assets` | Registered outputs (documents/reports) with lineage edges |
| `todos` | Pending work sedimented from goals at closing |
| `lineage_edges` | Deterministic relations: produces, references, evidence, precedes, next_step |
| `thread_meta` | Delivery watermarks (cross-agent delta) |

## 4. Adapter conformance

An adapter conforms when:

1. It forwards all conversation events through capability #1 with stable origins
   (idempotent capture).
2. It injects the status card / anchors through capability #2.
3. It forwards compaction boundaries through capability #3 and re-anchors state
   after them.
4. It exposes `query_session_memory` with the contract in §2 (native registration
   when available, MCP otherwise).
5. It honors session isolation and cross-agent delta semantics identically.
