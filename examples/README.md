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
verification, built only on `node:crypto`, `node:fs`, and `node:http` (zero
dependencies).

- `auth.ts` — `hashPassword`/`verifyPassword`, `signToken`/`verifyToken` (per-token
  `jti`), `TokenBlacklist` (logout/revocation), and `LoginService`
  (register/login/authenticate/logout/changePassword with credential validation
  and brute-force lockout)
- `store.ts` — `FileUserStore` persists users to a JSON file (atomic
  tmp-file + rename), so registrations and password changes survive restarts;
  `FileSecurityStateStore` persists the token blacklist and lockout counters to
  a second JSON file, so logout and brute-force locks also survive restarts;
  pass either as the `store`/`stateStore` options to `LoginService`, or supply
  any `UserStore`/`SecurityStateStore` for a different backend (SQLite, remote
  API, ...)
- `server.ts` — zero-dependency HTTP API (`node:http`) exposing
  `POST /register`, `POST /login`, `GET /me`, `POST /logout`,
  `POST /change-password` with JWT Bearer auth; `createLoginServer(service)`
  returns the raw `http.Server` for embedding or testing
- `cli.ts` — runnable end-to-end demo: register → login → authenticate →
  restart-persistence proof → logout, plus an optional change-password walk
  (users persist under `<root>/users.json`, security state under
  `<root>/security.json`; default root is a temp dir)
- `auth.test.ts` / `store.test.ts` / `server.test.ts` — vitest suites
  (round-trips, wrong password, tampering, expiry, cross-secret rejection,
  validation, lockout, revocation, password change, persistence across
  instances, HTTP endpoints)

```sh
pnpm vitest run examples/login
npx tsx examples/login/cli.ts                     # 默认数据目录：系统临时目录
npx tsx examples/login/cli.ts --root ./.login-demo --change-password --reset
npx tsx examples/login/server.ts --port 8787 --root ./.login-demo
curl -s -X POST localhost:8787/register -H 'content-type: application/json' \
  -d '{"username":"alice","password":"pw-123456"}'
```
