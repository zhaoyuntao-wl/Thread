import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";

describe("schema v2 migration", () => {
  it("migrates an existing v1 database (adds columns/tables)", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-migrate-"));
    const dbPath = join(dir, "old.db");

    // 构造 v1 旧库（无 v2 列/表）
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      meta TEXT,
      truncated INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO events (session_id, kind, ts, seq, body) VALUES ('s-old', 'user_message', '2026-08-13T00:00:00.000Z', 1, 'legacy data');
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source_event INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      superseded_by INTEGER,
      source_event INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'preference',
      source_event INTEGER,
      created_at TEXT NOT NULL
    );`);
    legacy.close();

    const store = new ThreadStore({ path: dbPath });

    // 旧数据保留
    const count = store.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    expect(count.c).toBe(1);

    // v2 列已加
    const cols = new Set(
      (store.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ["project_key", "scope", "origin", "spilled"]) expect(cols.has(col)).toBe(true);

    // v2 表已建
    for (const t of ["spills", "entities", "decision_entities", "metrics", "schema_version"]) {
      const row = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      expect(row, `table ${t}`).toBeTruthy();
    }
    const ver = store.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(ver.v).toBe(2);

    // 迁移后新事件可带 v2 字段
    const e = store.append(
      { session_id: "s-old", kind: "user_message", ts: "2026-08-13T00:00:01.000Z", body: "new" },
      { projectKey: "proj-a", origin: "dsh://session/event#1" },
    );
    expect(e.project_key).toBe("proj-a");
    expect(e.origin).toBe("dsh://session/event#1");

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
