# Thread 1.0: Architecture (current state)

> Current-state description of Thread's released architecture. Process and
> history live in local design notes; this document states what exists.

## Positioning

Thread's north star is *making the model work better* (reliability), not user
comfort. Every capability is judged by one question: does it raise the model's
work quality? The three governing principles:

1. **Structural triggering** — no capability relies on the model remembering to
   use it; Thread triggers it.
2. **Information delivery** — nothing is "stored" without a structural path to
   the model's context.
3. **Linear dependency chain** — compliance → delivery → content, in that order;
   a later link is worthless if an earlier one fails.

## Channel matrix (delivery layer)

Content is routed to the strongest available channel per content type:

| Content | Channel | Base mechanism |
|---|---|---|
| Behavior contract ("need details → call the tool") | Dynamic skill (registered + anchor-injected) | `ctx.skills.register` |
| Query primitives (deep dive) | Native tool registration | `ctx.tools.register` (MCP fallback) |
| State (goals/decisions/preferences/outputs/todos) | Three-trigger injection: first-turn anchor + post-compaction re-anchor + cross-agent delta | `agent.inject` + compaction events + turn-boundary watermark check |
| Context length | Base compaction, observed and re-anchored; optional active trigger | compaction event subscription (+ optional `compactNow`) |

## Delivery flow (three triggers)

1. **First-turn anchor** — a fresh session gets project identity, the north-star
   line, the behavior contract, and the status card; a resumed session gets the
   continuation package (carried state, recent outputs, todos, active sessions).
2. **Post-compaction re-anchor** — every `compaction/summary` event re-injects
   the status card (post-compact block) and the behavior contract, so the model's
   state survives the base's compaction.
3. **Cross-agent delta** — at every turn boundary, Thread compares the project
   state tables against a per-session watermark and pushes new
   decisions/goals/preferences/pending changes written by other sessions. Own
   session writes are excluded; isolation is honored in both directions.

## Capture layer

- All conversation events are captured losslessly with stable origins
  (idempotent append).
- **Explicit decision & preference channels** — decisions are recorded through
  commands (`/thread-reg dec`, `--supersedes <id>` for chain evolution) or the
  model's `record_decision` tool (instructed by the behavior contract);
  preferences and lessons through `/thread-reg fdb`. Text-heuristic extraction
  of decisions/preferences is off (a pasted or echoed line cannot create
  state). Goal detection (short imperative messages) and completion detection
  remain on, guarded against multi-line/pasted input; the lossless event stream
  backstops everything unrecorded.
- **Output recognition** is deterministic: write/edit tools targeting markdown
  documents and report tools are registered as `knowledge_assets` with
  `produces` (session → asset) and `references` (asset → source event) edges.
  `/thread-reg ast` registers other outputs explicitly.
- **Closing sediment**: closing words trigger sedimentation — in-progress goals
  become todos, pending candidates get a pointer todo; idempotent by basis.
- **Pending-work inbox** — `/thread-cfm` merges todos (`t#id`) and pending
  candidates (`c#id`) into one view: `do` completes/promotes (candidates accept
  corrected text), `cnl` discards, `cnl all` clears; the status card surfaces
  the top candidates so they cannot pile up silently. In 1.0 candidates are not
  produced automatically (natural-language extraction is off); automatic
  candidate production waits for the post-release extraction layer, admitted by
  measured precision. Todos are produced actively by closing sediment and
  goal-completion self-healing. `/thread-rev <ast|dec|fdb|gol> <ids|all>`
  revokes registrations (decisions, preferences and assets are deleted with
  the event stream keeping the text; goals are abandoned through the state
  machine with todos self-healed).

## Storage (schema v8)

| Domain | Tables |
|---|---|
| Events | `events` (lossless, FTS-indexed: jieba BM25 + trigram fallback), `episodes`, `spills`, `lineage_edges` |
| State | `goals`, `decisions`, `feedback` (status machines, `updated_at` for deltas), `pending_candidates` |
| Knowledge | `knowledge_assets`, `todos` |
| Delivery | `thread_meta` (delta watermarks) |

## Base capability tiers

Every mechanism has a portable floor and a base-native ceiling:

| Mechanism | Portable floor | Base-native ceiling (dsh) |
|---|---|---|
| Query | MCP tool | Native `ctx.tools.register` (strongest channel) |
| Behavior contract | Status-card section | Dynamic skill (catalog + loader) |
| Compaction | Boundary signal + re-anchor | Programmable silent trigger |
| Delta | Turn-boundary watermark check | Same (injection is a universal capability) |

Bases lacking a programmable compaction trigger are documented to lower their
auto-compaction threshold: Thread re-anchors at every boundary, so more frequent
compaction costs no fidelity.

## Verification

The regression suite (`pnpm eval`) runs 15 scenario-level fidelity checks as a CI
gate: decision chains survive supersession and deletion, goals survive
compaction, answers stay re-findable, output recognition builds lineage,
sediment stays idempotent, navigation works end-to-end, cross-agent deltas
arrive, and continuation packages surface outputs/todos/active sessions — plus
scope filtering, lossless migration, rebuild recovery, and session isolation.
