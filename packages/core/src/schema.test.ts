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
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(6);
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
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(6);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("v4 FTS 表（body 单字）→ v5 重建为 body_seg 并回填（0-e 中文检索升级）", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-migrate-fts-"));
    const dbPath = join(dir, "events.db");
    const db = new Database(dbPath);
    // 模拟 v4 库：events + 旧结构 FTS（body 列 unicode61）
    db.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      meta TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      project_key TEXT,
      scope TEXT NOT NULL DEFAULT 'project',
      origin TEXT,
      spilled INTEGER NOT NULL DEFAULT 0,
      isolation INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO events (session_id, kind, ts, seq, body) VALUES
      ('s1', 'user_message', '2026-08-18T00:00:00.000Z', 1, '登录方案改成JWT'),
      ('s1', 'tool_call', '2026-08-18T00:00:01.000Z', 2, 'pwsh 大块工具输出不建索引');
    CREATE VIRTUAL TABLE events_fts USING fts5(body, content='events', content_rowid='id', tokenize='unicode61');
    INSERT INTO events_fts(rowid, body) VALUES (1, '登 录 方 案 改 成 jwt');`);

    ensureSchema(db, "events");

    // 重建后：body_seg 列存在，indexable 行已分词回填，tool_call 不建索引
    // contentless 表不能 SELECT 列值，用 MATCH 验证索引内容
    const ftsCols = new Set(
      (db.prepare("PRAGMA table_info(events_fts)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(ftsCols.has("body_seg")).toBe(true);
    const hit = db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").get("登录") as { rowid: number } | undefined;
    expect(hit?.rowid).toBe(1);
    const toolHit = db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").get("pwsh") as { rowid: number } | undefined;
    expect(toolHit).toBeUndefined();
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(6);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("v5 FTS 表（无 events_fts_tri）→ v6 重建主表 + 建 trigram 兜底表并回填", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-migrate-fts6-"));
    const dbPath = join(dir, "events.db");
    const db = new Database(dbPath);
    // 模拟 v5 库：events + body_seg FTS（无 events_fts_tri 兜底表）
    db.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      meta TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      project_key TEXT,
      scope TEXT NOT NULL DEFAULT 'project',
      origin TEXT,
      spilled INTEGER NOT NULL DEFAULT 0,
      isolation INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO events (session_id, kind, ts, seq, body) VALUES
      ('s1', 'user_message', '2026-08-18T00:00:00.000Z', 1, '模型选定 deepseek-v4-flash 作为主力'),
      ('s1', 'tool_call', '2026-08-18T00:00:01.000Z', 2, 'pwsh 工具输出不建索引');
    CREATE VIRTUAL TABLE events_fts USING fts5(body_seg, content='', tokenize='unicode61');
    INSERT INTO events_fts(rowid, body_seg) VALUES (1, '模型 选定 deepseek v4 flash 作为 主力');`);

    ensureSchema(db, "events");

    // 重建后：主表 body_seg 保留 + 兜底表 events_fts_tri 存在且回填——
    // 子串「eepseek」可经 trigram 兜底表短语命中
    const triExists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_fts_tri'`)
      .get() !== undefined;
    expect(triExists).toBe(true);
    const sub = db
      .prepare(`SELECT rowid FROM events_fts_tri WHERE events_fts_tri MATCH '"eepseek"'`)
      .get() as { rowid: number } | undefined;
    expect(sub?.rowid).toBe(1);
    // 主路径表无「eepseek」token（词级）
    const seg = db
      .prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH '"eepseek"'`)
      .get() as { rowid: number } | undefined;
    expect(seg).toBeUndefined();
    // tool_call 不建索引
    const toolHit = db
      .prepare(`SELECT rowid FROM events_fts_tri WHERE events_fts_tri MATCH '"pwsh"'`)
      .get() as { rowid: number } | undefined;
    expect(toolHit).toBeUndefined();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
