# Contributing to Thread

Thanks for your interest. The design lives in
[docs/design/v1/session-memory-system-design.md](./docs/design/v1/session-memory-system-design.md)
(v1 baseline) and
[docs/design/v2/session-memory-system-design.md](./docs/design/v2/session-memory-system-design.md)
(phase-2 plans). Before opening issues or PRs, please read both.

## Reporting issues

- Use the issue templates (bug report / feature request).
- For bugs: include reproduction steps, expected vs actual behavior, and the base
  (CLI) and adapter version.
- For feature requests: explain the user need and the trade-off, not just the feature.

## Development

- Node >= 20, pnpm >= 9.
- Monorepo layout: `packages/core`, `packages/adapters/qoder-cli`, `packages/adapters/dsh`,
  `packages/mcp`, `packages/t-dsh`, `packages/evals`.
- Every package must pass: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm eval`.
- Versioning via changesets: add a changeset for any user-visible change:

```sh
pnpm changeset
```

## Conventions

- TypeScript, strict mode, ESM only (`NodeNext` module resolution).
- No comments unless the *why* is non-obvious.
- Tests live next to sources (`src/**/*.test.ts`).

## Pull requests

1. Small, focused changes are preferred.
2. Run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm eval` locally.
3. CI runs the same checks on GitHub Actions.
