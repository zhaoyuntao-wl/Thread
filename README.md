# Thread

[![CI](https://github.com/zhaoyuntao-wl/Thread/actions/workflows/ci.yml/badge.svg)](https://github.com/zhaoyuntao-wl/Thread/actions/workflows/ci.yml)

*Session memory with lineage for coding agents.*

Thread is a base-agnostic memory layer for coding agents. Instead of lossy context
compression, it stores the full event stream of a session losslessly and retrieves
on demand — goals, decisions, feedback, and lineage stay intact across long tasks.

- **Decisions never lost**: every decision (including superseded/revoked ones) is
  stored losslessly and its evolution is traceable.
- **Goals never drift**: key goals stay resident across compaction and new sessions.
- **No repeated questions**: already-answered information is recalled on demand.
- **Bounded context**: per-turn cost stays O(1) with a resident status card plus
  on-demand retrieval, instead of replaying full history.
- **Situational relay**: the status card becomes a situational router — new sessions
  auto-continue from prior work, compaction boundaries re-anchor goals, and recent
  decisions are relayed so the model never acts on stale state.
- **Confirmed decisions**: user decision statements are staged as candidates and
  surfaced via a dialog (confirm / cancel / postpone) — nothing unconfirmed ever
  becomes a formal decision.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Base (swappable)           │        │  Thread memory core          │
│  main model                 │  MCP   │  query service (graph/BM25)  │
│  tools (query_session_memory)│ hooks │  event stream (lossless)     │
│  session export             │        │  structured tables           │
│  per-turn context injection │        │  lineage graph               │
└─────────────────────────────┘        └──────────────────────────────┘
```

Thread runs as a separate process. Bases connect through three weak capabilities
(MCP client / hook events / per-turn context injection) and are swappable.

## Packages

This repository:

| Package | Description |
|---|---|
| `@thread-memory/core` | Event pipeline, structured tables (goals/decisions/feedback), lineage graph, BM25 retrieval, session isolation |
| `@thread/adapter-qoder-cli` | Reference adapter for Qoder CLI (hooks ingestion, context injection, MCP query tool) |
| `@thread/evals` | Regression suite: scenario-level fidelity checks, CI gate |

The dsh adapter (`dsh-thread`) lives in its own repository:
[dsh-plugin-thread](https://github.com/zhaoyuntao-wl/dsh-plugin-thread) — a
one-package closed loop: `session/event` capture + per-turn status-card injection
+ embedded MCP server (`query_session_memory`, `bin=dsh-thread`).

## Quick start

```ts
import { ThreadStore, applyAnalysis, buildStatusCard, queryMemory } from "@thread-memory/core";

const store = new ThreadStore({ eventsPath, structuredPath, projectKey });

store.append(
  { session_id: "s1", kind: "user_message", ts: new Date().toISOString(), body: "帮我实现登录功能" },
  { origin: "demo://msg#1", projectKey },
);
applyAnalysis(store, "s1", { user_msg: "帮我实现登录功能" }, { projectKey });

const card = buildStatusCard(store, { sessionId: "s1", projectKey, budgetLines: 200 });
const hits = queryMemory(store, "JWT 认证", { sessionId: "s1" });

store.close();
```

More: [examples/](./examples/README.md) · [API reference](./docs/api.md) ·
[Design (v1 baseline)](./docs/design/v1/session-memory-system-design.md)

## Development

Requires Node >= 20 and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm eval        # scenario-level fidelity regression suite (CI gate)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [MAINTAINING.md](./MAINTAINING.md).

## License

[MIT](./LICENSE)
