# Thread Examples

Minimal runnable examples for the Thread core API.

## quick-start.ts

Session memory in ~30 lines: open the store, append events, run deterministic
light confirmation, inject the status card, retrieve on demand.

```sh
pnpm install
npx tsx examples/quick-start.ts
```

The example uses a temp directory (`THREAD_ROOT` override); nothing is written
outside it.
