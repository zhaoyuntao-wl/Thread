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

## login/

User login module: password hashing (scrypt) + stateless JWT (HS256) signing and
verification, built only on `node:crypto` (zero dependencies).

- `auth.ts` — `hashPassword`/`verifyPassword`, `signToken`/`verifyToken` (per-token
  `jti`), `TokenBlacklist` (logout/revocation), and `LoginService`
  (register/login/authenticate/logout/changePassword with credential validation
  and brute-force lockout)
- `auth.test.ts` — vitest suite (round-trips, wrong password, tampering, expiry,
  cross-secret rejection, validation, lockout, revocation, password change)

```sh
pnpm vitest run examples/login/auth.test.ts
```
