import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSchema } from "./schema.js";

describe("schema v2 migration (B④ 双库)", () => {
  it("migrates a v1 events db (adds columns/tables)", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-migrate-events-"));
    const dbPath = join(dir, "events.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      meta TEXT,
      truncated INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO events (session_id, kind, ts, seq, body) VALUES ('s-old', 'user_message', '2026-08-13T00:00:00.000Z', 1, 'legacy data');`);

    ensureSchema(db, "events");

    const count = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    expect(count.c).toBe(1);
    const cols = new Set(
      (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ["project_key", "scope", "origin", "spilled", "isolation"]) expect(cols.has(col)).toBe(true);
    for (const t of ["spills", "schema_version"]) {
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t), `table ${t}`).toBeTruthy();
    }
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(4);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a v1 structured db (adds columns/tables)", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-migrate-structured-"));
    const dbPath = join(dir, "structured.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE goals (
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

    ensureSchema(db, "structured");

    for (const t of ["goals", "decisions", "feedback"] as const) {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const col of ["project_key", "scope", "origin", "isolation"]) expect(cols.has(col), `${t}.${col}`).toBe(true);
    }
    for (const t of ["entities", "decision_entities", "metrics", "session_isolation", "pending_candidates", "schema_version"]) {
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t), `table ${t}`).toBeTruthy();
    }
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(4);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
