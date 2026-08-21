# Thread

[![CI](https://github.com/zhaoyuntao-wl/Thread/actions/workflows/ci.yml/badge.svg)](https://github.com/zhaoyuntao-wl/Thread/actions/workflows/ci.yml)

*Session memory with lineage for coding agents.*

Thread is a base-agnostic memory layer for coding agents. Instead of lossy context
compression or LLM-distilled summaries, it stores the full event stream of a
session losslessly and keeps decisions and goals as first-class structured state —
captured deterministically, delivered structurally.

## Capabilities

- **Decisions never lost**: every decision (including superseded/revoked ones) is
  stored losslessly and its evolution is traceable through a state machine.
- **Goals never drift**: key goals stay resident across compaction and new
  sessions — first-turn anchoring, re-anchoring after every compaction, and
  cross-agent state deltas re-deliver them structurally.
- **No repeated questions**: already-answered information is recalled on demand.
- **Cross-compaction fidelity**: when the base compacts a long session, Thread
  records the checkpoint, re-anchors goals/decisions in the status card, and keeps
  the compacted details retrievable — not "best-effort from a summary".
- **Cross-session continuity**: a new session auto-continues from prior decisions,
  outputs (auto-registered assets) and todos, and discovers what other sessions
  have produced.
- **Cross-agent updates**: when another agent in the same project decides
  something, the delta is pushed into your session at the next turn boundary —
  you never act on stale state.
- **Query primitives**: one tool, `query_session_memory`, with filesystem-style
  navigation — `ls` (list outputs/todos/relations), `cd` (node detail), `cat`
  (full content), `grep` (search with context) — see
  [Memory Protocol](docs/design/memory-protocol.md).
- **Structural delivery**: a behavior-contract skill ("when you need details,
  call the tool") is registered into the base's skill catalog and injected at
  anchors, so the model does not rely on memory to know it has memory.
- **Explicit decision & preference channels**: decisions and preferences are
  recorded through commands (`/thread-reg dec`, `/thread-reg fdb`) or the
  model's `record_decision` tool — no fragile text heuristics, zero false
  positives from pasted or echoed text; the lossless event stream remains the
  backstop for anything unrecorded. Goal detection (short imperative messages)
  and completion detection stay on, guarded against multi-line/pasted input.
- **Output recognition**: documents written through write/edit tools are
  registered as assets with lineage edges on write (`/thread-reg ast` covers
  explicit registration).
- **Closing sediment**: closing words sediment in-progress goals into todos;
  `/thread-cfm` is the pending-work inbox (`do`/`cnl` with `t#`/`c#` ids), and
  `/thread-rev <ast|dec|fdb|gol>` revokes registrations.
- **Session isolation**: a session can go silent so its chatter stays private
  while tool facts remain shared.
- **Chinese retrieval**: BM25 with jieba word segmentation plus a trigram
  fallback indexes the event stream on write.

## Why it's different

Most memory plugins store *knowledge* — facts distilled by the model and recalled
later. Thread stores *decisions and goals as first-class structured state* with
their evolution, captured deterministically through explicit channels and
lightweight rules rather than LLM distillation.
The difference shows up in the hardest cases:

- **Across compaction**: Thread re-anchors state and keeps details retrievable,
  where summary-based memory degrades to whatever the summary kept.
- **Across agents**: Thread pushes state changes instead of waiting for a model
  to remember to ask.
- **Provably**: the regression suite (`pnpm eval`) runs scenario-level fidelity
  checks — decisions survive compaction, goals don't drift, answers stay
  re-findable, cross-agent deltas arrive — as a CI gate. It checks the *point* of
  a memory layer (fidelity across compaction and sessions), not just unit coverage.

## Honest boundaries (1.0 behavior)

Thread favors missing a capture over mis-capturing. The real 1.0 behavior, stated
plainly:

- **Candidates are not produced automatically.** Natural-language extraction of
  decisions/preferences is off; the inbox's `c#` entries only ever hold
  pre-existing rows. Automatic candidate production waits for a post-release
  extraction layer (LLM/small-model, admitted by measured precision). Todos
  (`t#`), by contrast, are produced actively: closing sediment and goal-completion
  self-healing.
- **Decisions never expire on their own.** A decision stays *active* — injected
  into status cards and continuation blocks — until it is explicitly superseded
  (`/thread-reg dec <new> --supersedes <id>`) or removed (`/thread-rev dec`).
  Close out time-bound decisions (e.g. "hold releases until X") at the moment
  their condition is consumed.
- **Goal completion detection is conservative.** Completion requires a completion
  phrase plus text overlap with an active goal — ≥4 consecutive characters for
  non-ASCII, ≥8 for pure ASCII runs. Short pure-English goals cannot be
  auto-completed (missed rather than mis-judged); abandon them with
  `/thread-rev gol`.
- **Output registration is an index, not a snapshot.** Assets are registered by
  command or by automatic recognition of markdown writes and report tools
  (non-markdown files are not auto-registered). `cat` reads the file live; the
  written content itself stays retrievable in the event stream.
- **Retrieval is layered.** BM25 indexes message-type events only; tool outputs
  are not full-text indexed. Decision content is pulled back through
  `query_session_memory` with `kind=decision`.
- **The model channel relies on the behavior contract.** Natural-language
  decisions are recorded when the model follows the contract and calls
  `record_decision`; compliance is probabilistic, and anything unrecorded remains
  retrievable from the event stream. A post-release extraction layer with user
  confirmation is the planned backstop.

## Base integration

Thread integrates two ways — **deep integration** (recommended) and
**adaptation** (fallback):

| Form | Base | Capabilities |
|---|---|---|
| **Deep integration** (recommended) | **dsh** (DeepSeek Harness) via the `dsh-thread` plugin | Full feature set: native tool registration, dynamic skill, compaction event subscription + re-anchoring, optional active compaction, cross-agent delta |
| **Adaptation** | Qoder CLI (hooks + MCP) | Core feature set: lossless capture, status card + delta injection, output recognition, sediment, MCP query tool |

**Why deep integration is recommended**: the strongest channels for making a
model follow behavior — tool registration (decoder-level constraints), the skill
catalog (SOP delivery), and compaction boundaries (state re-anchoring) — are all
open in dsh's plugin system, and deep integration uses all three. Adaptation
only reaches MCP tools and message injection: same capabilities, degraded
delivery channels.

**Adaptation roadmap**: next is **Claude Code** (hooks + MCP + SKILL.md
alignment); any base with the three weak capabilities can be integrated — see
[Memory Protocol](docs/design/memory-protocol.md).

## Context length guidance

Thread does not compress context itself; it rides the base's compaction and
guarantees what survives it. For bases without a programmable compaction trigger,
**lower the base's auto-compaction threshold** so compaction happens more often —
Thread re-anchors state at every compaction boundary, so more frequent compaction
costs nothing in fidelity and keeps the context bounded. On dsh the `dsh-thread`
plugin can optionally trigger compaction itself (`THREAD_AUTO_COMPACT=1` +
`compactPressureTokens`).

## Architecture

```
 Base (swappable)              Thread memory core
 ┌──────────────────────┐      ┌───────────────────────────┐
 │ main model           │      │ event stream (lossless)    │
 │ tools (query_...)    │ ───► │ structured tables (state)  │
 │ skill catalog        │ ◄─── │ lineage + assets           │
 │ hooks / session log  │      │ BM25 + trigram retrieval   │
 │ compaction boundary  │      │ status card / anchors      │
 └──────────────────────┘      └───────────────────────────┘
```

Bases connect through three weak capabilities — tool registration (or MCP),
context injection (or hooks), and a compaction boundary signal — and are
swappable. See [Thread 1.0 architecture](docs/design/architecture.md) for the
full architecture.

## Packages

This repository:

| Package | Description |
|---|---|
| `@thread-memory/core` | Event pipeline, structured tables (goals/decisions/feedback/todos/assets), lineage graph, BM25+jieba/trigram retrieval, query primitives, status card, cross-agent delta |
| `@thread/adapter-qoder-cli` | Reference adapter for Qoder CLI (hooks ingestion, context injection, MCP query tool) |
| `@thread/evals` | Regression suite: scenario-level fidelity checks, CI gate |

The dsh plugin lives in its own repository: `dsh-thread` (npm `dsh-thread`).

## Development

```sh
pnpm install
pnpm typecheck   # build + typecheck (all packages)
pnpm lint
pnpm test        # unit tests
pnpm eval        # scenario-level fidelity regression (CI gate)
```

## License

MIT
