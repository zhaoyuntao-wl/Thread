# Thread Examples

Minimal runnable examples for the Thread core API.

## quick-start.ts

Session memory in ~30 lines: open the store, append events, run deterministic
light confirmation, inject the status card, retrieve on demand.

```sh
pnpm --filter @thread/core build
npx tsx examples/quick-start.ts
```

Or with Node directly after compiling:

```sh
pnpm --filter @thread/core build
node examples/quick-start.mjs
```
