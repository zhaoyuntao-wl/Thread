# Thread

*Session memory with lineage for coding agents.*

Thread is a base-agnostic memory layer for coding agents. Instead of lossy context
compression, it stores the full event stream of a session losslessly and retrieves
on demand — goals, decisions, feedback, and lineage stay intact across long tasks.

> Status: private development (MVP). Design: [v1 baseline](./docs/design/v1/session-memory-system-design.md) · [v2 plans](./docs/design/v2/session-memory-system-design.md)

## Why

Mainstream compact mechanisms (Claude Code auto-compact, Codex compact, ...) degrade
context irreversibly on long tasks, causing missed decisions, goal drift, and repeated
questions. Thread is the "retrieval school": store losslessly, retrieve on demand,
keep the critical path (goal + episode state) resident with O(1) bounded context.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Base (Qoder CLI, swappable)│        │  Session Memory System (SMS) │
│  main model (only sync)     │  MCP   │  query service (graph/BM25)  │
│  tools (query_session_memory)│ hooks │  event stream (lossless)     │
│  session export             │        │  structured tables           │
│  per-turn context injection │        │  lineage graph               │
└─────────────────────────────┘        └──────────────────────────────┘
```

SMS runs as a separate process. Bases are connected through three weak capabilities
(MCP client / hook events / per-turn context injection) and are swappable.

## Packages

| Package | Description |
|---|---|
| `@thread/core` | Event pipeline, structured tables (goals/decisions/feedback), lineage graph, BM25 retrieval |
| `@thread/adapter-qoder-cli` | Reference adapter for Qoder CLI (hooks ingestion, context injection, MCP query tool) |
| `@thread/evals` | Regression suite: long-task scenarios, fact-retention checks |

## Development

Requires Node >= 20 and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

Apache-2.0. See [LICENSE](./LICENSE).
