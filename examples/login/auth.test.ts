import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LoginService,
  LoginServiceOptions,
  TokenBlacklist,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
} from "./auth.js";
import { FileSecurityStateStore, FileUserStore } from "./store.js";

const SECRET = "test-secret";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a correct password", () => {
    const stored = hashPassword("hunter2");
    expect(stored).not.toBe("hunter2");
    expect(verifyPassword("hunter2", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("hunter2");
    expect(verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("uses a per-call salt (same password hashes differently)", () => {
    expect(hashPassword("hunter2")).not.toBe(hashPassword("hunter2"));
  });

  it("rejects a malformed stored value", () => {
    expect(verifyPassword("hunter2", "not-a-hash")).toBe(false);
  });
});

describe("signToken / verifyToken", () => {
  it("signs and verifies a token", () => {
    const token = signToken({ sub: "u1", username: "alice" }, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe("u1");
      expect(result.payload.username).toBe("alice");
      expect(result.payload.jti).toBeTruthy();
      expect(result.payload.exp).toBeGreaterThan(result.payload.iat);
    }
  });

  it("rejects a token signed with a different secret", () => {
    const token = signToken({ sub: "u1", username: "alice" }, "other-secret");
    expect(verifyToken(token, SECRET)).toEqual({ ok: false, reason: "invalid-signature" });
  });

  it("rejects a tampered payload", () => {
    const token = signToken({ sub: "u1", username: "alice" }, SECRET);
    const [header, , signature] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ sub: "u2", username: "mallory", iat: 0, exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(verifyToken(`${header}.${forgedBody}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: "invalid-signature",
    });
  });

  it("rejects an expired token", () => {
    const token = signToken({ sub: "u1", username: "alice" }, SECRET, -1_000);
    expect(verifyToken(token, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a malformed token", () => {
    expect(verifyToken("not-a-jwt", SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a validly signed token without a jti", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "u1", username: "alice", iat: 0, exp: Date.now() + 60_000 }),
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
    expect(verifyToken(`${header}.${body}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("TokenBlacklist", () => {
  it("revokes a jti until its expiry, then drops it lazily", () => {
    const blacklist = new TokenBlacklist();
    blacklist.revoke("jti-1", Date.now() + 1_000);
    blacklist.revoke("jti-2", Date.now() - 1);
    expect(blacklist.isRevoked("jti-1")).toBe(true);
    expect(blacklist.isRevoked("jti-2")).toBe(false);
    expect(blacklist.isRevoked("unknown")).toBe(false);
  });
});

describe("LoginService registration", () => {
  it("registers a user and logs in with valid credentials", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    const result = service.login("alice", "pw-123456");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(service.authenticate(result.token)?.username).toBe("alice");
    }
  });

  it("does not log in with a wrong password", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    expect(service.login("alice", "wrong-password")).toEqual({
      ok: false,
      reason: "bad-password",
    });
  });

  it("does not log in an unknown user", () => {
    const service = new LoginService(SECRET);
    expect(service.login("bob", "pw-123456")).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("rejects duplicate registration", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    expect(service.register("alice", "pw-456789")).toEqual({ error: "taken" });
  });

  it("does not authenticate a token issued by another secret", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    const other = new LoginService("other-secret");
    other.register("alice", "pw-123456");
    const result = other.login("alice", "pw-123456");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(service.authenticate(result.token)).toBeNull();
    }
  });
});

describe("credential validation", () => {
  it("rejects an invalid username", () => {
    const service = new LoginService(SECRET);
    expect(service.register("ab", "pw-123456")).toEqual({ error: "invalid-username" });
    expect(service.register("bad name!", "pw-123456")).toEqual({ error: "invalid-username" });
  });

  it("rejects a short password", () => {
    const service = new LoginService(SECRET);
    expect(service.register("alice", "short")).toEqual({ error: "weak-password" });
  });

  it("accepts a username with allowed separators at the boundary length", () => {
    const service = new LoginService(SECRET);
    const result = service.register("a_b-9", "12345678");
    expect("error" in result).toBe(false);
  });
});

describe("brute-force lockout", () => {
  it("locks after maxAttempts failures and rejects even a correct password", () => {
    const service = new LoginService(SECRET, { maxAttempts: 3, lockoutMs: 60_000 });
    service.register("alice", "pw-123456");
    service.login("alice", "wrong-1");
    service.login("alice", "wrong-2");
    service.login("alice", "wrong-3");
    expect(service.login("alice", "pw-123456")).toEqual({ ok: false, reason: "locked" });
  });

  it("resets the counter on a successful login", () => {
    const service = new LoginService(SECRET, { maxAttempts: 2, lockoutMs: 60_000 });
    service.register("alice", "pw-123456");
    service.login("alice", "wrong-1");
    expect(service.login("alice", "pw-123456")).toEqual({ ok: true, token: expect.any(String) });
    service.login("alice", "wrong-1");
    service.login("alice", "wrong-2");
    expect(service.login("alice", "pw-123456")).toEqual({ ok: false, reason: "locked" });
  });

  it("clears the lockout after the window expires", async () => {
    const service = new LoginService(SECRET, { maxAttempts: 1, lockoutMs: 30 });
    service.register("alice", "pw-123456");
    service.login("alice", "wrong-1");
    expect(service.login("alice", "pw-123456")).toEqual({ ok: false, reason: "locked" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.login("alice", "pw-123456")).toEqual({ ok: true, token: expect.any(String) });
  });
});

describe("logout / token revocation", () => {
  it("revokes a token so authenticate no longer accepts it", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    const result = service.login("alice", "pw-123456");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(service.authenticate(result.token)).not.toBeNull();
    service.logout(result.token);
    expect(service.authenticate(result.token)).toBeNull();
  });

  it("keeps other tokens of the same user valid after a logout", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    const a = service.login("alice", "pw-123456");
    const b = service.login("alice", "pw-123456");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.token).not.toBe(b.token);
    service.logout(a.token);
    expect(service.authenticate(a.token)).toBeNull();
    expect(service.authenticate(b.token)).not.toBeNull();
  });
});

describe("changePassword", () => {
  it("replaces the password after verifying the old one", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    expect(service.changePassword("alice", "pw-123456", "new-password")).toEqual({ ok: true });
    expect(service.login("alice", "pw-123456")).toEqual({ ok: false, reason: "bad-password" });
    expect(service.login("alice", "new-password")).toEqual({ ok: true, token: expect.any(String) });
  });

  it("rejects a wrong old password", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    expect(service.changePassword("alice", "wrong-old", "new-password")).toEqual({
      ok: false,
      reason: "bad-password",
    });
  });

  it("rejects a weak new password", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    expect(service.changePassword("alice", "pw-123456", "short")).toEqual({
      ok: false,
      reason: "weak-password",
    });
  });

  it("rejects an unknown user", () => {
    const service = new LoginService(SECRET);
    expect(service.changePassword("nobody", "pw-123456", "new-password")).toEqual({
      ok: false,
      reason: "unknown-user",
    });
  });
});

describe("security state persistence across restarts", () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "thread-login-state-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function persistedService(dir: string, options: Partial<LoginServiceOptions> = {}): LoginService {
    return new LoginService(SECRET, {
      store: new FileUserStore(join(dir, "users.json")),
      stateStore: new FileSecurityStateStore(join(dir, "security.json")),
      ...options,
    });
  }

  it("keeps a revoked token revoked across service instances", () => {
    const dir = tempDir();
    const first = persistedService(dir);
    first.register("alice", "pw-123456");
    const result = first.login("alice", "pw-123456");
    if (!result.ok) throw new Error("login should succeed");
    first.logout(result.token);

    const second = persistedService(dir);
    expect(second.authenticate(result.token)).toBeNull();
  });

  it("keeps the lockout across service instances", () => {
    const dir = tempDir();
    const first = persistedService(dir, { maxAttempts: 2 });
    first.register("alice", "pw-123456");
    first.login("alice", "wrong-1");
    first.login("alice", "wrong-2");
    expect(first.login("alice", "pw-123456")).toEqual({ ok: false, reason: "locked" });

    const second = persistedService(dir, { maxAttempts: 2 });
    expect(second.login("alice", "pw-123456")).toEqual({ ok: false, reason: "locked" });
  });

  it("clears persisted failures on a successful login", () => {
    const dir = tempDir();
    const first = persistedService(dir, { maxAttempts: 2 });
    first.register("alice", "pw-123456");
    first.login("alice", "wrong-1");
    expect(first.login("alice", "pw-123456")).toEqual({ ok: true, token: expect.any(String) });

    const second = persistedService(dir, { maxAttempts: 1 });
    expect(second.login("alice", "pw-123456")).toEqual({ ok: true, token: expect.any(String) });
  });
});
