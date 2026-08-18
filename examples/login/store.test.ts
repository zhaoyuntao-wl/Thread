import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoginService } from "./auth.js";
import { FileUserStore } from "./store.js";

const SECRET = "test-secret";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thread-login-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("FileUserStore", () => {
  it("loads an empty list when the file does not exist", () => {
    const store = new FileUserStore(join(tempDir(), "users.json"));
    expect(store.load()).toEqual([]);
  });

  it("round-trips users through save and load", () => {
    const file = join(tempDir(), "users.json");
    const store = new FileUserStore(file);
    const users = [
      {
        id: "u1",
        username: "alice",
        passwordHash: "salt:hash",
        createdAt: "2026-08-18T00:00:00.000Z",
      },
    ];
    store.save(users);
    expect(store.load()).toEqual(users);
  });

  it("loads an empty list from corrupt JSON", () => {
    const file = join(tempDir(), "users.json");
    writeFileSync(file, "{not valid json", "utf8");
    expect(new FileUserStore(file).load()).toEqual([]);
  });

  it("loads an empty list from a non-array document", () => {
    const file = join(tempDir(), "users.json");
    writeFileSync(file, '{"users": []}', "utf8");
    expect(new FileUserStore(file).load()).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const file = join(tempDir(), "users.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "u1", username: "alice", passwordHash: "s:h", createdAt: "t" },
        "junk",
        { id: "u2" },
      ]),
      "utf8",
    );
    const users = new FileUserStore(file).load();
    expect(users.map((u) => u.username)).toEqual(["alice"]);
  });

  it("writes a valid JSON file on save", () => {
    const file = join(tempDir(), "users.json");
    const store = new FileUserStore(file);
    store.save([
      { id: "u1", username: "alice", passwordHash: "salt:hash", createdAt: "t" },
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });
});

describe("LoginService persistence", () => {
  it("keeps a registered user across service instances on the same file", () => {
    const file = join(tempDir(), "users.json");
    const first = new LoginService(SECRET, { store: new FileUserStore(file) });
    first.register("alice", "pw-123456");

    const second = new LoginService(SECRET, { store: new FileUserStore(file) });
    const login = second.login("alice", "pw-123456");
    expect(login.ok).toBe(true);
    if (login.ok) expect(second.authenticate(login.token)?.username).toBe("alice");
  });

  it("persists changePassword so a new instance only accepts the new password", () => {
    const file = join(tempDir(), "users.json");
    const first = new LoginService(SECRET, { store: new FileUserStore(file) });
    first.register("alice", "pw-123456");
    expect(first.changePassword("alice", "pw-123456", "new-password")).toEqual({ ok: true });

    const second = new LoginService(SECRET, { store: new FileUserStore(file) });
    expect(second.login("alice", "pw-123456")).toEqual({ ok: false, reason: "bad-password" });
    expect(second.login("alice", "new-password")).toEqual({ ok: true, token: expect.any(String) });
  });

  it("keeps in-memory behavior when no store is configured", () => {
    const service = new LoginService(SECRET);
    service.register("alice", "pw-123456");
    const result = service.login("alice", "pw-123456");
    expect(result.ok).toBe(true);
  });
});
