# Maintaining Thread

Release and maintenance workflow for Thread. Package layout, build commands, and
contribution rules live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Versioning (SemVer)

- `patch`: bug fixes, non-behavioral changes.
- `minor`: new features, backward compatible.
- `major`: breaking changes (API removal, behavior change, dropped support).
- During 0.x, minors may carry breaking changes only when the changeset states it
  explicitly and the design docs are updated first.

Every user-visible change ships with a changeset (`pnpm changeset`).

## Release process

1. Ensure `main` is green: `pnpm typecheck && pnpm lint && pnpm test && pnpm eval`.
2. Verify the release plan: `pnpm changeset status` (no stale package references).
3. Bump versions and generate changelogs: `pnpm changeset version`.
4. Publish: `pnpm publish -r` (npm login with OTP as prompted).
5. Tag and create the GitHub Release from the generated `CHANGELOG.md` entries.
6. Post-release smoke test: install each published package from a clean shell
   (`npm i -g thread-mcp`, `dsh plugin add dsh-thread`, `npx t-dsh`).

## Breaking change policy

- Update the design docs first (`docs/design/v1` baseline takes precedence; v2 for
  phase-2 plans), then implement.
- Changeset marks `major` and states the migration path.
- README and `docs/api.md` are updated in the same PR.
- For `dsh-thread`, extend the compat matrix in `.github/workflows/ci.yml` when
  the pinned dsh version changes.

## Test / example / doc sync rules

- Behavior changes require a regression scenario in `packages/evals` (B⑦ checklist)
  or an extension of an existing one.
- API changes update `docs/api.md` and `examples/` in the same PR.
- The gate is four-fold: `pnpm typecheck && pnpm lint && pnpm test && pnpm eval`;
  regression failures block merging.
