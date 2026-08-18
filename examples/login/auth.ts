import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { UserStore } from "./store.js";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface TokenPayload {
  sub: string;
  username: string;
  jti: string;
  iat: number;
  exp: number;
}

const TOKEN_TTL_MS = 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signToken(
  payload: { sub: string; username: string },
  secret: string,
  ttlMs: number = TOKEN_TTL_MS,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Date.now();
  const jti = randomBytes(12).toString("hex");
  const body = base64url(JSON.stringify({ ...payload, jti, iat: now, exp: now + ttlMs }));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "malformed" | "invalid-signature" | "expired" };

export function verifyToken(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, body, signature] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) {
    return { ok: false, reason: "invalid-signature" };
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

export class TokenBlacklist {
  private readonly revoked = new Map<string, number>();

  revoke(jti: string, exp: number): void {
    this.revoked.set(jti, exp);
  }

  isRevoked(jti: string): boolean {
    const exp = this.revoked.get(jti);
    if (exp === undefined) return false;
    if (exp <= Date.now()) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }
}

export type RegisterResult =
  | User
  | { error: "invalid-username" | "weak-password" | "taken" };

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: "unknown-user" | "bad-password" | "locked" };

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: "unknown-user" | "bad-password" | "weak-password" };

export interface LoginServiceOptions {
  maxAttempts?: number;
  lockoutMs?: number;
  blacklist?: TokenBlacklist;
  store?: UserStore;
}

export class LoginService {
  private readonly users = new Map<string, User>();
  private readonly failed = new Map<string, { count: number; firstAt: number }>();
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private readonly blacklist: TokenBlacklist;
  private readonly store: UserStore | undefined;

  constructor(
    private readonly secret: string,
    options: LoginServiceOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
    this.blacklist = options.blacklist ?? new TokenBlacklist();
    this.store = options.store;
    if (this.store) {
      for (const user of this.store.load()) this.users.set(user.username, user);
    }
  }

  register(username: string, password: string): RegisterResult {
    if (!USERNAME_RE.test(username)) return { error: "invalid-username" };
    if (password.length < MIN_PASSWORD_LENGTH) return { error: "weak-password" };
    if (this.users.has(username)) return { error: "taken" };
    const user: User = {
      id: randomBytes(8).toString("hex"),
      username,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    this.users.set(username, user);
    this.persist();
    return user;
  }

  login(username: string, password: string): LoginResult {
    const fail = this.failures(username);
    if (fail && fail.count >= this.maxAttempts) return { ok: false, reason: "locked" };
    const user = this.users.get(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const record = fail ?? { count: 0, firstAt: Date.now() };
      record.count += 1;
      this.failed.set(username, record);
      return { ok: false, reason: user ? "bad-password" : "unknown-user" };
    }
    this.failed.delete(username);
    return { ok: true, token: signToken({ sub: user.id, username }, this.secret) };
  }

  logout(token: string): void {
    const result = verifyToken(token, this.secret);
    if (result.ok) this.blacklist.revoke(result.payload.jti, result.payload.exp);
  }

  authenticate(token: string): TokenPayload | null {
    const result = verifyToken(token, this.secret);
    if (!result.ok) return null;
    if (this.blacklist.isRevoked(result.payload.jti)) return null;
    return result.payload;
  }

  changePassword(
    username: string,
    oldPassword: string,
    newPassword: string,
  ): ChangePasswordResult {
    const user = this.users.get(username);
    if (!user) return { ok: false, reason: "unknown-user" };
    if (!verifyPassword(oldPassword, user.passwordHash)) return { ok: false, reason: "bad-password" };
    if (newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak-password" };
    user.passwordHash = hashPassword(newPassword);
    this.failed.delete(username);
    this.persist();
    return { ok: true };
  }

  private persist(): void {
    this.store?.save([...this.users.values()]);
  }

  private failures(username: string): { count: number; firstAt: number } | undefined {
    const fail = this.failed.get(username);
    if (fail && fail.firstAt + this.lockoutMs <= Date.now()) {
      this.failed.delete(username);
      return undefined;
    }
    return fail;
  }
}
