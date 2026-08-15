import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

export type SchemaKind = "events" | "structured";

// 双库（B④）：事件库（events/episodes/spills/lineage_edges 事件域）与结构化库
// （goals/decisions/feedback/entities/decision_entities/metrics/lineage_edges 结构化域）
// 各库独立 schema_version 表、独立迁移链，共用 SCHEMA_VERSION。
// 迁移只负责：旧库按需补 v2 列/表，幂等（列存在则跳过），最后写 schema_version。

export function ensureSchema(db: Database.Database, kind: SchemaKind): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const row = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`).get() as { v: number };
  if (row.v >= SCHEMA_VERSION) return;

  db.transaction(() => {
    const cols = (t: string): Set<string> =>
      new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));

    if (kind === "events") {
      const eventsCols = cols("events");
      if (!eventsCols.has("project_key")) db.exec(`ALTER TABLE events ADD COLUMN project_key TEXT`);
      if (!eventsCols.has("scope")) db.exec(`ALTER TABLE events ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
      if (!eventsCols.has("origin")) db.exec(`ALTER TABLE events ADD COLUMN origin TEXT`);
      if (!eventsCols.has("spilled")) db.exec(`ALTER TABLE events ADD COLUMN spilled INTEGER NOT NULL DEFAULT 0`);
      if (!eventsCols.has("isolation")) db.exec(`ALTER TABLE events ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_key, ts)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_origin ON events(origin) WHERE origin IS NOT NULL`);

      db.exec(`CREATE TABLE IF NOT EXISTS spills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id),
        ref TEXT NOT NULL,
        blob TEXT,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`);
    } else {
      for (const t of ["goals", "decisions"] as const) {
        const c = cols(t);
        if (!c.has("project_key")) db.exec(`ALTER TABLE ${t} ADD COLUMN project_key TEXT`);
        if (!c.has("scope")) db.exec(`ALTER TABLE ${t} ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
        if (!c.has("origin")) db.exec(`ALTER TABLE ${t} ADD COLUMN origin TEXT`);
        if (!c.has("isolation")) db.exec(`ALTER TABLE ${t} ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_project ON ${t}(project_key, status)`);
      }
      {
        const c = cols("feedback");
        if (!c.has("project_key")) db.exec(`ALTER TABLE feedback ADD COLUMN project_key TEXT`);
        if (!c.has("scope")) db.exec(`ALTER TABLE feedback ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
        if (!c.has("origin")) db.exec(`ALTER TABLE feedback ADD COLUMN origin TEXT`);
        if (!c.has("isolation")) db.exec(`ALTER TABLE feedback ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_key, kind)`);
      }

      db.exec(`CREATE TABLE IF NOT EXISTS session_isolation (
        session_id TEXT PRIMARY KEY,
        isolated INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL
      );`);
      db.exec(`CREATE TABLE IF NOT EXISTS decision_entities (
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        edge TEXT NOT NULL DEFAULT 'references',
        ts TEXT NOT NULL,
        PRIMARY KEY (decision_id, entity_id)
      );`);
      db.exec(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        ts TEXT NOT NULL
      );`);
    }

    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  })();
}
