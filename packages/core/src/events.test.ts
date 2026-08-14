import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventKindCounts } from "./events.js";

function openEventsDb(prefix: string): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = new Database(join(dir, "events.db"));
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ts TEXT NOT NULL,
    seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    meta TEXT,
    truncated INTEGER NOT NULL DEFAULT 0
  );`);
  return { db, dir };
}

describe("eventKindCounts", () => {
  it("counts events grouped by kind", () => {
    const { db, dir } = openEventsDb("thread-events-");
    const insert = db.prepare(
      `INSERT INTO events (session_id, kind, ts, seq, body) VALUES (?, ?, ?, ?, ?)`,
    );
    const rows: Array<[string, string, string, number, string]> = [
      ["s1", "user_message", "2026-08-13T00:00:00.000Z", 1, "hello"],
      ["s1", "tool_call", "2026-08-13T00:00:01.000Z", 2, "edit a.ts"],
      ["s1", "tool_result", "2026-08-13T00:00:02.000Z", 3, "ok"],
      ["s2", "user_message", "2026-08-13T00:00:03.000Z", 1, "hi"],
      ["s2", "user_message", "2026-08-13T00:00:04.000Z", 2, "again"],
    ];
    for (const row of rows) insert.run(...row);

    expect(eventKindCounts(db)).toEqual({ user_message: 3, tool_call: 1, tool_result: 1 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty object for an empty table", () => {
    const { db, dir } = openEventsDb("thread-events-empty-");

    expect(eventKindCounts(db)).toEqual({});
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
