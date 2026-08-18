import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoginService } from "./auth.js";
import { createLoginServer } from "./server.js";
import { FileSecurityStateStore, FileUserStore } from "./store.js";

const SECRET = "test-secret";
const dirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  close(): Promise<void>;
}

async function startServer(): Promise<{ base: string; service: LoginService }> {
  const dir = mkdtempSync(join(tmpdir(), "thread-login-server-"));
  dirs.push(dir);
  const service = new LoginService(SECRET, {
    store: new FileUserStore(join(dir, "users.json")),
    stateStore: new FileSecurityStateStore(join(dir, "security.json")),
  });
  const server = createLoginServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch 的 keep-alive 连接会让 close 一直等待，强制断开空闲 socket
        server.closeAllConnections?.();
      }),
  });
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, service };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((handle) => handle.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function register(base: string, username: string, password: string): Promise<number> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.status;
}

async function login(base: string, username: string, password: string): Promise<{ token: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return (await res.json()) as { token: string };
}

async function loginStatus(base: string, username: string, password: string): Promise<number> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.status;
}

describe("login HTTP API", () => {
  it("registers, logs in, and reads /me with the Bearer token", async () => {
    const { base } = await startServer();

    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "pw-123456" }),
    });
    expect(reg.status).toBe(201);
    const registered = (await reg.json()) as { username: string; id: string };
    expect(registered.username).toBe("alice");
    expect(registered.id).toBeTruthy();
    expect("passwordHash" in registered).toBe(false);

    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "pw-123456" }),
    });
    expect(loginRes.status).toBe(200);
    const { token } = (await loginRes.json()) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const me = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    const payload = (await me.json()) as { username: string; sub: string };
    expect(payload.username).toBe("alice");
    expect(payload.sub).toBeTruthy();
  });

  it("rejects a wrong password and an unknown user with 401", async () => {
    const { base } = await startServer();
    await register(base, "alice", "pw-123456");

    const bad = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ reason: "bad-password" });

    const unknown = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "pw-123456" }),
    });
    expect(unknown.status).toBe(401);
  });

  it("requires a Bearer token for /me and /logout", async () => {
    const { base } = await startServer();
    expect((await fetch(`${base}/me`)).status).toBe(401);
    expect((await fetch(`${base}/logout`, { method: "POST" })).status).toBe(401);
  });

  it("revokes the token on logout so /me is rejected afterwards", async () => {
    const { base } = await startServer();
    await register(base, "alice", "pw-123456");
    const { token } = await login(base, "alice", "pw-123456");

    const out = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(204);

    const me = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(401);
  });

  it("changes the password with a valid token, then only the new password works", async () => {
    const { base } = await startServer();
    await register(base, "alice", "pw-123456");
    const { token } = await login(base, "alice", "pw-123456");

    const change = await fetch(`${base}/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: "pw-123456", newPassword: "new-password" }),
    });
    expect(change.status).toBe(200);

    expect(await loginStatus(base, "alice", "pw-123456")).toBe(401);
    expect(await loginStatus(base, "alice", "new-password")).toBe(200);
  });

  it("rejects a weak new password and a wrong old password", async () => {
    const { base } = await startServer();
    await register(base, "alice", "pw-123456");
    const { token } = await login(base, "alice", "pw-123456");
    const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

    const weak = await fetch(`${base}/change-password`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ oldPassword: "pw-123456", newPassword: "short" }),
    });
    expect(weak.status).toBe(400);
    expect(await weak.json()).toEqual({ reason: "weak-password" });

    const wrongOld = await fetch(`${base}/change-password`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ oldPassword: "wrong-old", newPassword: "new-password" }),
    });
    expect(wrongOld.status).toBe(400);
  });

  it("rejects malformed JSON, invalid registration, and unknown routes", async () => {
    const { base } = await startServer();

    const badJson = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "invalid-json" });

    const invalidReg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ab", password: "pw-123456" }),
    });
    expect(invalidReg.status).toBe(400);
    expect(await invalidReg.json()).toEqual({ error: "invalid-username" });

    const nope = await fetch(`${base}/nope`);
    expect(nope.status).toBe(404);
  });
});
